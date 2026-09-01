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

That's the minimum. The widget renders a floating chat panel; visitors get a message-list, an input box, and (by default) a model dropdown + tool picker below the input.

To make the LLM able to do more than converse, declare tools using any of the **three tool classes** below.

## Three tool classes

The widget classifies every tool_call the LLM emits by name and dispatches to one of three execution paths. Each class has a different declaration, different visibility to the LLM, and different execution semantics.

### Class 3 — Page-embedded actions (`window.aiActions`)

Declared inline on the same view as the widget. Runs as JavaScript in the browser — no HTTP hop, no server involvement. Best for actions that mutate the page's own state ("click this button", "add to selection", "scroll to X").

**Declaration** — three script blocks on the view:

```html
<!-- (a) Tool schemas the LLM sees. JSON Schema (draft-2020-12 subset). -->
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

<!-- (b) State readers folded into the LLM's system prompt EVERY turn, -->
<!--     so the LLM can answer from page state without a tool_call. -->
<script>
  window.aiState = {
    text:                  function() { return $("#text").val() || ""; },
    selected_dictionaries: function() { return getSelected(); }
  };
</script>

<!-- (c) Action implementations invoked when the LLM emits a matching tool_call. -->
<script>
  window.aiActions = {
    add_dictionaries: function(args) { /* mutate the page here */ }
  };
</script>
```

**What the LLM sees.** The `ai-actions` JSON is passed to the meta-server as `local_tools` for every turn. Alongside it, every reader in `window.aiState` is invoked (each turn) and the results are JSON-serialized into a `Current page state:` block appended to the system prompt — the LLM can answer from state directly instead of tool-calling for lookups.

**When the tool_call fires.** Fire-and-forget, dispatched **AFTER** the LLM's response text finishes streaming. The action's return value is NOT fed back to the LLM this turn — the model already produced its user-facing answer and moved on. This is a deliberate design choice (see `project_page_embedded_actions` memory): writes are separated from the conversation loop so the LLM can commit to an action without waiting for a round-trip. Use Class 1/2 instead when you need the LLM to actually see the tool's result.

