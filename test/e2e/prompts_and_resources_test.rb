# Drives the MCP prompts + resources spike in a real browser against the local
# PubDictionaries dev server (port 3002 — Chrome refuses 6000) and the real dev
# hub. Two claims are checked from evidence the widget cannot fake:
#   1. prompts/list reaches the UI — a button exists for the server's template.
#   2. resources/read reaches the MODEL — the hub request body carries the
#      dictionary catalog, read from the intercepted fetch, not from the chat.
require "selenium-webdriver"
require "fileutils"
require "json"

PAGE = ENV.fetch("PD_URL", "https://test2.pubannotation.org/text_annotation")
OUT  = File.expand_path(__dir__)
profile = File.join(OUT, "profile-#{Process.pid}")   # snap Chromium cannot write /tmp
FileUtils.mkdir_p(profile)
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1000 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }

# Capture every outgoing request body so the system prompt can be inspected
# directly. Installed before the first submit, so the first turn is captured.
INTERCEPT = <<~JS
  window.__bodies = [];
  (function () {
    var orig = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === "string") ? input : (input && input.url);
        if (init && init.body) window.__bodies.push({ url: String(url), body: String(init.body) });
      } catch (e) { /* never break the page for instrumentation */ }
      return orig.apply(this, arguments);
    };
  })();
JS

results = {}
begin
  d.navigate.to PAGE
  wait.(30) { d.execute_script("return !!window.aiState && !!window.aiActions") }
  d.execute_script(INTERCEPT)

  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(30) { d.find_element(css: ".lmw-input").displayed? }

  # 1. prompts/list → button affordance
  begin
    wait.(30) { d.execute_script("return document.querySelectorAll('.lmw-prompt').length > 0") }
    btn = d.find_element(css: ".lmw-prompt")
    results[:prompt_button] = {
      label:   btn.text,
      title:   btn.attribute("title"),
      visible: btn.displayed?,
      row_display: d.execute_script("return getComputedStyle(document.querySelector('.lmw-prompts')).display")
    }
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:prompt_button] = "FAIL — no .lmw-prompt rendered"
    results[:prompts_html]  = d.execute_script("return (document.querySelector('.lmw-prompts')||{}).outerHTML")
  end

  # With the page empty, the template must name the empty field rather than
  # relaying the server's -32602 for something fixable on screen.
  if results[:prompt_button].is_a?(Hash)
    d.execute_script("$('#text').val('');")
    d.find_element(css: ".lmw-prompt").click
    sleep 2
    msg = d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''")
    results[:empty_page_guard] = msg.include?("nothing to use for") ? "PASS — #{msg[/nothing to use for[^\n]*/]}" : "FAIL — #{msg[0, 200]}"
    d.find_element(css: ".lmw-clear").click
  end

  # The template's required arguments come from the page, so give the page
  # something to work with: a sentence and one really-existing dictionary.
  first_dic = d.execute_script(<<~JS)
    var el = document.querySelector("#unselected_dictionaries > .dictionary, #selected_dictionaries > .dictionary");
    return el ? el.getAttribute("name") : null;
  JS
  results[:dictionary_used] = first_dic
  d.execute_script("$('#text').val('The stomach and the liver were examined.');")
  d.execute_script("window.aiActions.add_dictionaries({names: [arguments[0]]});", first_dic) if first_dic
  results[:page_state] = d.execute_script("return JSON.stringify({text: window.aiState.text(), dics: window.aiState.selected_dictionaries()})")

  # 2. Clicking the template must fill the box AND travel the normal send path.
  if results[:prompt_button].is_a?(Hash)
    d.find_element(css: ".lmw-prompt").click
    begin
      wait.(60) { d.execute_script("return (window.__bodies || []).some(function(b){ return b.url.indexOf('/api/') >= 0 || b.body.indexOf('\"messages\"') >= 0; })") }
      results[:submitted] = "PASS"
    rescue Selenium::WebDriver::Error::TimeoutError
      results[:submitted] = "FAIL — no hub request after clicking the template"
    end
  end

  bodies = d.execute_script("return window.__bodies || []")
  hub = bodies.find { |b| b["body"].to_s.include?('"messages"') }
  if hub
    parsed = (JSON.parse(hub["body"]) rescue nil)
    msgs = parsed && (parsed["messages"] || parsed.dig("chat", "messages"))
    system_msg = msgs&.find { _1["role"] == "system" }&.fetch("content", "").to_s
    user_msg   = msgs&.find { _1["role"] == "user" }&.fetch("content", "").to_s
    results[:hub_request] = {
      url:                hub["url"],
      system_bytes:       system_msg.bytesize,
      has_catalog_uri:    system_msg.include?("pubdictionaries://dictionaries"),
      has_dictionary_row: first_dic ? system_msg.include?(first_dic) : nil,
      user_from_template: user_msg.include?("stomach"),
      user_preview:       user_msg[0, 300]
    }
  else
    results[:hub_request] = "FAIL — no request body containing messages; captured #{bodies.length}"
    results[:captured_urls] = bodies.map { _1["url"] }
  end

  # 3. The catalog is first-turn-only: a second turn must not pay for it again.
  sleep 20
  before = d.execute_script("return (window.__bodies || []).length")
  input = d.find_element(css: ".lmw-input")
  input.clear; input.send_keys("Thanks, that is all.")
  d.find_element(css: ".lmw-send").click
  begin
    wait.(60) { d.execute_script("return (window.__bodies || []).length > arguments[0]", before) }
    second = d.execute_script("return (window.__bodies || []).slice(arguments[0])", before)
                .find { _1["body"].to_s.include?('"messages"') }
    sys2 = if second
      parsed2 = (JSON.parse(second["body"]) rescue nil)
      m2 = parsed2 && (parsed2["messages"] || parsed2.dig("chat", "messages"))
      m2&.find { _1["role"] == "system" }&.fetch("content", "").to_s
    end
    results[:second_turn] = sys2 ? {
      system_bytes:    sys2.bytesize,
      has_catalog_uri: sys2.include?("pubdictionaries://dictionaries")
    } : "FAIL — no second hub request captured"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:second_turn] = "FAIL — second turn never reached the hub"
  end

  # 4. Clear starts a NEW conversation, so a 'once' resource is owed to it
  #    again. The old latched boolean withheld it silently.
  sleep 10
  before_clear = d.execute_script("return (window.__bodies || []).length")
  d.find_element(css: ".lmw-clear").click
  input = d.find_element(css: ".lmw-input")
  input.clear; input.send_keys("Fresh start.")
  d.find_element(css: ".lmw-send").click
  begin
    wait.(60) { d.execute_script("return (window.__bodies || []).length > arguments[0]", before_clear) }
    after = d.execute_script("return (window.__bodies || []).slice(arguments[0])", before_clear)
              .find { _1["body"].to_s.include?('"messages"') }
    sys3 = if after
      parsed3 = (JSON.parse(after["body"]) rescue nil)
      m3 = parsed3 && (parsed3["messages"] || parsed3.dig("chat", "messages"))
      m3&.find { _1["role"] == "system" }&.fetch("content", "").to_s
    end
    results[:after_clear] = sys3 ? {
      system_bytes:    sys3.bytesize,
      has_catalog_uri: sys3.include?("pubdictionaries://dictionaries")
    } : "FAIL — no request captured after Clear"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:after_clear] = "FAIL — nothing reached the hub after Clear"
  end

  sleep 10 # let the model answer so the screenshot shows a real turn
  results[:transcript] = d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''")[0, 1500]
  d.save_screenshot(File.join(OUT, "widget_prompts.png"))
  results[:console_errors] = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }.map(&:message)
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
