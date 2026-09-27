# A page action that navigates — submitting a form, following a link — used to
# destroy the conversation, the record of what ran and the scroll position.
# That is why PubDictionaries had to stop declaring its submit action. This
# drives the navigation directly: same page, new query string, as a form
# submit would leave it.
require "selenium-webdriver"
require "fileutils"
require "json"

PAGE = ENV.fetch("PD_URL", "https://test2.pubannotation.org/text_annotation")
OUT  = File.expand_path(__dir__)
profile = File.join(OUT, "profile-#{Process.pid}")
FileUtils.mkdir_p(profile)
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1100 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }
msgs = -> { d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''") }
bubbles = -> { d.execute_script("return document.querySelectorAll('.lmw-messages .message').length") }

results = {}
begin
  d.navigate.to PAGE
  wait.(30) { d.execute_script("return !!window.aiState") }
  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(30) { d.find_element(css: ".lmw-input").displayed? }

  input = d.find_element(css: ".lmw-input")
  input.click
  input.send_keys("In one short sentence, what is this page for?")
  input.send_keys(:enter)
  wait.(240) { bubbles.() >= 2 && msgs.().length > 120 }
  sleep 12

  results[:before] = { bubbles: bubbles.(), text: msgs.()[-120..] }

  # Navigate as a form submit would: same path, different query.
  # A query the page ignores: passing ?text= without dictionaries makes the
  # annotation controller raise, and an error page has no widget to restore
  # into — which would test the error page, not the restore.
  d.navigate.to "#{PAGE}?navigated=1"
  wait.(30) { d.execute_script("return !!window.aiState") }
  sleep 3

  results[:panel_reopened] = d.execute_script("return !document.querySelector('#llm-meta-widget-chat').classList.contains('lmw-collapsed')")

  # A panel restored at boot is measured while the page is still laying out.
  # Positioning from that measurement anchored a sliver to the bottom edge —
  # and the size was then SAVED, so every later visit reopened wrong.
  results[:geometry] = d.execute_script(<<~JS)
    var r = document.querySelector("#llm-meta-widget-chat").getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height),
             top: Math.round(r.top), left: Math.round(r.left),
             withinViewport: r.top >= 0 && r.left >= 0 &&
                             r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
             storedSize: (function(){ try { return localStorage.getItem("llm_meta_widget:size"); } catch (e) { return "unreadable"; } })() };
  JS
  results[:after] = { bubbles: bubbles.(), text: msgs.()[-120..] }
  results[:transcript_survived] =
    results[:after][:bubbles] >= results[:before][:bubbles] ? "PASS" : "FAIL — transcript lost on navigation"

  # A restored transcript must also be a restored CONVERSATION: the model
  # should still have what was said before the navigation.
  input = d.find_element(css: ".lmw-input")
  input.click
  input.send_keys("What did I ask you just before this?")
  input.send_keys(:enter)
  before_reply = msgs.().length
  begin
    wait.(240) { msgs.().length > before_reply + 60 }
    sleep 10
    results[:context_kept] = msgs.()[-260..]
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:context_kept] = "FAIL — no reply after navigation"
  end

  # A different page is a different conversation.
  d.navigate.to PAGE.sub("/text_annotation", "/find_ids")
  sleep 3
  results[:other_page_bubbles] = (bubbles.() rescue "page has no widget")

  results[:console_errors] = (d.logs.get(:browser) rescue []).select { _1.level == "SEVERE" }
                               .map(&:message).reject { _1.include?("favicon") }.first(2)
ensure
  d.quit rescue nil
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
