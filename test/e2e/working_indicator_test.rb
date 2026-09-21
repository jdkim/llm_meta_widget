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

  input = d.find_element(css: ".lmw-input")
  input.send_keys("In one sentence, what is this page for?")
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

  results[:active_dots_after]  = dots.()
  results[:role_label_after]   = d.execute_script("return Array.from(document.querySelectorAll('.message.assistant .message-role')).map(function(e){return e.innerText})").last
  results[:console_errors]     = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }.map(&:message)
  d.save_screenshot(File.join(OUT, "working_indicator.png"))
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
