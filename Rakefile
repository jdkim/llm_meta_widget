# `rake build` / `rake release`, used by .github/workflows/gem_release.yml.
# The widget has no Ruby test suite of its own: its logic is the browser
# orchestrator, tested with `node --test` (see `rake test_js`).
require "bundler/gem_tasks"

desc "Run the orchestrator's JavaScript tests"
task :test_js do
  sh "node --test app/assets/javascripts/llm_meta_widget/orchestrator.test.mjs"
end

task default: :test_js
