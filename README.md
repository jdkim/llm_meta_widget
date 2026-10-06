# llm_meta_widget

Embeddable browser chat widget for the [llm_meta](https://github.com/pubannotation) ecosystem.

Client-orchestrated: the widget fetches host-side action schemas + host-published `.well-known/mcp.json` manifests at boot, dispatches tool_calls locally (page-embedded actions) or directly to MCP endpoints (host-wide well-known), and consumes the meta-server's SSE `single_llm_calls` API. Ships as a custom element in one self-contained ES module — on npm for any host, and in a Rails gem whose helper serves the identical file.

**No** Devise, DB migrations, ChatManager, or PromptNavigator. The gem adds only `rails >= 8.0` as a runtime dep — so hosts that haven't bumped to 8.1 can adopt it without a Rails upgrade — and hosts that are not Rails at all skip the gem entirely.

## What you need first

The widget is a browser front end: it needs something to answer the chat. That
can be **[llm_meta_server](https://github.com/pubannotation)** — a hub that
holds provider credentials and streams responses back — or **an Ollama**,
which the widget talks to directly with no server component of ours in
between.

Those are separate from where tools come from. A hub also registers MCP tools
(Class 1 below), and you can point at one for tools while a local Ollama
answers the chat, or use no hub at all. Page actions and your own
`.well-known/mcp.json` never involve a hub either way.

Nothing else is required: no database, no migrations, no JavaScript build
step, no Node at runtime.

| Requirement | Version | Needed when |
|---|---|---|
| A browser with custom elements + ES modules | any current | always |
| An llm_meta_server **or** an Ollama | any | always — something has to answer the chat |
| Ruby | >= 3.2 | only if you install the gem |
| Rails | >= 8.0 (8.1 not required) | only if you install the gem |

## Two ways to add the widget — choose one

You do **not** need both. Pick the row that matches your app, then read only
that section.

| Your app | What you add | What you write |
|---|---|---|
| **Rails** | the gem, one line in your `Gemfile` | one helper call in a view. The helper writes the `<llm-meta-widget>` tag for you, so you never write that tag yourself |
| **Anything else** — Python, Go, PHP, plain HTML… | one `<script>` tag from the CDN | the `<llm-meta-widget>` tag yourself |

Both ways load the same file and run the same widget.

## Rails apps: install the gem

```ruby
# Gemfile
gem "llm_meta_widget", "~> 0.7"
```

```
bundle install
```

That is the whole install. There is **no `mount` to add** — the engine
deliberately skips `isolate_namespace`, so the helper is included into
ActionView and the asset routes appear at the host's top level on their own.
There are no migrations and no generators to run.

**Why install the gem?** The gem gives you the same widget as the CDN — the
same file, byte for byte. It does not add features. What it gives you is a
simpler way to deliver and configure the widget:

- **Your own server sends the file**, at
  `/llm_meta_widget_assets/llm-meta-widget.js`. The page makes no request to
  any other site. If the CDN is down, your page still works, and the widget
  also works behind a firewall or on a network with no internet access.
- **Bundler manages the version**, like every other gem. You update it with
  `bundle update`. With the CDN, the version is part of a URL that someone
  has to remember to change.
- **You write Ruby, not HTML attributes.** The helper takes normal Ruby
  values and converts them for you. That matters most where the attributes
  are easy to get wrong: `nil` and `[]` mean different things for
  `well_known_urls:`, the allowlists take arrays, and the pickers take real
  `true`/`false`. Written by hand, all three must be encoded correctly as
  text.
- **The defaults are set for you**, so your view names only the options you
  want to change.

## Rails apps: a minimal working example

Put this on any view — a fresh `pages/demo.html.erb` is fine:

```erb
<h1>Demo</h1>

<%= llm_meta_widget(llm_url:  "https://your-meta-server.example",
                    model:    "qwen3-6-35b-fast",
                    greeting: "Hi — ask me anything about this page.") %>
```

Start the app, open that page, and click the round toggle at the bottom right.
**Success looks like:** a panel opens showing your greeting, you type "hello",
the role label turns into a spinning gear reading "Working…", and the reply
streams in.

If the panel opens but nothing comes back, it is almost always CORS. The hub
must list your app's origin in its `CORS_ORIGINS` environment variable for
the `/api/*` resource, because the widget calls the hub **from the visitor's
browser**, not from your server. Open the browser console: a blocked request
says so explicitly.

Two more things worth knowing before you go further:

- `llm_url` must be reachable from your visitors' browsers, not just from
  your server. `localhost` works only while you are the visitor — which is
  fine when each visitor runs their own Ollama.
- The model name is the hub's name for it (`GET /api/llms` lists them), not
  the provider's.

Once that works, the widget can converse but cannot *do* anything. To let the
LLM act on your page or call your own services, declare tools using any of the
**three tool classes** below.

## Non-Rails hosts: write the element yourself

**If your app is Rails, you can skip this section.** The gem already does
everything described here: its helper writes this tag for you and its engine
sends this file. Read on if your app is not Rails — or if you use Rails but
prefer the CDN to the gem, which the `element_path:` option allows.

The widget is a custom element in a single self-contained ES module, so a host
that is not Rails needs no gem, no template engine and no asset pipeline — two
lines of HTML:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aibranch/llm-meta-widget@0.7"></script>
<llm-meta-widget llm-url="https://your-meta-server.example"
                 model="qwen3-6-35b-fast"
                 greeting="Hi — ask me anything about this page."></llm-meta-widget>
```

This is the same configuration as the Rails example above, written in HTML
instead of ERB. Both produce the same widget, so the advice in that section
— CORS, a reachable `llm_url`, the hub's name for the model — applies here
too.

Nothing else is needed: the stylesheets and the markdown renderer are bundled
in, and the element injects its own styles. The host serves no CSS and no JS.

Three ways to get that one file, in descending order of convenience:

- **the CDN**, as above — `@aibranch/llm-meta-widget` on npm, no path needed
  because the package's `main` is the bundle;
- **the gem**, which serves the identical file at
  `/llm_meta_widget_assets/llm-meta-widget.js` for Rails hosts, and is what the
  `llm_meta_widget` helper points at;
- **self-hosted** — copy it out of the package or the gem and serve it as a
  static asset, if you would rather not depend on a CDN.

Going without the gem removes the Rails pieces — the helper and the partial.
It does not remove your page's own contract, because those parts belong to the
page rather than to Rails: the `#ai-actions` JSON block, `window.aiState` and
`window.aiActions` are declared exactly as they are under Rails (see the three
tool classes below).

**Attributes** map one-to-one onto the helper's keyword options. Three are not
obvious and are the ones that bite:

| attribute | notes |
|---|---|
| `llm-url`, `model` | required |
| `tool-hub-url` | omit for no Class 1; `""` is the same as omitting |
| `llm-provider` | `llm_meta_server` (default) or `ollama` |
| `api-key-uuid`, `greeting`, `max-rounds` | as the helper options |
| `actions-schema-id`, `state-global`, `actions-global`, `remote-tools-schema-id` | as the helper options |
| `models`, `hub-tools` | comma-separated. Omitted **or empty** means no allowlist — an allowlist permitting nothing is never what anyone meant |
| `enable-model-picker`, `enable-tool-picker` | **value attributes, not boolean attributes.** They default to true, so presence cannot mean true. Disable with `enable-tool-picker="false"`; any other value is true |
| `well-known-urls` | **tri-state**, because an attribute cannot express nil-versus-empty: omitted = auto-discover same-origin `/.well-known/mcp.json`; `""` = discovery off; `"a,b"` = fetch those |

That last one is the quiet failure to watch for: expecting discovery off and
getting a same-origin fetch looks like nothing at all, except a 404 in the
console.

One widget per page. The panel uses fixed element ids, so a second
`<llm-meta-widget>` is ignored with a console warning rather than fighting the
first over every lookup.

**Building it.** `npm run build` bundles `element.js`, `config.js`,
`orchestrator.js`, the vendored `marked` and both stylesheets with esbuild. The
result is committed and shipped in the gem, because a gem cannot run a build
step on install — and `npm test` fails if the committed bundle has drifted from
its sources.

## Three tool classes

The widget classifies every tool_call the LLM emits by name and dispatches to one of three execution paths. Each class has a different declaration, different visibility to the LLM, and different execution semantics.

### Class 3 — Page-embedded actions (`window.aiActions`)

Declared inline on the same view as the widget. Runs as JavaScript in the browser — no HTTP hop, no server involvement. Best for actions that mutate the page's own state ("click this button", "add to selection", "scroll to X").

**Declaration** — three script blocks on the view:

```html
<!-- (a) Tool schemas the LLM sees. JSON Schema vocabulary — in practice
     type, properties, required, description, items, enum. No $schema is
     declared and nothing here validates one: the object is forwarded to
     the provider as-is, and each provider accepts its own subset. -->
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
<!--     Each reader declares what it returns, like every other channel. -->
<script>
  window.aiState = {
    text: {
      description: "the text the user wants to annotate",
      read: function() { return $("#text").val() || ""; }
    },
    selected_dictionaries: {
      description: "the dictionaries the user has chosen for annotation",
      read: function() { return getSelected(); }
    }
  };
</script>

<!-- (c) Action implementations invoked when the LLM emits a matching tool_call. -->
<script>
  window.aiActions = {
    add_dictionaries: function(args) { /* mutate the page here */ }
  };
</script>
```

**What the LLM sees.** The `ai-actions` JSON is passed to the meta-server as `local_tools` for every turn. Alongside it, every reader in `window.aiState` is invoked (each turn) and rendered into a `Current page state:` block appended to the system prompt, one line per reader, with its description beside its value:

```
Current page state:
- text (the text the user wants to annotate): "The stomach was examined."
- selected_dictionaries (the dictionaries the user has chosen for annotation): ["uberon"]
```

So the LLM can answer from state directly instead of tool-calling for lookups, and knows what each value *means* rather than guessing from the key.

**Breaking change in 0.8.0.** A reader must be `{ description, read }`. The bare-function form — `text: function() {…}` — is removed, with no fallback. A key that still uses it is reported to the console by name, with the shape it should have, and skipped; the page's other readers keep working. Descriptions are not decoration: every other channel the widget declares to the model already carries one (Class 3 tool schemas, Class 2 `.well-known` tools, Class 1 hub tools, resources), and state readers were the exception.

**When the tool_call fires.** During the turn, as soon as the LLM emits the
call. Since 0.4.0 the action's outcome — `{ok: true, applied: "<name>"}`, or
the error message if it raised — is fed back to the LLM as a tool result, and
the turn continues. Before 0.4.0 these were fire-and-forget, which meant a
turn whose only calls were page actions ended there: any task shaped *change
the page, then do something with it* was cut off after the write. The change
also means the LLM can see that an action failed and correct itself, instead
of the failure being visible only to the visitor.

Budget for it: every page action now costs a round, so a flow that writes twice
and then calls a tool needs roughly five or six. See `max_rounds:` below.

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

**What the LLM sees.** Only tools the visitor has **enabled via the tool picker** (see "Level-1 pickers" below) — nothing is auto-selected, the visitor opts in per session. A page can set the starting selection instead, with `remote_tools_schema_id:`: those tools arrive already ticked, and the visitor can still untick them.

**When the tool_call fires.** Synchronously during the turn — widget POSTs to the hub's `/api/llm_api_keys/:uuid/models/:name/single_llm_calls` endpoint with `tool_ids: [...]`; the hub proxies to each MCP server and streams results back through SSE.

**Error path.** Hub-side errors (rate limit, timeout, MCP server unavailable, upstream failure) arrive as SSE `event: error` frames with typed codes (`mcp_unavailable`, `timeout`, `rate_limit`, …); the widget surfaces them in the message bubble with a per-code prefix.

## Level-1 pickers

By default the widget renders two pickers below the input textarea:

- **Model dropdown** — populated from the hub's `GET /api/llms` (anon path returns Ollama-only, since the widget's LLM calls use `api_key_uuid: "ollama-local"`).
- **Tool picker** — populated from the hub's `GET /api/mcp_servers` (anon path returns `public_to_anonymous: true` servers). Two-level UX: server bulk-toggle + individual tool checkboxes on expand.

Both pickers require **CORS**, the same way the chat itself does: the hub must list your page's origin in its `CORS_ORIGINS` environment variable for the `/api/*` resource. Without that the fetches are blocked silently and both pickers simply stay empty.

To adjust picker behavior at the helper call site:

```erb
<%= llm_meta_widget(
      llm_url:             "https://your-meta-server.example",
      tool_hub_url:        "https://your-meta-server.example",
      model:               "qwen3-6-35b-fast",   # initial selection
      enable_model_picker: true,                 # false → omit picker, use fixed `model:`
      enable_tool_picker:  true,                 # false → omit picker, no Class-1 tools
      models:              nil,                  # nil = all anon models; ["qwen3-6-35b-fast", …] = allowlist
      hub_tools:           nil                   # nil = all anon-public MCPs; ["togomcp", …] = allowlist by server name
    ) %>
```

To lock the widget to the fixed `model:` prop and disable Class-1 tools entirely (level-0 mode — Class 2 & 3 still work):

```erb
<%= llm_meta_widget(llm_url: "…", model: "…",
                    enable_model_picker: false,
                    enable_tool_picker:  false) %>
```

## All helper options

These are the gem helper's keyword options. If you write the element by hand,
each one has an attribute of the same name in kebab-case — `llm_url:` becomes
`llm-url`, and so on. The attribute table above lists the few that do not
translate directly.

| Option | Default | Purpose |
|---|---|---|
| `llm_url:` | required | Who answers the chat — an llm_meta_server, or an Ollama |
| `llm_provider:` | `:llm_meta_server` | What `llm_url` speaks. `:ollama` talks to Ollama's `/api/chat` directly |
| `tool_hub_url:` | `nil` | An llm_meta_server whose registered MCP tools to offer. Absent = none (page actions and your own `.well-known` MCP are unaffected) |
| `model:` | required | Initial model (also the fallback when picker is disabled) |
| `api_key_uuid:` | `"ollama-local"` | Hub API-key uuid to invoke |
| `element_path:` | `"/llm_meta_widget_assets/llm-meta-widget.js"` | The bundled element the page loads. Served by the gem's engine; override to load it from elsewhere |
| `actions_schema_id:` | `"ai-actions"` | DOM id of the Class-3 schema block |
| `state_global:` | `"aiState"` | Global window object holding Class-3 state readers, each `{ description, read }` (see the breaking change in 0.8.0) |
| `actions_global:` | `"aiActions"` | Global window object holding Class-3 implementations |
| `remote_tools_schema_id:` | `"remote-mcp-tools"` | DOM id of a JSON block listing Class-1 tools (`{id, name, description, input_schema}`) to start with. They seed the picker rather than bypassing it — shown ticked, and the visitor may untick them. Read once, at boot |
| `well_known_urls:` | `nil` | `nil` = auto-discover same-origin; explicit array = fetch those; `[]` = disable |
| `greeting:` | `nil` | First thing a visitor sees when the panel opens, above the offered prompt templates. `nil` = a generic line |
| `max_rounds:` | `3` | Cap on tool-call rounds per LLM turn. Page actions cost a round each since 0.4.0 — raise it for multi-step flows |
| `enable_model_picker:` | `true` | Show model dropdown (Level-1). `false` removes it from the DOM |
| `enable_tool_picker:` | `true` | Show tool picker (Level-1). `false` removes it from the DOM |
| `models:` | `nil` | Model-name allowlist; `nil` = all anon-available |
| `hub_tools:` | `nil` | MCP-server-name allowlist; `nil` = all anon-public |

## Surviving navigation

A page action that navigates — submitting a form, following a link — no longer
loses the conversation. The transcript, the record of which tools ran, and the
model's own context are kept in `sessionStorage`: per tab, gone when the tab
closes, never sent anywhere.

The key is the page's **path**, not its full URL, so a form submit that returns
to the same page with a new query string keeps the thread, while moving to a
different page starts a fresh one. Nothing to configure.

Two consequences worth knowing. An action of yours that navigates is now safe
to declare — before this, offering one meant offering to wipe the visitor's
chat. And if the navigation lands on an error page that does not render the
widget, the conversation is still in storage but there is no panel to show it
until the visitor returns to a page that has one.

## Choosing what answers the chat, and whose tools to offer

Two independent settings, because they are two jobs. Neither implies the
other, so there is nothing to disable and nothing to inherit — what a widget
does is what its call site says.

```erb
<%# a hub answers the chat; its registered tools are offered too %>
<% hub = "https://your-meta-server.example" %>
<%= llm_meta_widget(llm_url: hub, tool_hub_url: hub, model: "qwen3-6-35b-fast") %>

<%# a hub answers the chat; no hub-registered tools %>
<%= llm_meta_widget(llm_url: hub, model: "qwen3-6-35b-fast") %>

<%# the visitor's own Ollama answers; a hub still supplies its tools %>
<%= llm_meta_widget(llm_url: "http://localhost:11434", llm_provider: :ollama,
                    tool_hub_url: hub, model: "qwen3.8:27b") %>

<%# nothing of ours in the path at all %>
<%= llm_meta_widget(llm_url: "http://localhost:11434", llm_provider: :ollama,
                    model: "qwen3.8:27b") %>
```

**The Ollama path.** The widget POSTs to `{llm_url}/api/chat` and reads
Ollama's NDJSON stream; tool schemas go over as OpenAI-shaped functions and
`tool_calls` come back, so Class 2 and Class 3 tools work exactly as they do
against a hub. The model picker lists `{llm_url}/api/tags`. Ollama must be
told to accept your page's origin — `OLLAMA_ORIGINS=https://your-site.example`
— which is the same CORS story as the hub, configured elsewhere.

What you give up without a `tool_hub_url` is Class 1 only: tools registered on
somebody's hub. That is not "no tools" — page actions and your own
`.well-known/mcp.json` are untouched, and they are the interesting ones for an
assistant embedded in your page.

**Why anyone would want the last shape:** with a local Ollama and local MCP
endpoints, nothing a visitor types leaves the machine. No credentials to hold,
no retention policy to write.

## Declaring resources and prompts (static-primitives extension)

If you operate the MCP endpoint behind your `.well-known/mcp.json`, you can
also offer **prompts** (one-click starting points, shown as buttons above the
input) and **resources** (reference data the widget can put in the model's
context). The widget reads two optional fields the
`io.modelcontextprotocol/static-primitives` extension defines on a
`resources/list` entry:

```json
{
  "uri": "yourhost://catalog",
  "name": "Catalog",
  "mimeType": "application/json",
  "_meta": {
    "io.modelcontextprotocol/static-primitives": {
      "sizeBytes": 1298,
      "volatility": "stable",
      "autoAttach": true
    }
  }
}
```

- **`sizeBytes`** — the byte length of the payload `resources/read` returns.
  The widget decides whether it can afford the resource *before* fetching it;
  over its budget (8 KB), the bytes never cross the wire and the LLM is left
  to ask for what it needs through your tools instead.
- **`volatility`** — `"stable"` (read once, re-used) or `"volatile"` (re-read
  on every turn that uses it).
- **`autoAttach`** — may the widget put this in the model's context without
  the visitor asking?

All three are optional. A server that declares none behaves exactly as one
that predates the extension: the resource is fetched, trimmed to budget and
carried in the model's context.

A prompt is offered as a button labelled by its `title`. Declare its arguments
as **optional** and fill them from page state where you can: an argument the
visitor must supply by hand makes the button useless to the visitor who needed
it most, since they must already know your form to press it.

## Further reading

- **The static-primitives extension** — `io.modelcontextprotocol/static-primitives`,
  a follow-on to [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol)
  (Server Cards). The fields above are a reference implementation of its
  current draft shape.
- **MCP itself** — <https://modelcontextprotocol.io>
- **A worked adopter** — PubDictionaries' annotation page
  (<https://pubdictionaries.org/text_annotation>) runs this widget with all
  three tool classes plus prompts and resources. Its
  `app/views/annotation/text_annotation.html.erb` and `app/controllers/mcp_controller.rb`
  are the fullest example available.
- **Shipping the element** — `docs/custom-element-distribution.md` is the design note
  behind the custom-element move: the npm package and its CDN URL, why `main`,
  `exports` and `sideEffects` are set the way they are, and why the gem and the npm
  package must never drift in version.
- **A page you can run** — `examples/connection-test.html` checks every call the
  widget makes to a hub, one at a time, then mounts the widget with a tool
  already selected. Serve it from an origin the hub allows and open it: if
  something in the chain is wrong, it names which step.
- **Issues and questions** — <https://github.com/jdkim/llm_meta_widget/issues>

## License

Apache-2.0.
