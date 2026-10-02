# Does the Rails partial render the element with the right attributes?
#
# The gem's job is now to turn keyword options into attributes, and the mapping
# has three cases that fail quietly if they regress — the same three config.js
# is tested on, approached from the other side. config.test.mjs checks how the
# element READS attributes; this checks how the gem WRITES them. A mismatch
# between the two would leave the widget misconfigured with nothing failing.
#
# Standalone, like the scripts in test/e2e: `ruby test/partial_render_test.rb`.
# No Rails: it loads the REAL helper module and the REAL partial, stubbing only
# what Rails would otherwise provide.
#
# The first version of this file reimplemented tag_attr/well_known_attr as test
# shims, which made it vacuous — breaking the shipped helper left every check
# green. Load the real thing, or the test tests itself.
require "erb"
require "cgi"

# --- the two Rails-isms the helper uses at call time ----------------------
class String; def html_safe; self; end; def presence; empty? ? nil : self; end; end
class NilClass; def html_safe; self; end; end

HELPER = File.expand_path("../app/helpers/llm_meta_widget/widget_helper.rb", __dir__)
load HELPER
include LlmMetaWidget::WidgetHelper          # tag_attr / well_known_attr, as shipped

DEFAULTS = LlmMetaWidget::WidgetHelper::DEFAULTS
PANEL = File.expand_path("../app/views/llm_meta_widget/_chat_panel.html.erb", __dir__)
SRC = File.read(PANEL)

def render(**overrides)
  locals = DEFAULTS.merge(llm_url: "https://hub.example", model: "m", **overrides)
  b = binding
  locals.each { |k, v| b.local_variable_set(k, v) }
  ERB.new(SRC, trim_mode: "-").result(b)
end

$failures = 0
def check(label)
  ok = yield
  puts(ok ? "  ok   #{label}" : "  FAIL #{label}")
  $failures += 1 unless ok
end

# Guard the guard: prove we are exercising the shipped helper, not a local copy.
check("exercises the gem's own helper methods") do
  method(:well_known_attr).owner == LlmMetaWidget::WidgetHelper &&
    method(:tag_attr).owner == LlmMetaWidget::WidgetHelper
end

html = render
check("renders the custom element") { html.include?("<llm-meta-widget") }
check("loads the bundle, not the old orchestrator") do
  html.include?('src="/llm_meta_widget_assets/llm-meta-widget.js"') &&
    !html.include?("orchestrator.js")
end
check("carries the two required attributes") do
  html.include?('llm-url="https://hub.example"') && html.include?('model="m"')
end
check("omits tool-hub-url when there is no hub") { !html.include?("tool-hub-url=") }
check("emits tool-hub-url when there is one") do
  render(tool_hub_url: "https://hub.example").include?('tool-hub-url="https://hub.example"')
end

# pickers default to true in the element, so the gem emits only the disabling value
check("says nothing about the pickers when both are enabled") do
  !html.include?("enable-model-picker") && !html.include?("enable-tool-picker")
end
check('emits enable-model-picker="false" when disabled') do
  render(enable_model_picker: false).include?('enable-model-picker="false"')
end

# allowlists: nil and [] both mean "no allowlist", so both omit
check("omits models / hub-tools when nil") { !html.include?("models=") && !html.include?("hub-tools=") }
check("omits them when empty too") do
  out = render(models: [], hub_tools: [])
  !out.include?("models=") && !out.include?("hub-tools=")
end
check("joins them with commas when present") do
  out = render(models: %w[a b], hub_tools: %w[TogoMCP pubdictionaries])
  out.include?('models="a,b"') && out.include?('hub-tools="TogoMCP,pubdictionaries"')
end

# well-known-urls is the tri-state, and [] must survive as an EMPTY attribute
check("well-known-urls: nil omits the attribute (auto-discover)") { !html.include?("well-known-urls") }
check("well-known-urls: [] emits it EMPTY (discovery off), not dropped") do
  render(well_known_urls: []).include?('well-known-urls=""')
end
check("well-known-urls: a list is comma-joined") do
  render(well_known_urls: %w[https://a/x https://b/y]).include?('well-known-urls="https://a/x,https://b/y"')
end

check("escapes a value that would otherwise break out of the attribute") do
  out = render(greeting: 'He said "hi" & <left>')
  out.include?("&quot;") && !out.include?('greeting="He said "hi"')
end
check("renders max-rounds and the globals") do
  html.include?('max-rounds="3"') && html.include?('state-global="aiState"') &&
    html.include?('actions-global="aiActions"')
end

puts($failures.zero? ? "\nall checks passed" : "\n#{$failures} FAILED")
exit($failures.zero? ? 0 : 1)
