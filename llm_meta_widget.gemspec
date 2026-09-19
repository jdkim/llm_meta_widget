require_relative "lib/llm_meta_widget/version"

Gem::Specification.new do |spec|
  spec.name        = "llm_meta_widget"
  spec.version     = LlmMetaWidget::VERSION
  spec.authors     = [ "jdkim" ]
  spec.email       = [ "jdkim@dbcls.rois.ac.jp" ]
  spec.homepage    = "https://github.com/jdkim/llm_meta_widget"
  spec.summary     = "Embeddable browser chat widget for the llm_meta ecosystem."
  spec.description = "Client-orchestrated chat widget: fetches host-side aiActions + " \
                     ".well-known/mcp.json manifests, dispatches tool_calls locally or " \
                     "directly to MCP endpoints, and consumes the llm_meta_server's " \
                     "SSE-streamed single_llm_calls API. Ships one helper + one partial " \
                     "+ a served orchestrator.js. No Devise, no DB migrations, no chat_manager."
  spec.license     = "Apache-2.0"

  spec.required_ruby_version = ">= 3.2"

  spec.metadata["homepage_uri"]    = spec.homepage
  spec.metadata["source_code_uri"] = "#{spec.homepage}/tree/main"

  # The orchestrator's node tests live beside it but are not part of the gem.
  spec.files = Dir["{app,config,lib}/**/*", "LICENSE", "Rakefile", "README.md", "CHANGELOG.md"]
                 .select { File.file?(_1) }
                 .reject { _1.end_with?(".test.mjs") }

  # Deliberately minimal — the widget is a Rails engine that renders a
  # partial + serves a JS asset via a controller. Compatible with Rails 8.0+
  # so hosts that haven't bumped to 8.1 (e.g. PubDictionaries as of
  # 2026-07-27) can add it without a Rails upgrade.
  spec.add_dependency "rails", ">= 8.0"
end
