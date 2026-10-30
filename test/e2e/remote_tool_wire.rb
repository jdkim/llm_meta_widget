require "json"
require "uri"

# Assertions over captured HTTP, not over a model's claim that it used a tool.
module RemoteToolWire
  class Invalid < StandardError; end
  class MalformedCapture < StandardError; end

  def self.validate(wire, tool_name: "TogoMCP_Usage_Guide")
    results = { checks: {} }
    check = ->(name, condition) do
      results[:checks][name] = !!condition
      raise Invalid, "Assertion failed: #{name}" unless condition
    end
    llm = wire.select { _1.fetch("url").include?("/single_llm_calls") }
    calls = wire.select { _1.fetch("url").match?(%r{/api/mcp_tools/[^/]+/call}) }
    check.call(:two_llm_turns, llm.length == 2)
    check.call(:one_proxy_call, calls.length == 1)
    check.call(:anonymous, (llm + calls).all? { |r| r.fetch("headers", {}).keys.none? { _1.downcase == "authorization" } })
    check.call(:http_success, (llm + calls).all? { _1["status"] == 200 })
    check.call(:server_generation_defaults, llm.all? { (_1.fetch("body").fetch("generation_settings", {}).to_h.keys & %w[num_ctx context_window context_size]).empty? && !_1.fetch("body").fetch("generation_settings", {}).to_h.fetch("options", {}).to_h.key?("num_ctx") })
    events = llm.map do |request|
      request.fetch("response").split(/\r?\n\r?\n/).filter_map do |frame|
        name = frame[/^event: (.+)$/, 1]&.strip
        data = frame.lines.filter_map { _1.delete_prefix("data:").strip if _1.start_with?("data:") }.join("\n")
        { "event" => name, "data" => JSON.parse(data) } unless data.empty?
      end
    end
    check.call(:no_sse_errors, events.flatten.none? { _1["event"] == "error" })
    tc = events[0].find { _1["event"] == "tool_call" }&.dig("data", "tool_call")
    check.call(:requested_tool, tc && tc["name"] == tool_name)
    check.call(:tool_call_id_present, tc["id"].is_a?(String) && !tc["id"].strip.empty?)
    id = URI.parse(calls[0]["url"]).path[%r{/mcp_tools/([^/]+)/call}, 1]
    check.call(:selected_tool_id, llm[0].fetch("body").fetch("tool_ids").map(&:to_s) == [id])
    check.call(:request_order, wire.index(llm[0]) < wire.index(calls[0]) && wire.index(calls[0]) < wire.index(llm[1]))
    check.call(:empty_arguments, calls[0].fetch("body")["arguments"] == {})
    result = JSON.parse(calls[0].fetch("response")).fetch("result")
    check.call(:non_error_tool_result, result.is_a?(Hash) && result["isError"] != true && !result["content"].to_a.empty?)
    followup = llm[1].fetch("body").fetch("messages")
    assistant = followup.find { _1["role"] == "assistant" && _1["tool_calls"] }
    output = followup.find { _1["role"] == "tool" && _1["tool_call_id"] == tc["id"] }
    check.call(:matching_tool_history, assistant && assistant["tool_calls"].include?(tc) && output && output["name"] == tc["name"])
    check.call(:result_fed_back, output["content"] == JSON.generate(result))
    done = events[1].find { _1["event"] == "done" }&.dig("data")
    check.call(:final_answer, done && !done["content"].to_s.strip.empty? && !%w[length max_tokens tool_calls content_filter].include?(done["finish_reason"]) && events[1].none? { _1["event"] == "tool_call" })
    results.merge(answer: done["content"])
  rescue KeyError, TypeError, NoMethodError, JSON::ParserError, URI::InvalidURIError => e
    raise MalformedCapture, "Malformed capture: #{e.message}"
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    puts JSON.pretty_generate(RemoteToolWire.validate(JSON.parse(File.read(ARGV.fetch(0))), tool_name: ENV.fetch("MCP_TOOL", "TogoMCP_Usage_Guide")))
  rescue RemoteToolWire::MalformedCapture, JSON::ParserError => e
    warn "Malformed capture: #{e.message}"
    exit 2
  rescue StandardError => e
    warn "#{e.class}: #{e.message}"
    exit 1
  end
end
