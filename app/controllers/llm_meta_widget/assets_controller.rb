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

    def orchestrator
      # Weak-etag revalidation — browsers cache the body but revalidate on
      # each page load so a gem update propagates without user hard-reloads.
      response.set_header("ETag", ORCHESTRATOR_ETAG)
      if request.headers["If-None-Match"] == ORCHESTRATOR_ETAG
        head :not_modified
      else
        response.set_header("Cache-Control", "public, must-revalidate, max-age=0")
        send_data ORCHESTRATOR_BODY, type: "text/javascript", disposition: "inline"
      end
    end
  end
end
