require "json"

def assert_check(results, name, condition)
  results[:checks][name] = !!condition
  raise "Assertion failed: #{name}" unless condition
end

def validate_remote_tool_wire(wire, results)
  llm = wire.select { _1['url'].include?('/single_llm_calls') }
  calls = wire.select { _1['url'].match?(%r{/api/mcp_tools/\d+/call}) }
  assert_check(results, :two_llm_turns, llm.length == 2)
  assert_check(results, :one_proxy_call, calls.length == 1)
  assert_check(results, :anonymous, (llm + calls).all? { !_1['headers'].key?('authorization') })
  assert_check(results, :http_success, (llm + calls).all? { _1['status'] == 200 })
  assert_check(results, :context_settings_on_both_turns, llm.all? { _1['body'].dig('generation_settings', 'options', 'num_ctx') == 65536 })
  events = llm.map do |request|
    request.fetch('response').split(/\r?\n\r?\n/).filter_map do |frame|
      name = frame[/^event: (.+)$/, 1]&.strip
      data = frame[/^data: (.+)$/, 1]
      { 'event' => name, 'data' => JSON.parse(data) } if data
    end
  end
  tc = events[0].find { _1['event'] == 'tool_call' }&.dig('data', 'tool_call')
  assert_check(results, :guide_tool_call, tc && tc['name'] == 'TogoMCP_Usage_Guide')
  assert_check(results, :selected_tool_id, llm[0]['body']['tool_ids'].map(&:to_s) == [calls[0]['url'][%r{/mcp_tools/(\d+)/call}, 1]])
  assert_check(results, :request_order, wire.index(llm[0]) < wire.index(calls[0]) && wire.index(calls[0]) < wire.index(llm[1]))
  assert_check(results, :empty_arguments, calls[0]['body']['arguments'] == {})
  result = JSON.parse(calls[0]['response']).fetch('result')
  assert_check(results, :non_error_tool_result, result['isError'] != true && !result['content'].to_a.empty?)
  followup = llm[1]['body']['messages']
  assistant = followup.find { _1['role'] == 'assistant' && _1['tool_calls'] }
  output = followup.find { _1['role'] == 'tool' }
  assert_check(results, :matching_tool_history, assistant && assistant['tool_calls'].include?(tc) && output && output['tool_call_id'] == (tc['id'] || "") && output['name'] == tc['name'])
  assert_check(results, :result_fed_back, output['content'] == JSON.generate(result))
  done = events[1].find { _1['event'] == 'done' }&.dig('data')
  assert_check(results, :final_answer, done && !done['content'].to_s.strip.empty? && events[1].none? { _1['event'] == 'tool_call' || _1['event'] == 'error' })
  results[:answer] = done['content']
  results
end

if $PROGRAM_NAME == __FILE__
  results = { checks: {} }
  begin
    validate_remote_tool_wire(JSON.parse(File.read(ARGV.fetch(0))), results)
  rescue StandardError => e
    results[:error] = "#{e.class}: #{e.message}"
  end
  puts JSON.pretty_generate(results)
  exit(results[:error] ? 1 : 0)
end
