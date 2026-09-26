# The panel must say whether it is still working. Checked at three moments:
# during the wait, while reasoning streams, and after the turn ends — that
# last one matters most, since a spinner left running is a worse lie than no
# spinner at all.
require "selenium-webdriver"
require "fileutils"
require "json"

PAGE = ENV.fetch("PD_URL", "https://test2.pubannotation.org/text_annotation")
OUT  = File.expand_path(__dir__)
profile = File.join(OUT, "profile-#{Process.pid}")
FileUtils.mkdir_p(profile)
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1200 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 0.5).until(&blk) }
spinners = -> { d.execute_script("return document.querySelectorAll('.message-role.is-working .role-spinner').length") }
dots     = -> { d.execute_script("return document.querySelectorAll('.message-thinking.thinking-active .thinking-dots').length") }

results = {}
begin
  d.navigate.to PAGE
  wait.(30) { d.execute_script("return !!window.aiState") }
  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(30) { d.find_element(css: ".lmw-input").displayed? }

  # Reasoning only streams from a thinking model, and the page's default is
  # the `-fast` variant with think:false. A visitor reaches one the same way
  # the operator did — through the picker — so the test does too, rather than
  # editing the host's view.
  sleep 3   # picker populates from the hub
  # Name the model rather than guessing by suffix: the first option that is
  # not "-fast" was medgemma, which does not stream reasoning either, and the
  # run then reported "no reasoning block" — a non-observation dressed as a
  # result. THINKING_MODEL overrides it if the catalog changes.
  want = ENV.fetch("THINKING_MODEL", "qwen3-8-27b")
  results[:models_offered] = d.execute_script("var p=document.querySelector('.lmw-model-picker'); return p ? Array.from(p.options).map(function(o){return o.value}) : []")
  results[:model_used] = d.execute_script(<<~JS, want)
    // Bind the script argument BEFORE the callback: inside function(o){...}
    // `arguments[0]` is the option, not the value passed in from Ruby.
    var want = arguments[0];
    var picker = document.querySelector(".lmw-model-picker");
    if (!picker) return "no picker";
    var wanted = Array.from(picker.options).find(function (o) { return o.value === want; });
    if (!wanted) return "not offered: " + want;
    picker.value = wanted.value;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    return wanted.value;
  JS

  input = d.find_element(css: ".lmw-input")
  input.send_keys("Think it through, then answer in one sentence: what is this page for?")
  input.send_keys(:enter)

  # 1. It appears while the turn is in flight.
  begin
    wait.(60) { spinners.() > 0 }
    results[:spinner_while_working] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:spinner_while_working] = "FAIL — no working indicator during the turn"
  end

  # 2. The reasoning block animates while thinking streams (this model thinks).
  results[:thinking_dots_seen] = (dots.() > 0) ? "PASS" : "not observed (model may not have streamed reasoning)"

  # 3. It is gone once the answer is in.
  begin
    wait.(300) { spinners.() == 0 && d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText.length") > 120 }
    results[:cleared_after_answer] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:cleared_after_answer] = "FAIL — still claiming to work after the turn ended"
  end

  # Reasoning belongs above the answer it was reasoning towards, inside the
  # same bubble — the way llm_meta_chat places it. Appended to the transcript
  # instead, it landed after the response.
  results[:thinking_position] = d.execute_script(<<~JS)
    var msg = document.querySelector(".message.assistant");
    var think = msg && msg.querySelector(".message-thinking");
    var content = msg && msg.querySelector(".message-content");
    if (!think || !content) return "no reasoning block in this run";
    return (think.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING)
      ? "above the answer" : "BELOW the answer";
  JS

  results[:active_dots_after]  = dots.()
  results[:role_label_after]   = d.execute_script("return Array.from(document.querySelectorAll('.message.assistant .message-role')).map(function(e){return e.innerText})").last
  results[:console_errors]     = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }.map(&:message)
  d.save_screenshot(File.join(OUT, "working_indicator.png"))
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
