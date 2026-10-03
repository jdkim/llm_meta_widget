# Design note — distributing the widget as a custom element

**Status:** implemented 2026-10-03 (same day), except for npm/CDN
publication, which needs an npm account. Written as a proposal; kept as the
record of why the shape is what it is.
**Problem owner:** adopters whose host application is not Rails.

**What landed, and what did not**

Landed: `element.js` (the panel, moved), `config.js` (attribute reading, with
the first unit tests the panel logic has ever had), `panel.css` (extracted),
`script/build.mjs` (esbuild bundle plus a staleness check that `npm test`
runs), a route and controller action serving the bundle, and the partial
reduced to the element tag. The gem keeps its helper signature, so
PubDictionaries needs no edit.

Not landed: the npm package and the CDN URL, so the two-line integration in
the example below currently means "load the file the gem serves, or
self-host it". Everything else about it is true today.

Verified on a plain HTML page served by `python3 -m http.server`, with no
Rails anywhere: the element upgrades and builds its own DOM, injects its own
styles (the host serves no stylesheet), keeps the floating `position: fixed`
geometry, reads its configuration from attributes, discovers hub-registered
tools cross-origin, and completes a real streamed turn against
`qwen3-8-27b-fast` that answers from the host page's own `aiState` reader.

Two findings worth keeping. The model picker reassigns `MODEL`
(`MODEL = modelPicker.value`), so the sixteen configuration values are bound
with `var` rather than destructured as `const` — the latter throws the moment
a visitor changes model, and nothing before the browser would catch it. And
the 985 lines of panel logic contain no ERB at all, which is why they moved
verbatim rather than being rewritten.

## Why

The widget is a Rails engine. Integration means `bundle add llm_meta_widget`, a
helper call that renders `app/views/llm_meta_widget/_chat_panel.html.erb`, and
engine-served routes under `/llm_meta_widget_assets/`. A host that is not Rails
can use none of that.

This stopped being hypothetical. The TogoMCP maintainer
(`togomcp.rdfportal.org`, Python/ASGI under uvicorn) wants the widget on their
front page, using hub-registered tools only. The options available today are all
bad: stand up a Rails front door beside their app, reimplement the panel
template in Jinja, or accept a hand-rendered HTML fragment plus three files
copied out of the gem — generated, unmaintained, and silently stale the moment
the gem moves.

## What the code actually is

Measured on the current panel partial, because it decides how big this job is:

| | |
|---|---|
| inline `<script>` | 1,454 lines |
| `<style>` | 360 lines |
| markup | **21 lines** |
| Rails helper calls | **1** (`orchestrator_path`) |
| `document.getElementById` | **4** |
| `document.createElement` | 35 (scope-independent) |

The panel is not a template that happens to contain script. It is a program
that happens to live in an `.erb` file. Everything Rails-specific is the one
helper call and ~15 `to_json` local injections. That makes this a packaging
change, not a port.

## Proposal

Ship the client as a **custom element** in a single bundled ES module, published
to npm and served from a CDN. Integration in any stack, or none:

```html
<script type="module"
        src="https://cdn.jsdelivr.net/npm/@aibranch/llm-meta-widget@0.7"></script>
<llm-meta-widget llm-url="https://hub.aibranch.org"
                 tool-hub-url="https://hub.aibranch.org"
                 model="qwen3-8-27b-fast"
                 hub-tools="TogoMCP"></llm-meta-widget>
```

The host serves no files and needs no CORS arrangement for the assets, because
jsdelivr serves them permissively. `orchestrator-path` disappears as an option:
the bundle is self-contained.

**Node's role is build and distribution, not integration.** esbuild bundles the
panel script, `orchestrator.js`, the vendored `marked`, and the CSS into one
module; npm plus a CDN ships it. npm alone would not help a Python host — a
Python project does not want a Node toolchain. The custom element is what makes
it framework-neutral.

## Attribute surface

Every current helper option maps to an attribute. Three cases need care.

| helper option | attribute | type |
|---|---|---|
| `llm_url:` | `llm-url` | string, required |
| `model:` | `model` | string, required |
| `tool_hub_url:` | `tool-hub-url` | string; absent = no Class 1 |
| `llm_provider:` | `llm-provider` | `llm_meta_server` \| `ollama` |
| `api_key_uuid:` | `api-key-uuid` | string |
| `greeting:` | `greeting` | string |
| `max_rounds:` | `max-rounds` | integer |
| `actions_schema_id:` | `actions-schema-id` | string |
| `state_global:` / `actions_global:` | `state-global` / `actions-global` | string |
| `remote_tools_schema_id:` | `remote-tools-schema-id` | string |
| `models:` / `hub_tools:` | `models` / `hub-tools` | comma-separated; absent = no allowlist |
| `enable_model_picker:` / `enable_tool_picker:` | `enable-model-picker` / `enable-tool-picker` | **see below** |
| `well_known_urls:` | `well-known-urls` | **see below** |
| `orchestrator_path:` | — | dropped, bundle is self-contained |

**Pickers are value attributes, not HTML boolean attributes.** Both default to
`true`, so presence-based semantics would be backwards — you would have to add
an attribute to get the default. Disable with `enable-tool-picker="false"`.
Anything other than the exact string `false` is true.

**`well-known-urls` is tri-state and the trap in this design.** The Ruby option
distinguishes `nil` (auto-discover same-origin `/.well-known/mcp.json`) from
`[]` (disable discovery entirely) from an explicit array. Attributes cannot
express nil versus empty, so:

