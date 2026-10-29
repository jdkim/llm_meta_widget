require_relative "e2e/remote_tool_wire"

call = { "id" => "c1", "name" => "TogoMCP_Usage_Guide", "arguments" => {} }
result = { "content" => [{ "type" => "text", "text" => "あ" * 39000 }], "isError" => false }
frame = ->(name, data) { "event: #{name}\ndata: #{JSON.generate(data)}\n\n" }
wire = [
  { "url" => "http://hub/api/llm_api_keys/local/models/m/single_llm_calls", "headers" => {}, "status" => 200,
    "body" => { "tool_ids" => [1], "generation_settings" => {} },
    "response" => frame.call("tool_call", { "tool_call" => call }) + frame.call("done", { "content" => "", "finish_reason" => "tool_calls" }) },
  { "url" => "http://hub/api/mcp_tools/1/call", "headers" => {}, "status" => 200,
    "body" => { "arguments" => {} }, "response" => JSON.generate("result" => result) },
  { "url" => "http://hub/api/llm_api_keys/local/models/m/single_llm_calls", "headers" => {}, "status" => 200,
    "body" => { "generation_settings" => {}, "messages" => [
      { "role" => "assistant", "tool_calls" => [call], "content" => "" },
      { "role" => "tool", "tool_call_id" => "c1", "name" => call["name"], "content" => JSON.generate(result) }
    ] }, "response" => frame.call("done", { "content" => "ガイドの要約", "finish_reason" => "stop" }) }
]
summary = RemoteToolWire.validate(wire)
raise "Expected all wire checks" unless summary[:checks].size == 14 && summary[:checks].values.all?
puts "ok: complete anonymous round trip with a 117KB Unicode result"
mutations = {
  missing_llm: ->(w) { w.pop },
  missing_proxy: ->(w) { w.delete_at(1) },
  authorization: ->(w) { w[0]["headers"]["Authorization"] = "[REDACTED]" },
  http_error: ->(w) { w[1]["status"] = 429 },
  forced_context: ->(w) { w[0]["body"]["generation_settings"] = { "options" => { "num_ctx" => 65536 } } },
  wrong_tool: ->(w) { w[0]["response"] = w[0]["response"].sub("TogoMCP_Usage_Guide", "other") },
  wrong_selected_id: ->(w) { w[0]["body"]["tool_ids"] = [2] },
  wrong_order: ->(w) { w[0], w[1] = w[1], w[0] },
  wrong_arguments: ->(w) { w[1]["body"]["arguments"] = { "unexpected" => true } },
  tool_error: ->(w) { w[1]["response"] = JSON.generate("result" => result.merge("isError" => true)) },
  wrong_call_id: ->(w) { w[2]["body"]["messages"][1]["tool_call_id"] = "other" },
  truncated_result: ->(w) { w[2]["body"]["messages"][1]["content"] = "shortened" },
  empty_answer: ->(w) { w[2]["response"] = frame.call("done", { "content" => "" }) },
  truncated_answer: ->(w) { w[2]["response"] = frame.call("done", { "content" => "partial", "finish_reason" => "length" }) },
  sse_error: ->(w) { w[2]["response"] += frame.call("error", { "code" => "rate_limit" }) }
}
mutations.each do |name, mutate|
  copy = Marshal.load(Marshal.dump(wire))
  mutate.call(copy)
  begin
    RemoteToolWire.validate(copy)
  rescue RemoteToolWire::Invalid
    puts "ok: rejects #{name}"
    next
  end
  raise "Validator accepted #{name}"
end
