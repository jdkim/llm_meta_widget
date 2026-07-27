# llm_meta_widget

Embeddable browser chat widget for the [llm_meta](https://github.com/pubannotation) ecosystem.

Client-orchestrated: the widget fetches host-side action schemas + host-published `.well-known/mcp.json` manifests at boot, dispatches tool_calls locally (page-embedded actions) or directly to MCP endpoints (host-wide well-known), and consumes the meta-server's SSE `single_llm_calls` API. Ships one Rails helper + one view partial + a served orchestrator JS module.

**No** Devise, DB migrations, ChatManager, or PromptNavigator. Adds only `rails >= 8.0` as a runtime dep — so hosts that haven't bumped to 8.1 can adopt it without a Rails upgrade.

## Installation (local, path-based)

Add to the host app's Gemfile:

```ruby
gem "llm_meta_widget", path: "../llm_meta/llm_meta_widget"
```

Then `bundle install`. The engine auto-includes the widget helper into ActionView, so nothing else to wire up.

## Usage

On any view where you want the widget:

```erb
<%= llm_meta_widget(base_url: "https://your-meta-server.example",
                    model:    "qwen3-6-35b-fast") %>
```

And **on the same view**, declare the host-specific pieces:

```html
<!-- (1) Local action schemas the LLM sees -->
<script type="application/json" id="ai-actions">
[
  { "name": "add_dictionaries",
    "description": "Add the named dictionaries to the current selection.",
    "input_schema": {
      "type": "object",
      "properties": { "names": { "type": "array", "items": { "type": "string" } } },
      "required": ["names"]
    } }
]
</script>

<!-- (2) State readers used every turn to build the LLM's system-prompt context -->
<script>
  window.aiState = {
    text:                  function() { return $("#text").val() || ""; },
    selected_dictionaries: function() { return /* ... */; }
  };
</script>

<!-- (3) Action implementations invoked (fire-and-forget) when the LLM emits a tool_call -->
<script>
  window.aiActions = {
    add_dictionaries: function(args) { /* mutate the page here */ }
  };
</script>
```

For host-wide MCP tools, publish a `/.well-known/mcp.json`:

```json
{
  "servers": [{
    "name": "myhost",
    "url":  "/mcp",
    "tools": [
      { "name": "annotate", "description": "…", "input_schema": {…} }
    ]
  }]
}
```

The widget auto-discovers it at boot from same origin.

## Three tool classes

See the `project_mcp_tool_classes` memory in the llm_meta workspace for the full taxonomy:

- **Class 1 · Remote (hub-registered)** — meta-server DB, executed via meta-server proxy.
- **Class 2 · Host-wide (well-known)** — auto-discovered from host's `/.well-known/mcp.json`, executed directly against the host's own MCP endpoint (widget bypasses the meta-server for these).
- **Class 3 · Page-embedded (`aiActions`)** — declared inline on the view, executed as JS in the browser (no HTTP).

The widget classifies each tool_call by name and dispatches to the right execution path.

## License

Apache-2.0.
