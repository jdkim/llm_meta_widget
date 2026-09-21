# `rake build` / `rake release`, used by .github/workflows/gem_release.yml.
# The widget has no Ruby test suite of its own: its logic is the browser
# orchestrator, tested with `node --test` (see `rake test_js`) and linted
# with eslint (`rake lint_js`). The lint covers the panel's script too, by
# extracting it from the ERB — three bugs reached a browser through that gap
# before it existed: an undefined variable, a stale import, a redeclared one.
require "bundler/gem_tasks"

desc "Run the orchestrator's JavaScript tests"
task :test_js do
  sh "node --test app/assets/javascripts/llm_meta_widget/orchestrator.test.mjs"
end

desc "Lint the widget's JavaScript, including the panel script inside the ERB"
task :lint_js do
  sh "npm install --silent" unless Dir.exist?("node_modules")
  sh "npm run lint"
end

task default: [ :lint_js, :test_js ]
