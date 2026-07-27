Rails.application.routes.draw do
  # Non-namespaced (no engine mount required in the host) — the widget's
  # partial references this exact path.
  get "/llm_meta_widget_assets/orchestrator.js",
      to: "llm_meta_widget/assets#orchestrator",
      as: :llm_meta_widget_orchestrator
end
