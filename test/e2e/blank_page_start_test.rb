# What a first-time visitor sees, and what happens when they use it.
# The panel must open with a greeting and the offers themselves, and the
# template must work from a BLANK page — the case the first implementation
# refused, on the grounds that the user had not filled the form yet.
require "selenium-webdriver"
require "fileutils"
require "json"

PAGE = ENV.fetch("PD_URL", "https://test2.pubannotation.org/text_annotation")
OUT  = File.expand_path(__dir__)
profile = File.join(OUT, "profile-#{Process.pid}")   # never under a dotted dir: snap Chromium cannot read those
FileUtils.mkdir_p(profile)
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1400 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }
msgs  = -> { d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''") }
state = -> { d.execute_script("return JSON.stringify({text: window.aiState.text(), dics: window.aiState.selected_dictionaries()})") }

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
  d.execute_script("$('#text').val('');")   # a genuinely blank page
  d.execute_script(INTERCEPT)

  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(30) { d.find_element(css: ".lmw-input").displayed? }

  # 1. The opening state: greeting + the offer, not an empty box.
  wait.(30) { d.execute_script("return !!document.querySelector('.lmw-welcome-start')") }
  results[:greeting]    = d.execute_script("return (document.querySelector('.lmw-welcome-hello')||{}).innerText || ''")[0, 120]
  results[:offer]       = d.execute_script("return (document.querySelector('.lmw-welcome-start')||{}).innerText || ''")
  results[:slots]       = d.execute_script("return Array.from(document.querySelectorAll('.lmw-welcome-slots li')).map(function(li){return li.innerText})")
  results[:state_before] = state.()

  # 2. Clicking it on a blank page must start a conversation, not refuse.
  el = d.find_element(css: ".lmw-welcome-start")
  d.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
  wait.(180) { msgs.().length > 80 }
  sleep 20
  results[:refused]   = msgs.().include?("nothing to use for")
  results[:asked_for_text] = msgs.()[0, 700]

  # The turn is labelled by what the user did. The server's instruction
  # paragraph stays one click away inside a <details>, so it must not appear
  # in the transcript text as though they had typed it.
  transcript = msgs.()
  results[:turn_labelled]      = transcript.include?("Annotate text")
  results[:instruction_hidden] = !transcript.include?("Ask me for the text I want to annotate")

  # 3. Give it the text it asked for; it must choose dictionaries and fill the form.
  input = d.find_element(css: ".lmw-input")
  input.send_keys("Annotate this: I have a stomach ache and a fever.")
  input.send_keys(:enter)
  begin
    wait.(300) { (JSON.parse(state.())["dics"] || []).any? }
    results[:dictionaries_chosen] = JSON.parse(state.())["dics"]
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:dictionaries_chosen] = "FAIL — no dictionaries were selected"
  end

  # BOTH halves of the form, not just the one that is easy to check. Leaving
  # the text box empty means the visitor cannot re-run the annotation by hand,
  # which is the whole point of filling the form they did not understand.
  begin
    wait.(240) { JSON.parse(state.())["text"].to_s.include?("stomach") }
    results[:text_filled] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:text_filled] = "FAIL — the page's text box was left empty: #{state.()}"
  end

  # Filling the form is not the task; annotating is. Read that from the
  # traffic rather than the wording, and allow for a dictionary that simply
  # contains no matching term — running the annotation is the outcome, what
  # it finds is the data's business.
  # Must be an actual JSON-RPC call to the host's MCP endpoint. Searching the
  # captured bodies for the tool's NAME matched the hub request that merely
  # DECLARES the tool — a false pass that reported success while the model
  # had done nothing.
  called = ->(tool) {
    d.execute_script(<<~JS)
      return (window.__bodies || []).some(function (b) {
        return b.url.indexOf("/mcp") >= 0 &&
               b.body.indexOf('"tools/call"') >= 0 &&
               b.body.indexOf('"#{tool}"') >= 0;
      });
    JS
  }
  begin
    wait.(300) { called.("text_annotation") }
    results[:annotation_run] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:annotation_run] = "FAIL — the assistant never ran the annotation"
  end

  # Running the tool is not the end of the task either: the user needs to be
  # told what came back. Tool chips are appended after a turn's prose, so
  # "the last line is prose" can never hold — measure that the transcript
  # GREW after the annotation instead.
  before_answer = msgs.().length
  begin
    wait.(240) { msgs.().length > before_answer + 80 }
    results[:reported_result] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:reported_result] = "FAIL — annotated, then said nothing about it"
  end
  results[:ran_out_of_rounds] = msgs.().include?("tool-use limit")
  results[:transcript_tail] = msgs.()[-800..] || msgs.()
  d.save_screenshot(File.join(OUT, "blank_page_start.png"))
  results[:console_errors] = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }.map(&:message)
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
