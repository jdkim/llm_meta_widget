# Checks the sizeBytes / attachmentHint gate end to end, against whatever the
# local PubDictionaries currently advertises. Unit tests cover the decision
# functions; this covers the WIRING — that the panel actually consults them
# before attaching, which a pure-function test cannot see.
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
  sleep 4 # let boot-time discovery finish

  # Did the resource's bytes cross the wire at all? A skipped resource must
  # never be fetched — that is the whole point of a pre-flight size.
  results[:resource_read_attempted] =
    d.execute_script("return (window.__bodies || []).some(function(b){ return b.body.indexOf('resources/read') >= 0; })")

  input = d.find_element(css: ".lmw-input")
  input.clear; input.send_keys("Hello.")
  d.find_element(css: ".lmw-send").click
  begin
    wait.(60) { d.execute_script("return (window.__bodies || []).some(function(b){ return b.body.indexOf('\"messages\"') >= 0; })") }
    hub = d.execute_script("return (window.__bodies || []).filter(function(b){ return b.body.indexOf('\"messages\"') >= 0; })[0]")
    parsed = (JSON.parse(hub["body"]) rescue nil)
    msgs = parsed && (parsed["messages"] || parsed.dig("chat", "messages"))
    system_msg = msgs&.find { _1["role"] == "system" }&.fetch("content", "").to_s
    results[:system_bytes]    = system_msg.bytesize
    results[:has_catalog_uri] = system_msg.include?("pubdictionaries://dictionaries")
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:hub_request] = "FAIL — nothing reached the hub"
  end

  logs = (d.logs.get(:browser) rescue [])
  results[:skip_log]       = logs.map(&:message).select { _1.include?("not attaching") }
  results[:console_errors] = logs.select { _1.level == "SEVERE" }.map(&:message)
ensure
  d.quit
  FileUtils.rm_rf(profile)
end
puts JSON.pretty_generate(results)
