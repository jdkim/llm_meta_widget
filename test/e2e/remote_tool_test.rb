# Real anonymous hub → MCP proxy → next LLM turn, with browser CORS enabled.
require "selenium-webdriver"
require "action_view"
require "socket"
require "fileutils"
require "json"
require_relative "remote_tool_wire"

HUB_URL = ENV.fetch("HUB_URL", "http://localhost:3000")
MODEL = ENV.fetch("MODEL", "glm-4-7-flash")
ROOT = File.expand_path("../..", __dir__)
OUT = File.expand_path(ENV.fetch("E2E_OUTPUT_DIR", "../../tmp/remote-tool-e2e"), __dir__)
FileUtils.mkdir_p OUT

# ---- build the page ------------------------------------------------------
$LOAD_PATH.unshift File.join(ROOT, "app/helpers")
require "llm_meta_widget/widget_helper"

class Renderer < ActionView::Base
  include LlmMetaWidget::WidgetHelper
end

serve_dir = File.join(OUT, "remote-tool-demo-#{Process.pid}")
FileUtils.mkdir_p File.join(serve_dir, "llm_meta_widget_assets")
FileUtils.mkdir_p File.join(serve_dir, ".well-known")
%w[app/assets/javascripts/llm_meta_widget/orchestrator.js
   app/assets/javascripts/llm_meta_widget/marked.esm.js
   app/assets/stylesheets/llm_meta_widget/conversation.css].each do |asset|
  FileUtils.cp File.join(ROOT, asset), File.join(serve_dir, "llm_meta_widget_assets", File.basename(asset))
end
# An empty manifest rather than none: a 404 here is harmless but noisy, and
# the test asserts on console errors.
File.write File.join(serve_dir, ".well-known/mcp.json"), JSON.dump(servers: [])

view = Renderer.with_empty_template_cache.new(
  ActionView::LookupContext.new([ File.join(ROOT, "app/views") ]), {}, nil)
widget = view.llm_meta_widget(
  llm_url: HUB_URL, tool_hub_url: HUB_URL, model: MODEL,
  generation_settings: { options: { num_ctx: 65536, num_predict: 4096 } },
  models: [MODEL], hub_tools: ["TogoMCP"], well_known_urls: [],
  greeting: "Local hub / anonymous TogoMCP test.")

File.write File.join(serve_dir, "index.html"), <<~HTML
  <!doctype html><html><head><meta charset="utf-8"><title>Anonymous remote MCP E2E</title></head>
  <body><h1>Anonymous remote MCP E2E</h1>
  <script>
    window.wire = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(url, options = {}) {
      const entry = {url: String(url), method: options.method || "GET",
        headers: Object.fromEntries(new Headers(options.headers).entries()),
        body: options.body ? JSON.parse(options.body) : null};
      window.wire.push(entry);
      try {
        const response = await originalFetch(url, options);
        entry.status = response.status;
        response.clone().text().then(text => {
          entry.response = text;
          return originalFetch('/evidence', {method: 'POST', body: JSON.stringify(window.wire)});
        }).catch(error => console.error('Evidence capture failed', error));
        return response;
      } catch (error) { entry.error = String(error); throw error; }
    };
  </script>
  #{widget}
  </body></html>
HTML

# ---- serve it ------------------------------------------------------------
# A few static files over HTTP: the page needs a real origin for ES modules
# and CORS, and webrick is no longer stdlib.
TYPES = { ".html" => "text/html", ".js" => "text/javascript",
          ".css" => "text/css", ".json" => "application/json" }.freeze
server = TCPServer.new("127.0.0.1", Integer(ENV.fetch("WIDGET_PORT", "3001")))
port   = server.addr[1]
serving = Thread.new do
  loop do
    socket = server.accept
    Thread.new(socket) do |s|
      request = s.gets.to_s
      headers = {}
      while (line = s.gets) && line != "\r\n"
        key, value = line.split(":", 2)
        headers[key.downcase] = value.to_s.strip
      end
      if request.start_with?("POST /evidence ")
        body = s.read(headers.fetch("content-length", "0").to_i)
        File.write(File.join(OUT, "wire.json"), JSON.pretty_generate(JSON.parse(body)))
        s.print "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
        s.close
        next
      end
      path = request[/GET (\S+)/, 1].to_s.split("?").first.to_s
      path = "/index.html" if path == "/"
      file = File.expand_path(File.join(serve_dir, path))
      if file.start_with?(serve_dir + File::SEPARATOR) && File.file?(file)
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
rescue IOError, Errno::EBADF
  nil
end

if ENV["SERVE_ONLY"] == "1"
  puts "Widget ready: http://127.0.0.1:#{port}/index.html"
  $stdout.flush
  begin
    serving.join
  ensure
    server.close
    FileUtils.rm_rf serve_dir
  end
end

# Drive the real panel; fetch instrumentation observes without mocking.
ENV["SE_CACHE_PATH"] ||= File.join(OUT, "selenium-cache")
profile = File.join(serve_dir, "chrome-profile")
opts = Selenium::WebDriver::Chrome::Options.new
opts.add_argument("--user-data-dir=#{profile}")
%w[--headless=new --window-size=1200,1000].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = nil
results = {hub: HUB_URL, model: MODEL, checks: {}}

begin
  d = Selenium::WebDriver.for(:chrome, options: opts)
  wait = Selenium::WebDriver::Wait.new(timeout: Integer(ENV.fetch("E2E_TIMEOUT", "600")), interval: 0.5)
  d.navigate.to "http://127.0.0.1:#{port}/index.html"
  wait.until { d.find_elements(id: "llm-meta-widget-toggle").any? }
  d.find_element(id: "llm-meta-widget-toggle").click
  wait.until { d.find_elements(css: ".lmw-tools-item-child").any? }
  # Select only the guide through its real change handler.
  d.execute_script(<<~JS)
    const label = Array.from(document.querySelectorAll('.lmw-tools-item-child'))
      .find(e => e.textContent.trim() === 'TogoMCP_Usage_Guide');
    if (!label) throw new Error('Usage guide missing from anonymous catalog');
    label.querySelector('input').click();
  JS
  input = d.find_element(css: ".lmw-input")
  input.send_keys("Call TogoMCP_Usage_Guide once with empty arguments. Then summarize the returned guide in three short Japanese bullet points. Do not call any other tools.")
  input.send_keys(:enter)
  wait.until do
    d.execute_script("return window.wire.filter(e => e.url.includes('/single_llm_calls') && e.response !== undefined).length >= 2 || !!document.querySelector('.message.error')")
  end
  wire = d.execute_script("return window.wire")
  validate_remote_tool_wire(wire, results)
  wait.until { d.execute_script("return Array.from(document.querySelectorAll('.lmw-tool-chip')).some(e => e.textContent.includes('TogoMCP_Usage_Guide'))") }
  results[:console_errors] = d.logs.get(:browser).select { _1.level == 'SEVERE' }.map(&:message).reject { _1.include?('favicon.ico') }
  assert_check(results, :no_browser_errors, results[:console_errors].empty?)
rescue StandardError => e
  results[:error] = "#{e.class}: #{e.message}"
ensure
  if d
    File.write(File.join(OUT, 'wire.json'), JSON.pretty_generate(d.execute_script('return window.wire')))
    d.save_screenshot(File.join(OUT, 'remote_tool.png'))
    d.quit
  end
  serving.kill
  server.close
  FileUtils.rm_rf serve_dir
  File.write(File.join(OUT, 'summary.json'), JSON.pretty_generate(results))
end
puts JSON.pretty_generate(results)
exit(results[:error] ? 1 : 0)
