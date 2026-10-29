# llm_meta_widget

Embeddable browser chat widget for the [llm_meta](https://github.com/pubannotation) ecosystem.

The browser does the orchestrating. At boot the widget reads the tools your page
declares and any `.well-known/mcp.json` your host publishes. When the model calls
a tool, the widget runs it: in the page itself, or against an MCP endpoint
directly. Only the chat goes through the meta-server, over SSE.

It ships as a custom element in one self-contained ES module. The same file is on
npm for any host, and in a Rails gem whose helper serves it for you.

**No** Devise, DB migrations, ChatManager, or PromptNavigator. The gem adds only `rails >= 8.0` as a runtime dep — so hosts that haven't bumped to 8.1 can adopt it without a Rails upgrade — and hosts that do not use Rails do not need the gem.

## Requirement

The widget is a browser front end: it needs something to answer the chat. One
option is **[llm_meta_server](https://github.com/pubannotation)**, a hub that
holds provider credentials and streams responses back. The other is **an
Ollama**, which the widget talks to directly, with no server component of ours
in between.

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

Nothing is required of your server: the widget runs in the browser, and your
page only has to send the file and write one tag. The Rails gem is one
convenient way to do that, not a requirement — it needs Ruby >= 3.2 and
Rails >= 8.0, and only if you choose it.

## Installation — choose one

You need only one. Find the row whose condition matches your app, then read only
that option's section.

| Option | Use it when | What you do |
|---|---|---|
| **gem** | your app is Rails | add one line to your `Gemfile`, then make one helper call in a view. The helper writes the `<llm-meta-widget>` tag for you, so you never write that tag yourself |
| **npm** | your app already builds JavaScript — Vite, webpack, esbuild, Next.js… | install the package, import it once at your entry point, and write the `<llm-meta-widget>` tag yourself |
| **CDN** | neither of the above applies — Python, Go, PHP, plain HTML… | add one `<script>` tag and write the `<llm-meta-widget>` tag yourself. No install, no build step |

All three load the same file and run the same widget. The first two pin the
version for you — Bundler for the gem, your lockfile for npm — which is why they
come first here. The CDN pins only a range written into a URL, so the last row
trades that check for needing nothing installed.

## Option 1. gem (when your app is Rails)

**Not using Rails?** Skip to Option 2 if your app builds JavaScript, or to
Option 3 if it does not.

```ruby
# Gemfile
gem "llm_meta_widget", "~> 0.15.2"
```

```bash
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

### A minimal working example for Rails apps

Put this on any view — a fresh `pages/demo.html.erb` is fine:

```erb
<h1>Demo</h1>

<%= llm_meta_widget(llm_url:  "https://your-meta-server.example",
                    model:    "gpt-oss-120b",
                    greeting: "Hi — ask me anything about this page.") %>
```

Start the app, open that page, and click the round toggle at the bottom right.
What success looks like, and what to check when nothing comes back, is in
"When it does not answer" below — the causes are the same for every route.

Once that works, the widget can talk, but it cannot *do* anything yet. To let the
LLM act on your page or call your own services, declare tools using any of the
**three tool classes** below.

## Option 2. npm (if you bundle your JavaScript)

Vite, webpack, esbuild, Next.js, SvelteKit, Astro — if your app already builds
JavaScript, take the widget as a dependency rather than a script tag:

```bash
npm install @aibranch/llm-meta-widget
```

```js
// Once, at your app's entry point. Importing the package is all you need: it
// defines the custom element. There is no function to call and nothing to name.
import "@aibranch/llm-meta-widget";
```

Then write the `<llm-meta-widget>` tag yourself — see "Writing the element
yourself" below for the tag and its attributes.

**Why do this, when the script tag is only one line?** Because your build then
checks the version for you. The version is pinned in your lockfile and installed by `npm ci`
with integrity checking, so you know which widget your page runs and your
colleague's build runs the same one. On the CDN path the version lives in a URL
that nothing checks. That matters most at a breaking release: 0.8.0 changed the
shape of `window.aiState`, and a lockfile makes the upgrade a deliberate, visible
step instead of a URL someone edits.

The only cost is that this path needs a build pipeline. If your app does not
build JavaScript, the CDN route below needs none.

## Option 3. CDN

This is the shortest route and it works anywhere — Python, Go, PHP, plain
HTML, or Rails if you would rather not add the gem (the `element_path:` option
allows that). It needs no install, no build step and no Node at runtime.

The widget is a custom element in a single self-contained ES module, so the
whole integration is two lines of HTML:

```html
<script type="module" src="https://cdn.jsdelivr.net/npm/@aibranch/llm-meta-widget@0.15"></script>
<llm-meta-widget llm-url="https://your-meta-server.example"
                 model="gpt-oss-120b"
                 greeting="Hi — ask me anything about this page."></llm-meta-widget>
```

**`@0.15` is a version range, and it stops at 0.15.x on purpose.** You receive
bug fixes without editing your page, and a release that breaks your page cannot
arrive on its own.

Moving to 0.16 is therefore a change you make yourself. Read
[CHANGELOG.md](CHANGELOG.md) before you do, because this is where what your page
must provide can change. For example, 0.10.0 changed how the widget finds a page
card: by media type rather than by element id. A page that declared its card the
new way while still loading `@0.9` lost every tool, prompt and resource it had
declared. Nothing failed, anywhere. The CHANGELOG entry for 0.10.0 describes it.

0.13.0 moved where a page declares its transport, and 0.14.0 stopped reading
the old spelling. Move your card to `transports` before taking 0.14.x.

A Rails app is protected from that mismatch, because the `Gemfile` will not
resolve a widget version the page cannot use. A page that loads the widget from
the CDN has no such check, so the version you write in that URL is the only
protection you have.

Nothing else is needed: the stylesheets and the markdown renderer are bundled
in, and the element injects its own styles. The host serves no CSS and no JS.

## Writing the element yourself

Both the npm and CDN routes end the same way: your page writes one
`<llm-meta-widget>` tag. This section is the reference for that tag, whichever
route brought you here. (Rails users can skip it — the helper writes the tag.)

The tag needs one file: the bundled custom element. Four ways to get it, in
descending order of convenience:

- **the CDN** — `@aibranch/llm-meta-widget` on npm, no path needed because the
  package's `main` is the bundle;
- **npm install plus your own bundler** — the same package, resolved through
  `exports` and pinned by your lockfile;
- **the gem**, which serves the identical file at
  `/llm_meta_widget_assets/llm-meta-widget.js` for Rails hosts, and is what the
  `llm_meta_widget` helper points at;
- **self-hosted** — copy it out of the package or the gem and serve it as a
  static asset, if you would rather not depend on a CDN.

Going without the gem removes the Rails parts: the helper and the partial. It
does not change what your page itself must provide, because those parts belong to
the page, not to Rails. You declare the page card and its handler maps exactly as
a Rails page does — see the three tool classes below.

**Attributes** match the helper's keyword options one to one. Three of them are
easy to get wrong:

| attribute | notes |
|---|---|
| `llm-url`, `model` | required |
| `tool-hub-url` | omit for no Class 1; `""` is the same as omitting |
| `llm-provider` | `llm_meta_server` (default) or `ollama` |
| `api-key-uuid`, `greeting`, `max-rounds` | as the helper options |
| `actions-schema-id`, `state-global`, `actions-global`, `remote-tools-schema-id` | as the helper options |
| `page-card-id`, `prompts-global`, `resources-global` | as the helper options |
| `models`, `hub-tools` | comma-separated. Omitted **or empty** means no allowlist — an allowlist permitting nothing is never what anyone meant |
| `enable-model-picker`, `enable-tool-picker` | **value attributes, not boolean attributes.** They default to true, so presence cannot mean true. Disable with `enable-tool-picker="false"`; any other value is true |
| `well-known-urls` | **Three different states**, because an attribute cannot tell "not set" from "set to empty": omitted = auto-discover same-origin `/.well-known/mcp.json`; `""` = discovery off; `"a,b"` = fetch those |

The last one fails quietly. If you expect discovery to be off but leave the
attribute out, the widget fetches your own origin instead. Nothing appears to
happen, except a 404 in the browser console.

One widget per page. The panel uses fixed element ids, so a second
`<llm-meta-widget>` is ignored with a console warning rather than fighting the
first over every lookup.

**Building it.** `npm run build` bundles `element.js`, `config.js`,
`orchestrator.js`, the vendored `marked` and both stylesheets with esbuild. The
result is committed and shipped in the gem, because a gem cannot run a build
step on install — and `npm test` fails if the committed bundle has drifted from
its sources.

## When it does not answer

**Success looks like this:** the panel opens showing your greeting, you type
"hello", the role label turns into a spinning gear reading "Working…", and the
reply streams in.

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

## Three tool classes

The widget classifies every tool_call the LLM emits by name and dispatches to one of three execution paths. Each class has a different declaration, different visibility to the LLM, and different execution semantics.

### Class 3 — Page-embedded primitives (the page card)

Declared inline on the same view as the widget. Runs as JavaScript in the browser — no HTTP hop, no server involvement. Best for actions that mutate the page's own state ("click this button", "add to selection", "scroll to X").

The same block declares the page's other primitives too: resources, which are what the model may read from the page, and prompts, which are templates the visitor can run. So everything the page offers is in one place, and each kind has one handler map.

**Declaration — the page card.** The page declares what it offers in one block
of JSON, found by its media type, and implements it in one handler map per
primitive type:

```html
<script type="application/mcp-static-primitives+json">
{
  "name": "org.example/your-page",
  "_meta": { "io.modelcontextprotocol/static-primitives": {
    "transports": [ { "type": "page-global", "global": "mcp" } ],
    "tools": [
      { "name": "add_dictionaries",
        "description": "Add the named dictionaries to the current selection.",
        "inputSchema": {
          "type": "object",
          "properties": { "names": { "type": "array", "items": { "type": "string" } } },
          "required": [ "names" ] } }
    ],
    "resources": [
      { "uri": "page:selected_dictionaries",
        "name": "Selected dictionaries",
        "description": "the dictionaries the user has chosen for annotation",
        "volatility": "volatile" }
    ]
  } }
}
</script>

<script>
  // The card named this global; each map inside it is keyed by the identifier
  // its own MCP operation takes — a tool by name, a resource by uri.
  window.mcp = {
    tools:     { add_dictionaries: function (args) { /* mutate the page */ } },
    resources: { "page:selected_dictionaries": function () { return getSelected(); } }
  };
</script>
```

A tool's schema may be spelled `inputSchema`, as MCP spells it, or
`input_schema`. Both are accepted.

`transports` is how a consumer other than this widget finds your handlers, so
the global is declared rather than assumed. It is a list, and the consumer uses
the first entry whose `type` it supports; `page-global` is the only type this
widget supports today. Leave `transports` out and the widget reads
`window.aiActions`, `window.aiPrompts` and `window.aiResources` instead — see
"Say where your handlers live".

Widgets from 0.11.1 to 0.12.2 read this declaration from a `remotes` list at the
top level of the card, and 0.13.x read either spelling. From 0.14.0 the old one
is not read at all: a card that still carries it gets no handlers, and the
widget reports that in the browser console. Write `transports`.

A page may declare `prompts` in the same block. See [The page card](#the-page-card)
for prompts, for the size and volatility hints on a resource, and for what
happens when a document holds several blocks.

**What the LLM sees.** Declared tools are passed to the meta-server as
`local_tools` for every turn. Every declared resource is read and rendered into
the `Current page state:` block of the system prompt, one line per resource,
with its description beside its value:

```
Current page state:
- Selected dictionaries (the dictionaries the user has chosen for annotation): ["uberon"]
```

So the LLM can answer from page state directly instead of tool-calling for a
lookup, and it knows what each value *means* rather than guessing from a key.
A resource marked `"volatility": "volatile"` is re-read every turn, which is
what a form field needs: a value read once at boot is already stale by the time
anyone sends a message.

**The older channels — `#ai-actions` and `window.aiState`.** These came before
the page card and still work. A page that declares no card, or a card with no
`tools`, falls back to them. Use them if you have them already; use the card for
a new page, because it is the only channel that can also declare prompts and
resources.

```html
<!-- Tool schemas. Note input_schema, not inputSchema, in this channel. -->
<script type="application/json" id="ai-actions">
[
  { "name": "add_dictionaries",
    "description": "Add the named dictionaries to the current selection.",
    "input_schema": {
      "type": "object",
      "properties": { "names": { "type": "array", "items": { "type": "string" } } },
      "required": [ "names" ]
    } }
]
</script>

<!-- State readers, folded into the system prompt every turn. -->
<script>
  window.aiState = {
    text: {
      description: "the text the user wants to annotate",
      read: function() { return $("#text").val() || ""; }
    }
  };
</script>

<!-- Action implementations. The card uses this same map. -->
<script>
  window.aiActions = {
    add_dictionaries: function(args) { /* mutate the page here */ }
  };
</script>
```

Where both a card and these blocks exist, the card's `tools` replace the
`#ai-actions` block. They are not merged. Two sources for one list would leave a
reader guessing which one the page meant. For the same reason, an explicit
`window.aiState` entry is used in place of a page resource of the same name.

**Breaking change in 0.8.0.** An `aiState` reader must be
`{ description, read }`. The bare-function form — `text: function() {…}` — is
removed, with no fallback. A key that still uses it is reported to the console by
name, with the shape it should have, and skipped; the page's other readers keep
working. Descriptions are not decoration: every other channel the widget
declares to the model already carries one, and state readers were the exception.

**When the tool_call fires.** During the turn, as soon as the LLM emits the
call. Since 0.4.0 the action's result is given back to the model and the turn
continues. The result is `{ok: true, applied: "<name>"}`, or the error message
if the action raised one.

Before 0.4.0 the widget did not wait for that result. A turn whose only calls
were page actions therefore ended at the write, and a task of the form *change
the page, then do something with it* stopped half way. The model can now also
see that an action failed and correct itself, instead of the failure being
visible only to the visitor.

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

**What the LLM sees.** Every tool listed in every discovered manifest is offered to the model. Names must be unique across manifests. If two classes declare the same name, the widget uses Class 3 first, then Class 2, then Class 1.

**When the tool_call fires.** During the turn. The widget POSTs `{ jsonrpc, method: "tools/call", params: { name, arguments } }` to the tool's URL and waits for the JSON-RPC response. It then gives the result to the model as tool output for the next round. This is the standard MCP loop.

**Error path.** An HTTP 4xx or 5xx, a network failure, or an MCP JSON-RPC error all count as a failed call. The visitor sees a red chip in the message footer. The model receives the error as the tool's return value, so it can explain what went wrong instead of pretending the call worked.

### Class 1 — Hub-registered MCP (via the meta-server)

Declared out-of-band on the meta-server (via the hub's admin UI or `/user/:id/mcp_servers` API). The widget doesn't own these — they're a shared pool visible across all consumers of the hub. Suited for third-party MCP servers (PubDictionaries, TogoMCP, Brave Search, …) that a single visitor might want to pick and choose from.

**Declaration.** No widget-side change. Register the server on the hub → flip `public: true` (visible to signed-in users) and optionally `public_to_anonymous: true` (visible to widget visitors without a login). See the meta-server's `Api::McpServersController`.

**What the LLM sees.** Only tools the visitor has **enabled via the tool picker** (see "Level-1 pickers" below) — nothing is auto-selected, the visitor opts in per session. A page can set the starting selection instead, with `remote_tools_schema_id:`: those tools arrive already ticked, and the visitor can still untick them.

**When the tool_call fires.** During the turn. The widget POSTs to the hub's `/api/llm_api_keys/:uuid/models/:name/single_llm_calls` endpoint with `tool_ids: [...]`. The hub calls each MCP server and streams the results back over SSE.

**Error path.** Errors from the hub arrive as SSE `event: error` frames, each with a code such as `mcp_unavailable`, `timeout` or `rate_limit`. They cover a rate limit, a timeout, an MCP server that is unavailable, and a failure further upstream. The widget shows each one in the message bubble, with a prefix for its code.

## Level-1 pickers

By default the widget renders two pickers below the input textarea:

- **Model dropdown** — populated from the hub's `GET /api/llms`. The anonymous path returns every model the hub serves free, which may include hosted ones, not only a local Ollama.
- **Tool picker** — populated from the hub's `GET /api/mcp_servers` (anon path returns `public_to_anonymous: true` servers). Two-level UX: server bulk-toggle + individual tool checkboxes on expand.

Both pickers require **CORS**, the same way the chat itself does: the hub must list your page's origin in its `CORS_ORIGINS` environment variable for the `/api/*` resource. Without that the fetches are blocked silently and both pickers simply stay empty.

To adjust picker behavior at the helper call site:

```erb
<%= llm_meta_widget(
      llm_url:             "https://your-meta-server.example",
      tool_hub_url:        "https://your-meta-server.example",
      model:               "gpt-oss-120b",   # initial selection
      enable_model_picker: true,                 # false → omit picker, use fixed `model:`
      enable_tool_picker:  true,                 # false → omit picker, no Class-1 tools
      models:              nil,                  # nil = all anon models; ["gpt-oss-120b", …] = allowlist
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
| `actions_schema_id:` | `"ai-actions"` | DOM id of the older Class-3 schema block, used when the page declares no card tools |
| `page_card_id:` | `"ai-page"` | **Fallback only.** A card is normally found by its media type (see "The page card"); this id is read when the page has no block with that type. Its tools replace the `actions_schema_id` block |
| `prompts_global:` | `"aiPrompts"` | Global object holding page prompt handlers, keyed by prompt name |
| `resources_global:` | `"aiResources"` | Global object holding page resource readers, keyed by resource URI |
| `state_global:` | `"aiState"` | Global holding the older Class-3 state readers, each `{ description, read }` (see the breaking change in 0.8.0). A page card declares state as resources instead |
| `actions_global:` | `"aiActions"` | Global window object holding Class-3 implementations |
| `remote_tools_schema_id:` | `"remote-mcp-tools"` | DOM id of a JSON block listing Class-1 tools (`{id, name, description, input_schema}`) to start with. They seed the picker rather than bypassing it — shown ticked, and the visitor may untick them. Read once, at boot |
| `well_known_urls:` | `nil` | `nil` = auto-discover same-origin; explicit array = fetch those; `[]` = disable |
| `greeting:` | `nil` | First thing a visitor sees when the panel opens, above the offered prompt templates. `nil` = a generic line |
| `max_rounds:` | `3` | Cap on tool-call rounds per LLM turn. Page actions cost a round each since 0.4.0 — raise it for multi-step flows |
| `enable_model_picker:` | `true` | Show model dropdown (Level-1). `false` removes it from the DOM |
| `enable_tool_picker:` | `true` | Show tool picker (Level-1). `false` removes it from the DOM |
| `models:` | `nil` | Model-name allowlist; `nil` = all anon-available |
| `hub_tools:` | `nil` | MCP-server-name allowlist; `nil` = all anon-public |

## The page card

Since 0.9.0 a page can declare what it offers in one block of JSON, instead of
using a separate channel for each kind of thing. **That block is a Server Card** —
the same document an MCP server publishes — whose transport is the page itself.
So the page and the server describe themselves in one format, and one parser
reads both.

Since 0.10.0 the block is found by its media type. Since 0.11.0 a page can also
name the global that holds its handlers. Both are below.

```html
<script type="application/mcp-static-primitives+json">
{
  "name": "org.example/your-page",
  "_meta": { "io.modelcontextprotocol/static-primitives": {
    "transports": [ { "type": "page-global", "global": "mcp" } ],
    "tools":     [ { "name": "set_text", "description": "…", "inputSchema": { } } ],
    "prompts":   [ { "name": "annotate", "description": "Annotate this page" } ],
    "resources": [ { "uri": "page:text", "name": "Text", "description": "the text to annotate",
                     "volatility": "volatile" } ]
  } }
}
</script>
```

`name` identifies the card, as it does for a server. `transports` says where
the handlers live — see "Say where your handlers live" below. Only the `_meta`
block is required by this widget; the rest is what makes the card readable by
anything else.

The card says what exists. Three maps say what it does, and each one is keyed by
the identifier that the matching MCP operation takes:

| declared in the card | implemented in | keyed by |
|---|---|---|
| `tools` | `tools` under your declared global, else `window.aiActions` | tool `name`, as `tools/call` takes |
| `prompts` | `prompts` under it, else `window.aiPrompts` | prompt `name`, as `prompts/get` takes |
| `resources` | `resources` under it, else `window.aiResources` | resource `uri`, as `resources/read` takes |

```js
window.mcp = {
  tools:     { set_text: (args) => { /* change the page */ } },
  prompts:   { annotate: (args) => "Annotate this: " + args.text },
  resources: { "page:text": () => document.querySelector("#text").value }
}
```

A prompt handler may return a plain string or the full `messages` array that
`prompts/get` returns. A resource reader may return a string or any value that
can be turned into JSON.

**Resources carry two optional hints.** `volatility` is `"volatile"` when the
value changes between turns, so the widget reads it again every turn; the default
is `"stable"`, which is read once and reused. `autoAttach: false` keeps a resource
out of the turn unless something asks for it. A `size` in bytes lets the widget
decide whether the value fits its budget before reading it.

**The `page:` scheme is experimental.** It is not a registered URI scheme, and
nothing outside this widget gives it meaning. It is used because the protocol
asks for a URI, and because `https://` is reserved for resources a client can
fetch from the web by itself — which page resources are not. The form is
`page:<name>` with no path, because a page has only one namespace. Expect this to
change.

**Say where your handlers live.** A card can declare the global that holds
them, the way a Server Card declares its endpoint. Then a consumer that has
never heard of this widget can read your card, find your handlers and call
them:

```html
<script type="application/mcp-static-primitives+json">
{ "name": "org.example/your-page",
  "_meta": { "io.modelcontextprotocol/static-primitives": {
    "transports": [ { "type": "page-global", "global": "mcp" } ], "tools": [ ... ] } } }
</script>
<script>
  window.mcp = {
    tools:     { set_text: function (args) { } },
    prompts:   { annotate: function (args) { return "..." } },
    resources: { "page:text": function () { return "..." } }
  };
</script>
```

The name is yours to choose, and it is declared rather than assumed: this code
runs on your page, where a short fixed name such as `mcp` could collide with
something of your own.

Without that declaration the widget reads `window.aiActions`,
`window.aiPrompts` and `window.aiResources`, as before. Those names are known
only to this widget, and they can be renamed per page with the options below,
so no other consumer can rely on them. Each kind falls back on its own, so you
can move tools into the declared global and leave prompts and resources where
they are.

**Script order does not matter.** The widget looks up your global at the moment
it needs a handler, not when it reads the card. The script that defines
`window.mcp` may therefore run before or after the widget loads: a `defer`
attribute, an ES module, or a `<script>` near the end of the page are all fine.
If a handler is wanted while the global is still undefined, the widget says so
in the browser console once, and falls back to the older globals for that call.

Before 0.15.0 the lookup happened once at startup, so a page whose handler
script ran later got no handlers at all for the rest of its life, with only a
console warning to say why. If you are pinned below 0.15.0, define your global
before the widget's own script tag.

**The card is found by its media type.** A client matches
`script[type="application/mcp-static-primitives+json"]`, so the element needs no
`id`. This is how a client that was never told about your page can still read
it, and it follows SEP-0000's "HTML-delivery mode". The `page_card_id:` option
is kept only for a host that cannot set the type; it is read when no block with
the media type is present.

**A document may hold several blocks.** A page built from components can let
each component declare its own primitives, and the arrays join by primitive
type. Declaring the same tool or prompt `name`, or the same resource `uri`,
twice is an error: every copy is dropped and a message is written to the
console. The first one does not win, because which block comes first depends on
the order the page's parts are rendered in, and that is not something the author
chose.

**The card is optional.** A page that declares nothing keeps working exactly as
before, and a page that declares no `tools` still uses its `ai-actions` block.

## Surviving navigation

A page action that navigates — submitting a form, following a link — no longer
loses the conversation. The transcript, the record of which tools ran, and the
model's own context are kept in `sessionStorage`: per tab, gone when the tab
closes, never sent anywhere.

The key is the page's **path**, not its full URL. A form submit that returns to
the same page with a new query string therefore keeps the same conversation.
Moving to a different page starts a new one. There is nothing to configure.

Two consequences worth knowing. An action of yours that navigates is now safe
to declare — before this, offering one meant offering to wipe the visitor's
chat. And if the navigation lands on an error page that renders no widget, the
conversation is still in storage. There is no panel to show it until the visitor
returns to a page that has one.

## Choosing what answers the chat, and whose tools to offer

Two independent settings, because they are two jobs. Neither implies the
other, so there is nothing to disable and nothing to inherit — what a widget
does is what its call site says.

```erb
<%# a hub answers the chat; its registered tools are offered too %>
<% hub = "https://your-meta-server.example" %>
<%= llm_meta_widget(llm_url: hub, tool_hub_url: hub, model: "gpt-oss-120b") %>

<%# a hub answers the chat; no hub-registered tools %>
<%= llm_meta_widget(llm_url: hub, model: "gpt-oss-120b") %>

<%# the visitor's own Ollama answers; a hub still supplies its tools %>
<%= llm_meta_widget(llm_url: "http://localhost:11434", llm_provider: :ollama,
                    tool_hub_url: hub, model: "qwen3.8:27b") %>

<%# nothing of ours in the path at all %>
<%= llm_meta_widget(llm_url: "http://localhost:11434", llm_provider: :ollama,
                    model: "qwen3.8:27b") %>
```

**The Ollama path.** The widget POSTs to `{llm_url}/api/chat` and reads Ollama's
NDJSON stream. Tool schemas are sent in OpenAI's shape, and `tool_calls` come
back the same way, so Class 2 and Class 3 tools work exactly as they do against
a hub. The model picker lists `{llm_url}/api/tags`.

Ollama must be told to accept your page's origin:
`OLLAMA_ORIGINS=https://your-site.example`. This is the same CORS requirement
as the hub has, set in a different place.

What you give up without a `tool_hub_url` is Class 1 only: tools registered on
somebody's hub. That is not "no tools" — page actions and your own
`.well-known/mcp.json` are untouched, and they are the interesting ones for an
assistant embedded in your page.

**Why anyone would want the last shape:** with a local Ollama and local MCP
endpoints, nothing a visitor types leaves the machine. No credentials to hold,
no retention policy to write.

## Declaring resources and prompts (static-primitives extension)

If you operate the MCP endpoint behind your `.well-known/mcp.json`, you can
offer two more things. **Prompts** are one-click starting points, shown as
buttons above the input. **Resources** are reference data the widget can put in
the model's context. The widget reads two optional fields the
`io.modelcontextprotocol/static-primitives` extension defines on a
`resources/list` entry:

```json
{
  "uri": "yourhost://catalog",
  "name": "Catalog",
  "mimeType": "application/json",
  "size": 1298,
  "_meta": {
    "io.modelcontextprotocol/static-primitives": {
      "volatility": "stable",
      "autoAttach": true
    }
  }
}
```

- **`size`** — the byte length of the payload `resources/read` returns. It is the
  base MCP `Resource` field, not an extension field, so it sits at the top level
  of the entry. Earlier versions of the extension carried `sizeBytes` inside
  `_meta`; the widget still reads that when `size` is absent, but it will be
  removed, so emit `size`.
  The widget decides whether it can afford the resource *before* fetching it. If
  the resource is over that budget, the bytes never cross the wire, and the LLM
  asks for what it needs through your tools instead.
  The budget is a share of the model's own context window, which the widget
  reads from the hub: about 8 KB for a 32,000-token model, about 32 KB for a
  128,000-token one, and at most 64 KB. When the hub does not report a window,
  the budget is 8 KB.
- **`volatility`** — `"stable"` (read once, re-used) or `"volatile"` (re-read
  on every turn that uses it).
- **`autoAttach`** — may the widget put this in the model's context without
  the visitor asking?

All three are optional. A server that declares none behaves exactly as one
that predates the extension: the resource is fetched, trimmed to budget and
carried in the model's context.

A prompt is offered as a button labelled by its `title`. Declare its arguments
as **optional**, and fill them from page state where you can. An argument the
visitor must type in makes the button useless to the visitor who needed it most:
to press it, they would already have to know your form.

## When a turn does not fit the model's context

A model holds a fixed number of tokens. A long conversation, a large reference
resource and a few big tool results can exceed it, and the provider then refuses
the whole turn. The widget tries to keep a turn inside the limit instead, and
tells the reader whenever it has to change something. You do not configure any
of this, but your page's visitors will see the messages, so it is worth knowing
what they mean.

The widget learns each model's context window from the server's model list. If
the server does not report one, none of the behaviour below applies and the turn
is sent as it is.

**One oversized tool result is shortened.** A single result may use at most 40%
of the window. A larger one is cut to that size, and the model is told in the
result itself how much was shown and that it can call the tool again with a
narrower query. The panel says, for example:

> Shortened an oversized togovar_search_variant result to fit the context:
> 121,000 tokens, where one result may use at most 51,000. Ask again with a
> narrower question for the complete result.

**Older tool results are given up when the whole turn is too long.** This is for
a conversation that has grown over many turns, not for one large result. The
oldest results go first, one at a time, until the turn fits. The questions, the
answers and the model's own summaries of what it read are never touched, and a
dropped result leaves a note in its place so the model knows to ask again.

**A reference resource that does not fit is not attached.** Each turn may carry
about 6% of the window as reference data — roughly 8 KB for a 32,000-token model
and 32 KB for a 128,000-token one. A resource larger than that is not fetched at
all, and the panel says so, naming the resource and both figures. The model is
not told, because it cannot fetch a resource itself; the reader can act, by
choosing a model with a larger window or asking you for a smaller resource.

If you publish a large document through MCP, consider offering it in sections
behind one tool that takes a section name, rather than as a single tool result.
The list of section names in the tool's own schema costs a few hundred tokens
and is visible to every client, while a document of tens of kilobytes crowds out
the conversation it is supposed to support.

## Further reading

- **The static-primitives extension** — `io.modelcontextprotocol/static-primitives`,
  a follow-on to [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol)
  (Server Cards). The fields above are a reference implementation of its
  current draft shape.
- **MCP itself** — <https://modelcontextprotocol.io>
- **A worked adopter** — PubDictionaries' annotation page
  (<https://pubdictionaries.org/text_annotation>) runs this widget with all three
  tool classes, and declares its own tools, prompts and resources in one page
  card. Its
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
