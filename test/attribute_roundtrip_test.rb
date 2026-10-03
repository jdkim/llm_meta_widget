# Do the two halves of the attribute contract actually agree?
#
# partial_render_test.rb checks what the gem WRITES. config.test.mjs checks what
# the element READS. Both can pass while the two disagree — if the helper emitted
# enable-model-picker="0", the element would read it as TRUE, because only the
# exact string "false" disables. Green suites, wrong widget.
#
# So this renders the partial with the gem's real helper, parses the attributes
# off the rendered tag, hands them to the element's real readConfig through node,
# and compares the result against what the options meant. It is the only check
# that exercises the composition rather than either side alone.
#
#   ruby test/attribute_roundtrip_test.rb
require "erb"
require "cgi"
require "json"
require "tempfile"

class String; def html_safe; self; end; def presence; empty? ? nil : self; end; end
class NilClass; def html_safe; self; end; end

ROOT = File.expand_path("..", __dir__)
load File.join(ROOT, "app/helpers/llm_meta_widget/widget_helper.rb")
include LlmMetaWidget::WidgetHelper

DEFAULTS = LlmMetaWidget::WidgetHelper::DEFAULTS
SRC = File.read(File.join(ROOT, "app/views/llm_meta_widget/_chat_panel.html.erb"))

def render(**overrides)
  locals = DEFAULTS.merge(llm_url: "https://hub.example", model: "m", **overrides)
  b = binding
  locals.each { |k, v| b.local_variable_set(k, v) }
  ERB.new(SRC, trim_mode: "-").result(b)
end

# Pull the attributes off the rendered <llm-meta-widget …> tag.
def attributes_of(html)
  tag = html[/<llm-meta-widget\b(.*?)>/m, 1] or raise "no element tag in rendered output"
  tag.scan(/([a-z-]+)="([^"]*)"/).to_h.transform_values { CGI.unescapeHTML(_1) }
end

# Feed those attributes to the element's OWN readConfig, in node.
def read_config(attrs)
  script = <<~JS
    import { readConfig } from "#{File.join(ROOT, 'app/assets/javascripts/llm_meta_widget/config.js')}";
    const attrs = #{JSON.generate(attrs)};
    const el = {
      hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
      getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
    };
    process.stdout.write(JSON.stringify(readConfig(el)));
  JS
  Tempfile.create([ "roundtrip", ".mjs" ]) do |f|
    f.write(script)
    f.flush
    out = `node #{f.path}`
    raise "node failed" unless $?.success?
    JSON.parse(out)
  end
end

def roundtrip(**overrides) = read_config(attributes_of(render(**overrides)))

$failures = 0
def check(label)
  ok = yield
  puts(ok ? "  ok   #{label}" : "  FAIL #{label}")
  $failures += 1 unless ok
end

check("the gem's defaults survive the trip unchanged") do
  c = roundtrip
  c["LLM_BASE"] == "https://hub.example" && c["MODEL"] == "m" &&
    c["API_KEY_UUID"] == DEFAULTS[:api_key_uuid] &&
    c["LLM_PROVIDER"] == DEFAULTS[:llm_provider] &&
    c["MAX_ROUNDS"] == DEFAULTS[:max_rounds] &&
    c["STATE_GLOBAL"] == DEFAULTS[:state_global] &&
    c["ACTIONS_GLOBAL"] == DEFAULTS[:actions_global]
end

# The booleans are where a mismatch hides: the gem omits the attribute to mean
# true, and the element must agree that absence means true.
check("enable_model_picker: true -> omitted -> read back as true") do
  roundtrip(enable_model_picker: true)["ENABLE_MODEL_PICKER"] == true
end
check("enable_model_picker: false -> survives as false") do
  roundtrip(enable_model_picker: false)["ENABLE_MODEL_PICKER"] == false
end
check("enable_tool_picker: false survives, and true needs a hub") do
  roundtrip(tool_hub_url: "https://hub.example", enable_tool_picker: false)["ENABLE_TOOL_PICKER"] == false &&
    roundtrip(tool_hub_url: "https://hub.example", enable_tool_picker: true)["ENABLE_TOOL_PICKER"] == true &&
    roundtrip(enable_tool_picker: true)["ENABLE_TOOL_PICKER"] == false
end

# The tri-state is the case the whole convention exists for.
check("well_known_urls: nil -> null (auto-discover)") { roundtrip(well_known_urls: nil)["WELL_KNOWN_URLS"].nil? }
check("well_known_urls: [] -> [] (discovery OFF, not auto-discover)") do
  roundtrip(well_known_urls: [])["WELL_KNOWN_URLS"] == []
end
check("well_known_urls: a list -> the same list") do
  roundtrip(well_known_urls: %w[https://a/x https://b/y])["WELL_KNOWN_URLS"] == %w[https://a/x https://b/y]
end

check("allowlists: nil and [] both arrive as null; a list arrives intact") do
  roundtrip(models: nil)["MODEL_ALLOWLIST"].nil? &&
    roundtrip(models: [])["MODEL_ALLOWLIST"].nil? &&
    roundtrip(models: %w[a b])["MODEL_ALLOWLIST"] == %w[a b] &&
    roundtrip(hub_tools: %w[TogoMCP x])["HUB_TOOLS_ALLOWLIST"] == %w[TogoMCP x]
end

check("tool_hub_url: nil and \"\" both arrive as null") do
  roundtrip(tool_hub_url: nil)["TOOL_HUB_BASE"].nil? &&
    roundtrip(tool_hub_url: "")["TOOL_HUB_BASE"].nil?
end

check("max_rounds survives as a number, not a string") do
  roundtrip(max_rounds: 12)["MAX_ROUNDS"] == 12
end

check("a greeting with quotes and angle brackets arrives intact") do
  g = 'He said "hi" & <left>'
  roundtrip(greeting: g)["GREETING"] == g
end

puts($failures.zero? ? "\nall checks passed" : "\n#{$failures} FAILED")
exit($failures.zero? ? 0 : 1)
