# A static custom-element host. No Rails app or ERB renderer is needed.
require "socket"
require "fileutils"
require "json"
require "cgi"
require_relative "remote_tool_wire"

ROOT = File.expand_path("../..", __dir__)
OUT = File.expand_path(ENV.fetch("E2E_OUTPUT_DIR", "../../tmp/remote-tool-e2e"), __dir__)
MODEL = ENV.fetch("MODEL", "gpt-oss-120b")
MCP_SERVER = ENV.fetch("MCP_SERVER", "TogoMCP")
MCP_TOOL = ENV.fetch("MCP_TOOL", "TogoMCP_Usage_Guide")
MOCK = ENV["MOCK_HUB"] == "1"
FileUtils.mkdir_p(OUT)
FileUtils.rm_f(File.join(OUT, "wire.json"))
server = TCPServer.new("127.0.0.1", Integer(ENV.fetch("WIDGET_PORT", "0")))
origin = "http://127.0.0.1:#{server.addr[1]}"
hub = MOCK ? "#{origin}/hub" : ENV.fetch("HUB_URL", "http://localhost:3000")
prompt = "Call #{MCP_TOOL} once with empty arguments. Summarize its result in three short Japanese bullet points. Do not call other tools."

def reply(socket, body, type: "application/json", status: "200 OK")
  socket.write("HTTP/1.1 #{status}\r\nContent-Type: #{type}; charset=utf-8\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}")
end

# Observe the real requests. A clone leaves the stream consumed by the widget intact.
page = <<~HTML
  <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Anonymous remote MCP E2E</title></head>
  <body><h1>Anonymous remote MCP E2E</h1>
  <p>Open AI assistant in the bottom-right corner, select only #{CGI.escapeHTML(MCP_TOOL)}, and send:</p>
  <p>#{CGI.escapeHTML(prompt)}</p>
  <script>
    window.wire = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(url, options = {}) {
      const headers = Object.fromEntries(new Headers(options.headers).entries());
      if (headers.authorization) headers.authorization = '[REDACTED]';
      const entry = {url: String(url), method: options.method || 'GET', headers,
        body: options.body ? JSON.parse(options.body) : null};
      window.wire.push(entry);
      const response = await originalFetch(url, options);
      entry.status = response.status;
      response.clone().text().then(text => {
        entry.response = text;
        return originalFetch('/evidence', {method:'POST', body:JSON.stringify(window.wire)});
      }).catch(error => console.error('Evidence capture failed', error));
      return response;
    };
  </script>
  <script type="module" src="/llm-meta-widget.js"></script>
  <llm-meta-widget llm-url="#{CGI.escapeHTML(hub)}" tool-hub-url="#{CGI.escapeHTML(hub)}"
    model="#{CGI.escapeHTML(MODEL)}" models="#{CGI.escapeHTML(MODEL)}"
    hub-tools="#{CGI.escapeHTML(MCP_SERVER)}" well-known-urls="" max-rounds="4"
    enable-model-picker="false" greeting="Anonymous remote MCP round-trip test."></llm-meta-widget>
  </body></html>
HTML