**Args**: parsed JS object matching the `input_schema`. Return value ignored. Async allowed (widget doesn't await, but browser will still execute the promise). Exceptions logged and surfaced as an `❌ <name>` chip in the message footer.

**LLM tried a name that isn't declared** → widget appends a `system: Not available on this page: <name>` message and continues.

### Class 2 — Host-wide MCP (`.well-known/mcp.json`)

Declared once per host origin via a well-known manifest. Widget fetches the manifest at boot, exposes the listed tools to the LLM, and (on tool_call) POSTs directly to each tool's endpoint over MCP JSON-RPC. **Meta-server is not involved** for Class 2 tool execution.

**Declaration.** Publish at `https://your-host.example/.well-known/mcp.json`:

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

- `url` is resolved against the host's origin (`/mcp` → `https://your-host.example/mcp`). Absolute URLs are also allowed but must be same-origin for the browser to reach them (otherwise CORS blocks the widget).
- The `tools[]` array in the manifest IS the tool list — the widget does not additionally call MCP `tools/list` on discovery. Keep the manifest in sync with the endpoint.

**Auto-discovery.** By default the widget fetches `<same-origin>/.well-known/mcp.json` at boot. To override, pass `well_known_urls:` to the helper: an explicit array (e.g. `["https://other.example/.well-known/mcp.json"]`) or `[]` to disable entirely.

**What the LLM sees.** Every tool listed in every discovered manifest is exposed as a callable. Names must be unique across manifests (if a name collides with a Class 1 or Class 3 tool, Class 3 wins, then Class 2, then Class 1).

**When the tool_call fires.** Synchronously during the turn — widget POSTs `{ jsonrpc, method: "tools/call", params: { name, arguments } }` to the tool's URL, awaits the JSON-RPC response, and feeds the result back to the LLM as tool output for the next round. Standard MCP loop.

**Error path.** HTTP 4xx/5xx, network failure, or an MCP JSON-RPC error → widget marks that dispatch as errored; visitor sees a red chip in the message footer; the LLM's next round sees the error as the tool's return value (so it can explain what went wrong instead of pretending it worked).

### Class 1 — Hub-registered MCP (via the meta-server)

Declared out-of-band on the meta-server (via the hub's admin UI or `/user/:id/mcp_servers` API). The widget doesn't own these — they're a shared pool visible across all consumers of the hub. Suited for third-party MCP servers (PubDictionaries, TogoMCP, Brave Search, …) that a single visitor might want to pick and choose from.

**Declaration.** No widget-side change. Register the server on the hub → flip `public: true` (visible to signed-in users) and optionally `public_to_anonymous: true` (visible to widget visitors without a login). See the meta-server's `Api::McpServersController`.

**What the LLM sees.** Only tools from servers the visitor has **enabled via the tool picker** (see "Level-1 pickers" below). Nothing is auto-selected — the visitor opts in per session.

**When the tool_call fires.** Synchronously during the turn — widget POSTs to the hub's `/api/llm_api_keys/:uuid/models/:name/chat_streams` endpoint with `tool_ids: [...]`; the hub proxies to each MCP server and streams results back through SSE.

**Error path.** Hub-side errors (rate limit, timeout, MCP server unavailable, upstream failure) arrive as SSE `event: error` frames with typed codes (`mcp_unavailable`, `timeout`, `rate_limit`, …); the widget surfaces them in the message bubble with a per-code prefix.

## Level-1 pickers

By default the widget renders two pickers below the input textarea:

- **Model dropdown** — populated from the hub's `GET /api/llms` (anon path returns Ollama-only, since the widget's LLM calls use `api_key_uuid: "ollama-local"`).
- **Tool picker** — populated from the hub's `GET /api/mcp_servers` (anon path returns `public_to_anonymous: true` servers). Two-level UX: server bulk-toggle + individual tool checkboxes on expand.

Both pickers require **CORS**: the meta-server must include the host's origin in its `config/initializers/cors.rb` allowlist (`/api/*` resource). Without CORS, the fetch is silently blocked and pickers stay empty.

To adjust picker behavior at the helper call site:

```erb
<%= llm_meta_widget(
      base_url:            "https://your-meta-server.example",
      model:               "qwen3-6-35b-fast",   # initial selection
      enable_model_picker: true,                 # false → hide picker, use fixed `model:`
      enable_tool_picker:  true,                 # false → hide picker, no Class-1 tools
      models:              nil,                  # nil = all anon models; ["qwen3-6-35b-fast", …] = allowlist
      hub_tools:           nil                   # nil = all anon-public MCPs; ["togomcp", …] = allowlist by server name
    ) %>
```

To lock the widget to the fixed `model:` prop and disable Class-1 tools entirely (level-0 mode — Class 2 & 3 still work):

```erb
<%= llm_meta_widget(base_url: "…", model: "…",
                    enable_model_picker: false,
                    enable_tool_picker:  false) %>
```

## All helper options

| Option | Default | Purpose |
|---|---|---|
| `base_url:` | required | Meta-server URL |
| `model:` | required | Initial model (also the fallback when picker is disabled) |
| `api_key_uuid:` | `"ollama-local"` | Hub API-key uuid to invoke |
| `orchestrator_path:` | `"/llm_meta_widget_assets/orchestrator.js"` | Served by the gem's engine; rarely overridden |
| `actions_schema_id:` | `"ai-actions"` | DOM id of the Class-3 schema block |
| `state_global:` | `"aiState"` | Global window object holding Class-3 state readers |
| `actions_global:` | `"aiActions"` | Global window object holding Class-3 implementations |
| `remote_tools_schema_id:` | `"remote-mcp-tools"` | Optional DOM id for pre-configured Class-1 tools (bypasses picker) |
| `well_known_urls:` | `nil` | `nil` = auto-discover same-origin; explicit array = fetch those; `[]` = disable |
| `max_rounds:` | `3` | Cap on tool-call rounds per LLM turn |
| `enable_model_picker:` | `true` | Show model dropdown (Level-1) |
| `enable_tool_picker:` | `true` | Show tool picker (Level-1) |
| `models:` | `nil` | Model-name allowlist; `nil` = all anon-available |
| `hub_tools:` | `nil` | MCP-server-name allowlist; `nil` = all anon-public |

## License

Apache-2.0.