- attribute **absent** → auto-discover same-origin (the `nil` default)
- `well-known-urls=""` → discovery **off** (the `[]` case)
- `well-known-urls="https://a.example/.well-known/mcp.json,…"` → fetch those

This asymmetry must be documented wherever the attribute is, because the quiet
failure — expecting discovery off and getting a same-origin fetch — looks like
nothing at all.

## What does not change

`window.aiState` and `window.aiActions` stay global. They are the host's
contract for page-embedded actions (Class 3), and a host declaring them on
`window` is correct and framework-neutral already. The `#ai-actions` JSON block
stays a page-level `<script type="application/json">`. `sessionStorage`
transcript persistence is unaffected.

## Decision: no shadow DOM in v1 (implemented as decided)

Shadow DOM is the reflex choice and would buy style isolation. Reject it for the
first version:

- It breaks every selector, by two routes. Six of the seven Selenium e2e tests
  reach in with `document.querySelector` / `getElementById` inside
  `execute_script`; and all seven use Selenium's own `find_element(css: …)` /
  `find_element(id: …)`, which does not pierce shadow DOM either. So the whole
  e2e suite needs rewriting, not just the scripted parts.
- Adopters lose the ability to theme the widget with their own CSS, which some
  will want.
- Without it, the refactor is mostly *moving* code: 21 lines of markup become a
  template string, the style block is injected, the ERB-injected `var`s become
  attribute reads, and 4 lookups re-scope to the element.

Styles stay global exactly as they are today, so there is no behaviour change to
reason about. Revisit if style collisions prove real in the field.

## The gem stays, as a wrapper

`llm_meta_widget(...)` keeps its signature and renders
`<llm-meta-widget …>` with the mapped attributes, vendoring the same built
module so Rails hosts need no CDN. One implementation, two delivery paths —
rather than two implementations drifting.

## Publishing to npm

Published as **`@aibranch/llm-meta-widget`** under the `aibranch` org — a
separate namespace from `@pubann`, matching the deployed `aibranch.org`
hostnames, because the widget is the generic client and PubDictionaries is one
adopter of it.

The CDN URL has no path:

```
https://cdn.jsdelivr.net/npm/@aibranch/llm-meta-widget@0.7
```

`main` and `exports["."]` both point at the bundle, so jsdelivr resolves the
bare specifier to it. A second export, `./orchestrator`, is deliberate: the
orchestrator is the public JS API for anyone who wants to build their own UI on
top instead of using the element.

`sideEffects: true` matters more than it looks. The bundle's entire purpose is
its side effects — defining the custom element and injecting the styles — so
declaring it side-effect-free would licence a bundler to drop an import that
exists for nothing else.

`files` ships only the two consumable modules and this note. The ERB partial,
the Ruby helper and the unbundled sources are the gem's business; npm adds
README and LICENSE on its own. Result: 6 files, ~69 kB packed.

`publishConfig.access: "public"` is set because a **scoped package publishes
private by default**, which fails outright on a free org. Having it in the file
means nobody has to remember `--access public` at the worst moment.

**The release order is forced by npm, not by preference.** npm has no
pending-publisher, so trusted publishing cannot be configured until the package
exists:

1. `npm login` as a member of the org, then `npm publish` by hand — the one
   time a human credential is used.
2. Add the Trusted Publisher in the package's npm settings: GitHub org `jdkim`,
   repo `llm_meta_widget`, and the workflow filename, exactly.
3. Later releases run from Actions with `permissions: id-token: write`, no
   stored token. GitHub-hosted runners only; self-hosted is unsupported.

Note the asymmetry: the trusted publisher keys on the **GitHub** repo, which
lives under `jdkim/`, while the npm scope is `@aibranch`. That works — they are
different namespaces — but it is worth knowing before someone goes looking for
an `aibranch` GitHub org that does not exist.

`prepublishOnly` runs the build, the JS tests and the linter, but **not** the
Ruby test: a publish may run on a runner with no Ruby, and a release must not
fail on a missing interpreter. `npm test` runs both locally.

## Risks

**The refactor touches the least-tested half of the codebase.** The 107 node
tests cover `orchestrator.js`. The panel has ESLint and the browser e2e runs,
nothing more — and this moves 1,454 lines of it. Add node tests for attribute
parsing (including the two traps above) and element construction *before*
moving any code.

**Version sync.** The gem version and the npm version must not drift. Either one
release process drives both, or the gem pins an exact npm version. Two
independently published artifacts of the same client is a bug waiting to be
filed.

**Breaking change for existing hosts** if the helper's rendered shape changes.
PubDictionaries is the only adopter today and would need a coordinated bump;
its `submit_annotation` and page-action wiring must be re-verified against the
element, since that is where host↔widget coupling actually lives.

**CDN as a dependency.** A CDN outage becomes a widget outage for hosts that use
it. Document self-hosting the single file as the supported alternative; it is
one static asset.

## Open questions

- Does `<llm-meta-widget>` need to support more than one instance per page?
  Today the panel assumes a single instance (fixed ids, one `sessionStorage`
  key). Multi-instance would need id scoping and a key suffix — probably not
  worth it, but decide rather than inherit.
- Should the element emit DOM events (`llm-widget:turn-complete`, etc.) so hosts
  can react without reaching into internals? Cheap to add at build time,
  awkward to retrofit later.
- npm package name: `llm-meta-widget` is free to check, and should match the
  gem name for discoverability.
