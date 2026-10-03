# The widget on a host with no Rails at all.
#
# Every other e2e test drives a Rails page: PubDictionaries renders the partial,
# or ollama_only renders it through ActionView. This one writes the HTML by hand
# and serves the bundled custom element as a static file, which is the whole
# claim of the custom-element move — that a Python, Go or static host gets the
# same widget from two lines of markup.
#
# It also covers the element's own guard paths, which nothing else does: a
# second <llm-meta-widget> on the page, and one missing its required attributes.
#
#   HUB=https://llmbranch.dbcls.jp MODEL=qwen3-8-27b-fast bundle exec ruby test/e2e/plain_host_test.rb
#
# The host origin must be on the hub's CORS allowlist or the turn cannot run;
# the hub serves 127.0.0.1 loopback ports for exactly this.
require "selenium-webdriver"
require "fileutils"
require "socket"
require "json"

HUB   = ENV.fetch("HUB", "https://llmbranch.dbcls.jp")
MODEL = ENV.fetch("MODEL", "qwen3-8-27b-fast")
PORT  = ENV.fetch("PORT", "3002").to_i      # a port the hub allowlists
ROOT  = File.expand_path("../..", __dir__)
OUT   = File.expand_path(__dir__)

BUNDLE = File.join(ROOT, "app/assets/javascripts/llm_meta_widget/llm-meta-widget.js")
abort "SKIPPED — no bundle at #{BUNDLE}. Run `npm run build`." unless File.file?(BUNDLE)

serve_dir = File.join(OUT, "plain-host-#{Process.pid}")
FileUtils.mkdir_p File.join(serve_dir, "llm_meta_widget_assets")
FileUtils.cp BUNDLE, File.join(serve_dir, "llm_meta_widget_assets", "llm-meta-widget.js")
# An empty manifest rather than none: the element auto-discovers same-origin
# when well-known-urls is omitted, and a 404 would be noise this test asserts on.
FileUtils.mkdir_p File.join(serve_dir, ".well-known")
File.write File.join(serve_dir, ".well-known/mcp.json"), JSON.dump(servers: [])

# Hand-written HTML. No gem, no helper, no template engine — the point of the test.
File.write File.join(serve_dir, "index.html"), <<~HTML
  <!doctype html><html><head><meta charset="utf-8"><title>Plain host</title></head>
  <body><h1>Plain host</h1>
  <p id="probe">A plain page with no Rails anywhere.</p>
  <script type="application/json" id="ai-actions">
  [{"name":"highlight_probe","description":"Highlight the probe paragraph.",
    "input_schema":{"type":"object","properties":{},"required":[]}}]
  </script>
  <script>
    window.aiState   = { probe_text: function(){ return document.getElementById("probe").textContent; } };
    window.aiActions = { highlight_probe: function(){ document.getElementById("probe").dataset.hit = "yes"; } };
  </script>
  <script type="module" src="/llm_meta_widget_assets/llm-meta-widget.js"></script>
  <llm-meta-widget llm-url="#{HUB}" tool-hub-url="#{HUB}" model="#{MODEL}"
                   max-rounds="6" greeting="Two lines of HTML, no Rails."></llm-meta-widget>
  <!-- a second one must be ignored, not fight the first over fixed element ids -->
  <llm-meta-widget llm-url="#{HUB}" model="#{MODEL}"></llm-meta-widget>
  <!-- and one with neither required attribute must refuse to start -->
  <llm-meta-widget></llm-meta-widget>
  </body></html>
HTML

# ---- serve it ------------------------------------------------------------
TYPES = { ".html" => "text/html", ".js" => "text/javascript",
          ".css" => "text/css", ".json" => "application/json" }.freeze
server = TCPServer.new("127.0.0.1", PORT)
serving = Thread.new do
  loop do
    socket = server.accept
    Thread.new(socket) do |s|
      request = s.gets.to_s
      path = request[/GET (\S+)/, 1].to_s.split("?").first.to_s
      path = "/index.html" if path == "/"
      file = File.expand_path(File.join(serve_dir, path))
      s.gets while s.ready?
      if file.start_with?(serve_dir) && File.file?(file)
        body = File.binread(file)
        s.print "HTTP/1.1 200 OK\r\nContent-Type: #{TYPES.fetch(File.extname(file), 'text/plain')}\r\n" \
                "Content-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n"
        s.print body
      else
        s.print "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      end
      s.close rescue nil
    end
  end
end

profile = File.join(OUT, "plainprof-#{Process.pid}")
FileUtils.mkdir_p profile
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1400,1100 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }
msgs = -> { d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''") }
bubbles = -> { d.execute_script("return document.querySelectorAll('.lmw-messages .message').length") }

r = {}
begin
  d.navigate.to "http://127.0.0.1:#{PORT}/"
  wait.(30) { d.execute_script("return !!document.getElementById('llm-meta-widget-chat')") }

  r[:upgraded] = d.execute_script(<<~JS)
    const els = document.querySelectorAll("llm-meta-widget");
    return { defined: !!customElements.get("llm-meta-widget"),
             elements_on_page: els.length,
             built_inside_first: !!els[0].querySelector("#llm-meta-widget-chat"),
             panels_total: document.querySelectorAll("#llm-meta-widget-chat").length };
  JS

  # the bundle carries its own styles; the host links no stylesheet
  r[:styles] = d.execute_script(<<~JS)
    return { injected: !!document.querySelector('style[data-llm-meta-widget="styles"]'),
             style_tags: document.querySelectorAll('style[data-llm-meta-widget="styles"]').length,
             host_stylesheets: document.querySelectorAll("link[rel=stylesheet]").length,
             toggle_position: getComputedStyle(document.getElementById("llm-meta-widget-toggle")).position };
  JS

  d.execute_script("document.getElementById('llm-meta-widget-toggle').click()")
  wait.(20) { d.find_element(css: ".lmw-input").displayed? }
  sleep 5

  r[:config] = d.execute_script(<<~JS)
    const root = document.getElementById("llm-meta-widget-chat");
    return { greeting: (root.querySelector(".lmw-messages")||{}).innerText.includes("no Rails"),
             model_picker: !!root.querySelector(".lmw-model-picker"),
             tools_picker: !!root.querySelector(".lmw-tools-picker") };
  JS

  # a real streamed turn, answered from the host page's own aiState reader
  before = bubbles.()
  input = d.find_element(css: ".lmw-input")
  input.click
  input.send_keys("In one short sentence: what does the probe paragraph say?")
  input.send_keys(:enter)
  wait.(300) { bubbles.() >= before + 2 && msgs.().length > 80 }
  sleep 6
  text = msgs.()
  r[:turn] = { replied: text.length > 80, used_page_state: text.downcase.include?("rails") }
  r[:tail] = text[-160..] || text

  # the guards: the extra elements must have declined, with a message each
  logs = d.logs.get(:browser).map(&:message)
  r[:guards] = {
    second_instance_warned: logs.any? { |m| m =~ /already on this page/i },
    missing_attrs_errored:  logs.any? { |m| m =~ /llm-url and model are both required/i },
  }
  r[:console_errors] = logs.reject { |m| m =~ /favicon|already on this page|both required/i }
ensure
  r.each { |k, v| puts "#{k}: #{v.is_a?(String) ? v : JSON.generate(v)}" }
  d.quit rescue nil
  serving&.kill
  server&.close rescue nil
  FileUtils.rm_rf profile
  FileUtils.rm_rf serve_dir
end
