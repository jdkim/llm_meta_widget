# The smallest adoption there is: a page, this gem, and an Ollama. No
# llm_meta_server anywhere — not for the chat, not for tools. Everything the
# visitor types stays on their machine.
#
#   bundle exec ruby test/e2e/ollama_only_test.rb
#   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=qwen3:8b bundle exec ruby …
#
# Unlike the other browser tests this one needs no host app: it renders the
# partial itself and serves it, so it also proves the partial stands alone.
require "selenium-webdriver"
require "action_view"
require "socket"
require "fileutils"
require "json"

OLLAMA_URL   = ENV.fetch("OLLAMA_URL", "http://172.18.8.61:61435")
OLLAMA_MODEL = ENV.fetch("OLLAMA_MODEL", "qwen3.8:27b")
ROOT         = File.expand_path("../..", __dir__)
OUT          = File.expand_path(__dir__)

# Fail early and clearly rather than through a browser timeout.
begin
  require "net/http"
  tags = Net::HTTP.get_response(URI("#{OLLAMA_URL}/api/tags"))
  raise "HTTP #{tags.code}" unless tags.is_a?(Net::HTTPSuccess)
rescue StandardError => e
  abort "SKIPPED — no Ollama at #{OLLAMA_URL} (#{e.message}). Set OLLAMA_URL."
end

# ---- build the page ------------------------------------------------------
$LOAD_PATH.unshift File.join(ROOT, "app/helpers")
require "llm_meta_widget/widget_helper"

class Renderer < ActionView::Base
  include LlmMetaWidget::WidgetHelper
end

serve_dir = File.join(OUT, "ollama-demo-#{Process.pid}")
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
  llm_url:      OLLAMA_URL,
  llm_provider: :ollama,
  model:        OLLAMA_MODEL,
  greeting:     "Local-only assistant. Nothing leaves this machine.")

File.write File.join(serve_dir, "index.html"), <<~HTML
  <!doctype html><html><head><meta charset="utf-8"><title>Ollama-only widget</title></head>
  <body><h1>Direct Ollama demo</h1>
  <script type="application/json" id="ai-actions">
  [{"name":"highlight","description":"Highlight the page heading.",
    "input_schema":{"type":"object","properties":{},"required":[]}}]
  </script>
  <script>
    window.aiState   = { heading: function(){ return document.querySelector("h1").textContent; } };
    window.aiActions = { highlight: function(){ document.querySelector("h1").dataset.hit = "yes"; } };
  </script>
  #{widget}
  </body></html>
HTML

# ---- serve it ------------------------------------------------------------
# A few static files over HTTP: the page needs a real origin for ES modules
# and CORS, and webrick is no longer stdlib.
TYPES = { ".html" => "text/html", ".js" => "text/javascript",
          ".css" => "text/css", ".json" => "application/json" }.freeze
server = TCPServer.new("127.0.0.1", 0)
port   = server.addr[1]
serving = Thread.new do
  loop do
    socket = server.accept
    Thread.new(socket) do |s|
      request = s.gets.to_s
      path = request[/GET (\S+)/, 1].to_s.split("?").first.to_s
      path = "/index.html" if path == "/"
      file = File.expand_path(File.join(serve_dir, path))
      s.gets while s.ready?   # drain headers
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
rescue IOError, Errno::EBADF
  nil
end

# ---- drive it ------------------------------------------------------------
profile = File.join(OUT, "profile-ollama-#{Process.pid}")
FileUtils.mkdir_p profile
opts = Selenium::WebDriver::Chrome::Options.new
%W[--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage
   --window-size=1200,1000 --user-data-dir=#{profile}].each { opts.add_argument(_1) }
opts.add_option("goog:loggingPrefs", { browser: "ALL" })
d = Selenium::WebDriver.for(:chrome, options: opts)
wait = ->(secs, &blk) { Selenium::WebDriver::Wait.new(timeout: secs, interval: 1).until(&blk) }
msgs = -> { d.execute_script("return (document.querySelector('.lmw-messages')||{}).innerText || ''") }

results = { ollama: OLLAMA_URL, model: OLLAMA_MODEL }
begin
  d.navigate.to "http://127.0.0.1:#{port}/index.html"
  wait.(20) { d.execute_script("return !!document.querySelector('#llm-meta-widget-toggle')") }
  d.find_element(id: "llm-meta-widget-toggle").click
  wait.(20) { d.find_element(css: ".lmw-input").displayed? }
  sleep 4   # boot discovery + model list

  results[:greeting]      = d.execute_script("return (document.querySelector('.lmw-welcome-hello')||{}).innerText || ''")[0, 50]
  results[:models_listed] = d.execute_script("var p=document.querySelector('.lmw-model-picker'); return p ? Array.from(p.options).map(function(o){return o.value}) : []").first(3)
  # Class 1 needs a hub; without one the picker is not offered at all.
  results[:tool_picker]   = d.execute_script("var t=document.querySelector('.lmw-tools'); return t ? getComputedStyle(t).display : 'absent'")

  input = d.find_element(css: ".lmw-input")
  input.click
  input.send_keys("Highlight the heading, then tell me what it says.")
  input.send_keys(:enter)

  begin
    wait.(240) { d.execute_script("return document.querySelector('h1').dataset.hit === 'yes'") }
    results[:page_action] = "PASS"
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:page_action] = "FAIL — the page action never ran"
  end
  begin
    wait.(180) { d.execute_script("return document.querySelectorAll('.lmw-tool-chip').length") > 0 }
    results[:chips] = d.execute_script("return Array.from(document.querySelectorAll('.lmw-tool-chip')).map(function(c){return c.innerText})")
  rescue Selenium::WebDriver::Error::TimeoutError
    results[:chips] = "FAIL — no chip for a tool that ran"
  end
  sleep 15
  results[:reply] = msgs.()[-200..] || msgs.()
  # The favicon 404 is this test server's own noise; leaving it in would mask
  # a real error behind an expected one.
  results[:console_errors] = (d.logs.get(:browser) rescue [])
                               .select { _1.level == "SEVERE" }
                               .map(&:message)
                               .reject { _1.include?("favicon.ico") }
  d.save_screenshot(File.join(OUT, "ollama_only.png"))
ensure
  d.quit rescue nil
  serving.kill
  server.close rescue nil
  FileUtils.rm_rf profile
  FileUtils.rm_rf serve_dir
end
puts JSON.pretty_generate(results)