# Explicit mock mode is for wiring tests only, not proof of a live hub/model.
mock_tool = { id: 1, name: MCP_TOOL, description: "Fixture guide", input_schema: { type: "object", properties: {} } }
mock_call = { id: "fixture-call", name: MCP_TOOL, arguments: {} }
mock_result = { content: [{ type: "text", text: "Fixture guide: " + "あ" * 39000 }], isError: false }
evidence_lock = Mutex.new
completed = -1
serving = Thread.new do
  loop do
    socket = server.accept
    Thread.new(socket) do |s|
      begin
        request = s.gets.to_s
        headers = {}
        while (line = s.gets) && line != "\r\n"
          key, value = line.split(":", 2)
          headers[key.downcase] = value.to_s.strip
        end
        length = Integer(headers.fetch("content-length", "0"))
        raise "Fixture body too large" unless length.between?(0, 8 * 1024 * 1024)
        body = length.positive? ? s.read(length) : ""
        method, target = request.split(" ", 3)
        path = target.to_s.split("?").first
        if method == "POST" && path == "/evidence"
          wire = JSON.parse(body)
          evidence_lock.synchronize do
            count = wire.count { _1.key?("response") }
            if count >= completed
              File.write(File.join(OUT, "wire.json"), JSON.pretty_generate(wire))
              completed = count
            end
          end
          reply(s, "", status: "204 No Content")
        elsif method == "GET" && ["/", "/index.html"].include?(path)
          reply(s, page, type: "text/html")
        elsif method == "GET" && path == "/llm-meta-widget.js"
          reply(s, File.binread(File.join(ROOT, "app/assets/javascripts/llm_meta_widget/llm-meta-widget.js")), type: "text/javascript")
        elsif method == "GET" && path == "/favicon.ico"
          reply(s, "", status: "204 No Content")
        elsif MOCK && path == "/hub/api/llms"
          reply(s, JSON.generate(llms: [{ models: [{ value: MODEL, max_input_tokens: 128000, defaults: {} }] }]))
        elsif MOCK && path == "/hub/api/mcp_servers"
          reply(s, JSON.generate(mcp_servers: [{ uuid: "fixture", name: MCP_SERVER, tools: [mock_tool] }]))
        elsif MOCK && path == "/hub/api/mcp_servers/fixture/tools"
          reply(s, JSON.generate(tools: [mock_tool]))
        elsif MOCK && method == "POST" && path == "/hub/api/mcp_tools/1/call"
          reply(s, JSON.generate(result: mock_result))
        elsif MOCK && method == "POST" && path.end_with?("/single_llm_calls")
          input = JSON.parse(body)
          if input.fetch("messages").any? { _1["role"] == "tool" }
            answer = "- ガイドを確認しました。\n- ツール結果を受け取りました。\n- 次のLLM turnで要約しました。"
            events = "event: text_delta\ndata: #{JSON.generate(delta: answer)}\n\nevent: done\ndata: #{JSON.generate(content: answer, finish_reason: 'stop')}\n\n"
          else
            events = "event: tool_call\ndata: #{JSON.generate(tool_call: mock_call)}\n\nevent: done\ndata: #{JSON.generate(content: '', finish_reason: 'tool_calls')}\n\n"
          end
          reply(s, events, type: "text/event-stream")
        else
          reply(s, "", status: "404 Not Found")
        end
      rescue StandardError => e
        warn "Fixture request failed: #{e.class}: #{e.message}"
      ensure
        s.close
      end
    end
  end
rescue IOError, Errno::EBADF
  nil
end

puts "Widget ready: #{origin}/index.html (#{MOCK ? 'MOCK: no real inference' : "live hub: #{hub}"})"
$stdout.flush
if ENV["SERVE_ONLY"] == "1"
  begin
    serving.join
  ensure
    server.close
  end
  exit
end

# Selenium is optional when SERVE_ONLY=1: another browser can drive the same page.
require "selenium-webdriver"
driver = nil
results = { mode: MOCK ? "mock" : "live", hub: hub, model: MODEL }
begin
  options = Selenium::WebDriver::Chrome::Options.new
  options.add_argument("--headless=new")
  options.add_argument("--window-size=1200,1000")
  options.add_argument("--user-data-dir=#{File.join(OUT, "profile-#{Process.pid}")}")
  driver = Selenium::WebDriver.for(:chrome, options: options)
  wait = Selenium::WebDriver::Wait.new(timeout: Integer(ENV.fetch("E2E_TIMEOUT", "600")), interval: 0.5)
  driver.navigate.to("#{origin}/index.html")
  wait.until { driver.find_elements(id: "llm-meta-widget-toggle").any? }
  driver.find_element(id: "llm-meta-widget-toggle").click
  driver.find_element(css: ".lmw-tools-picker summary").click
  server_row = wait.until { driver.find_elements(css: ".lmw-tools-server-row").find { _1.text.include?(MCP_SERVER) } }
  server_row.click
  label = wait.until { driver.find_elements(css: ".lmw-tools-item-child").find { _1.displayed? && _1.text.strip == MCP_TOOL } }
  checkbox = label.find_element(css: "input")
  checkbox.click unless checkbox.selected?
  driver.find_element(css: ".lmw-tools-picker summary").click
  input = driver.find_element(css: ".lmw-input")
  input.send_keys(prompt, :enter)
  wait.until do
    driver.execute_script("return window.wire.filter(e => e.url.includes('/single_llm_calls') && e.response !== undefined).length >= 2 || !!document.querySelector('.message.error')")
  end
  wire = driver.execute_script("return window.wire")
  results.merge!(RemoteToolWire.validate(wire, tool_name: MCP_TOOL))
rescue StandardError => e
  results[:error] = "#{e.class}: #{e.message}"
ensure
  if driver
    begin
      File.write(File.join(OUT, "wire.json"), JSON.pretty_generate(driver.execute_script("return window.wire")))
      driver.save_screenshot(File.join(OUT, "remote_tool.png"))
    rescue StandardError => e
      warn "Could not capture browser diagnostics: #{e.message}"
    ensure
      driver.quit
    end
  end
  serving.kill
  server.close
  File.write(File.join(OUT, "summary.json"), JSON.pretty_generate(results))
end
puts JSON.pretty_generate(results)
exit(results[:error] ? 1 : 0)
