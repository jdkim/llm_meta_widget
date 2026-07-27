module LlmMetaWidget
  class Engine < ::Rails::Engine
    # No isolate_namespace: we want the WidgetHelper included into the host's
    # ActionView unconditionally, and the routes to appear at the host's
    # top-level namespace without needing an explicit `mount` in host routes.rb.

    initializer "llm_meta_widget.helpers" do
      ActiveSupport.on_load(:action_view) do
        include LlmMetaWidget::WidgetHelper
      end
    end
  end
end
