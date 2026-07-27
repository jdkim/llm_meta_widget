Rails.application.routes.draw do
  # Non-namespaced (no engine mount required in the host) — the widget's
  # partial references this exact path.
  get "/llm_meta_widget_assets/orchestrator.js",
      to: "llm_meta_widget/assets#orchestrator",
      as: :llm_meta_widget_orchestrator

  # Canonical "chat conversation" styles — bubbles, thinking blocks,
  # role labels. Consumed by the widget partial itself AND by any
  # llm_meta_client-scaffolded chat host that adopts the same surface.
  # Scoped by `.llm-meta-conversation` opt-in class (see the CSS file).
  get "/llm_meta_widget_assets/conversation.css",
      to: "llm_meta_widget/assets#conversation_css",
      as: :llm_meta_widget_conversation_css

  # Vendored marked.esm.js — client-side markdown renderer for streaming
  # assistant responses in the widget.
  get "/llm_meta_widget_assets/marked.esm.js",
      to: "llm_meta_widget/assets#marked",
      as: :llm_meta_widget_marked
end
