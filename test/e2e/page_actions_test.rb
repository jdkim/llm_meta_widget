# Drives the real llm_meta_widget on PubDictionaries' text_annotation page, in
# a real browser, against the real dev hub and the real model. Success is read
# from the page's own state (window.aiState), not from what the chat says.
require "selenium-webdriver"
require "fileutils"
require "json"

PAGE = ENV.fetch("PD_URL", "https://test2.pubannotation.org/text_annotation")
OUT = File.expand_path(__dir__)
profile = File.join(OUT, "profile-#{Process.pid}")   # snap Chromium cannot write /tmp
FileUtils.mkdir_p(profile)
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1000 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }
state = -> { d.execute_script("return JSON.stringify(window.aiState ? window.aiState.selected_dictionaries() : null)") }
msgs  = -> { d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''") }

def ask(d, text)
  input = d.find_element(css: ".lmw-input")
  input.clear; input.send_keys(text)
  input.send_keys(:enter)
end

# On a long host page a widget control can sit below the fold or under an
# overlapping page element, and Selenium then refuses the click on geometry
# grounds. These tests are about the handler, not about hit-testing — the
# control's visibility is asserted separately — so dispatch the click
# directly rather than steering a mouse to it.
def click_safely(driver, selector)
  el = driver.find_element(css: selector)
  driver.execute_script("arguments[0].scrollIntoView({block: 'center'}); arguments[0].click();", el)
end

results = {}
begin
  d.navigate.to PAGE
  wait.(30) { d.execute_script("return !!window.aiState && !!window.aiActions") }
  results[:initial_selected] = state.()

  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(30) { d.find_element(css: ".lmw-input").displayed? }
  sleep 3 # model/tool pickers populate from the hub
  results[:model_selected] = d.execute_script("const s=document.querySelector('.lmw-model-picker'); return s ? s.value : null")

  # 1. A page action (class 3): the model must call add_dictionaries and the
  #    widget must apply it to the real form.
  ask(d, "Add the uberon dictionary to the annotation form.")
  t0 = Time.now
  begin
    wait.(300) { JSON.parse(state.() || "[]").to_s.include?("uberon") }
    results[:action] = "PASS after #{(Time.now - t0).round}s"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:action] = "FAIL — selected dictionaries: #{state.()}"
  end
  results[:selected_after_action] = state.()
  sleep 5

  # 2. A host tool (class 2): the widget must call PubDictionaries' own /mcp
  #    directly and the model must answer from the result.
  before = msgs.().length
  ask(d, "What is the UBERON identifier for stomach? Look it up.")
  t0 = Time.now
  begin
    wait.(300) { msgs.()[before..].to_s.include?("0000945") }
    results[:lookup] = "PASS after #{(Time.now - t0).round}s"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:lookup] = "FAIL"
  end
  sleep 5
  results[:transcript] = msgs.()
  d.save_screenshot(File.join(OUT, "widget.png"))
  results[:console_errors] = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }.map(&:message)
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
