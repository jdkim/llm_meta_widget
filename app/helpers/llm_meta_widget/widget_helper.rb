module LlmMetaWidget
  # Renders the client-orchestrated chat widget on the current page.
  #
  #   <%= llm_meta_widget(base_url: "https://llmbranch.dbcls.jp",
  #                       model:    "qwen3-6-35b-fast") %>
  #
  # The host page must ALSO provide:
  #   - <script type="application/json" id="ai-actions">…</script> — local
  #     action schemas (name/description/input_schema each).
  #   - window.aiState — reader functions called each turn to build the
  #     system prompt with current page state.
  #   - window.aiActions — action implementations invoked fire-and-forget
  #     when the LLM emits a matching tool_call.
  #
  # See llm_meta_widget's README for the three MCP-tool classes it supports
  # (page-embedded aiActions / host-wide well-known / hub-registered).
  module WidgetHelper
    DEFAULTS = {
      api_key_uuid:            "ollama-local",
      orchestrator_path:       "/llm_meta_widget_assets/orchestrator.js",
      actions_schema_id:       "ai-actions",
      state_global:            "aiState",
      actions_global:          "aiActions",
      remote_tools_schema_id:  "remote-mcp-tools",
      # nil → widget auto-discovers same-origin /.well-known/mcp.json at boot;
      # explicit array → fetch those URLs; empty array → disable entirely.
      well_known_urls:         nil,
      max_rounds:              3
    }.freeze

    def llm_meta_widget(base_url:, model:, **overrides)
      locals = DEFAULTS.merge(base_url: base_url, model: model, **overrides)
      render partial: "llm_meta_widget/chat_panel", locals: locals
    end
  end
end
