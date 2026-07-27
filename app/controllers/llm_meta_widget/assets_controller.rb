require "action_controller/base"

module LlmMetaWidget
  # Serves the widget's JS module from the gem's disk. Bypasses the host's
  # asset pipeline (Sprockets vs Propshaft compatibility) — same wire URL
  # on every host that installs the gem. The widget partial references
  # this route via <%= llm_meta_widget_orchestrator_path %>.
  class AssetsController < ActionController::Base
    # This action serves a public read-only JS module intended to be
    # <script src="…">-embedded on any page. Rails' default
    # RequestForgeryProtection includes a cross-origin JS check that
    # raises `InvalidCrossOriginRequest` on such loads whenever the
    # request's Referer is missing or from a "different" origin — even
    # same-app-same-host requests can trigger it in dev. Disable both
    # CSRF and that check for this controller: the endpoint has no
    # side effects and no authenticated context to protect.
    skip_forgery_protection

    ORCHESTRATOR_PATH = File.expand_path("../../assets/javascripts/llm_meta_widget/orchestrator.js", __dir__).freeze
    ORCHESTRATOR_BODY = File.read(ORCHESTRATOR_PATH).freeze
    ORCHESTRATOR_ETAG = %("#{Digest::SHA1.hexdigest(ORCHESTRATOR_BODY)}").freeze

    CONVERSATION_CSS_PATH = File.expand_path("../../assets/stylesheets/llm_meta_widget/conversation.css", __dir__).freeze
    CONVERSATION_CSS_BODY = File.read(CONVERSATION_CSS_PATH).freeze
    CONVERSATION_CSS_ETAG = %("#{Digest::SHA1.hexdigest(CONVERSATION_CSS_BODY)}").freeze

    # Vendored marked v12 ESM — client-side markdown renderer used by the
    # widget for streaming assistant responses (llm_meta_chat renders
    # server-side via Redcarpet on saved messages; the widget streams
    # deltas, so it needs a client-side renderer). Sourced from
    # https://cdn.jsdelivr.net/npm/marked@12/lib/marked.esm.js.
    MARKED_PATH = File.expand_path("../../assets/javascripts/llm_meta_widget/marked.esm.js", __dir__).freeze
    MARKED_BODY = File.read(MARKED_PATH).freeze
    MARKED_ETAG = %("#{Digest::SHA1.hexdigest(MARKED_BODY)}").freeze

    def orchestrator
      serve_asset(ORCHESTRATOR_BODY, ORCHESTRATOR_ETAG, "text/javascript")
    end

    def conversation_css
      serve_asset(CONVERSATION_CSS_BODY, CONVERSATION_CSS_ETAG, "text/css")
    end

    def marked
      serve_asset(MARKED_BODY, MARKED_ETAG, "text/javascript")
    end

    private

    # Weak-etag revalidation — browsers cache the body but revalidate on
    # each page load so a gem update propagates without user hard-reloads.
    def serve_asset(body, etag, mime)
      response.set_header("ETag", etag)
      if request.headers["If-None-Match"] == etag
        head :not_modified
      else
        response.set_header("Cache-Control", "public, must-revalidate, max-age=0")
        send_data body, type: mime, disposition: "inline"
      end
    end
  end
end
