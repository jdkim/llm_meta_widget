# Page-side static primitives — implementation plan

**Status: stage 1 built (`772caf9`); stages 2-5 planned.** All three decisions are settled.

## What this is

[SEP-0000 (Static Primitives Extension for MCP Server Cards)][sep] lets a server
declare its tools, prompts and resources inline in its Server Card, so a consumer
knows what is on offer before connecting. This plan applies the **same envelope to a
page**: the document declares its own primitives, and the widget reads them exactly
as it reads a server's.

Today the page uses three bespoke channels where the protocol already has three
primitives:

| the page declares | today | becomes |
|---|---|---|
| actions | `<script id="ai-actions">` schemas + `window.aiActions` handlers | `tools` |
| state | `window.aiState` = `{key: {description, read}}`, concatenated into the system prompt | `resources` |
| starters | nothing page-side; PubDictionaries serves them from its Rails MCP server | `prompts` |

The envelope is unchanged from the SEP — same `_meta` key, same three arrays, same
`sizeBytes` / `volatility` / `autoAttach` on resources:

```html
<script type="application/json" id="ai-page">
{
  "_meta": {
    "io.modelcontextprotocol/static-primitives": {
      "tools":     [ /* MCP Tool objects */ ],
      "prompts":   [ /* MCP Prompt objects */ ],
      "resources": [ /* MCP Resource + sizeBytes/volatility/autoAttach */ ]
    }
  }
}
</script>
```

## Why the widget is already most of the way there

`orchestrator.js` speaks `tools/call`, `prompts/list`, `prompts/get`,
`resources/list`, `resources/read`, and `resourceHints()` already reads
`sizeBytes`, `volatility` and `autoAttach` off a `resources/list` entry to decide
per turn whether to re-read. A page card feeds that same machinery. The work is at
the edges — parsing the card, and resolving reads against the page — not in the
pipeline.

## PubDictionaries, concretely

Its seven `aiActions` become `tools` unchanged; the schemas are already MCP `Tool`
wire format. Its six `aiState` readers become `resources`, and they divide exactly
along the SEP's own axis:

| reader | volatility | note |
|---|---|---|
| `text` | volatile | a form field the user edits |
| `selected_dictionaries` | volatile | computed from the DOM |
| `semantic_threshold`, `surface_threshold`, `options` | volatile | small form state |
| `available_dictionaries` | **stable** | the full choice set; the large one, so `sizeBytes` earns its place |

That last row is the SEP's argument in miniature: a big stable resource that should
be read once and kept, next to small volatile ones re-read each turn.

## Three decisions to settle before code

**1. URI scheme for page resources. — DECIDED: `page:`.** An `https:` URI that no
HTTP request can fetch would mislead, so page resources are addressed
`page:/annotation/selected_dictionaries`. The README must say the scheme is
**experimental and subject to change**: it is not registered, and nothing outside
this widget assigns it meaning yet.

**2 and 3 — DECIDED, by one rule.** The card is JSON and cannot hold a getter, so
behaviour attaches beside it: **the card declares; a global map keyed by the
primitive's PROTOCOL identifier implements.** The identifier is whatever the
protocol's own operation takes, which is not the same field for all three:

| primitive | operation | key | implements |
|---|---|---|---|
| tools | `tools/call` | `name` | `window.aiActions` (exists today) |
| prompts | `prompts/get` | `name` | a map returning `messages[]` |
| resources | `resources/read` | `uri` | a map returning the content |

Resources are keyed by `uri` rather than `name` because the spec defines `uri` as
the unique identifier (`server/resources.mdx:10`, and the `Resource` interface
carries `name`, `title` AND `uri`); `name` is required but nowhere stated to be
unique, so keying on it would be both inconsistent with the protocol and unsafe.

This answers prompts too, which is where the SEP's shape could have pushed us the
other way: its `prompts` array is metadata only — `name`, `description`,
`arguments`, what `prompts/list` returns — while `prompts/get` answers the filled
`messages[]`. Under this rule the bodies live in the handler map, NOT in a
page-local field added to the card. That keeps a card entry byte-identical to the
server case, which is the whole point of reusing the envelope: if a page needed
extra fields to work, the demonstration would be weaker.

The only thing left is naming the two new globals, and the existing convention
decides it: `aiActions` and `aiState` are already there, so `aiPrompts` and
`aiResources`, each overridable by attribute as `actions-global` already is.

## One conformance wrinkle

The SEP's Semantic Contract requires declared entries to equal what `tools/list`,
`prompts/list` and `resources/list` return "for **any** caller". A page has no
runtime `*/list` unless we define one — so for a page **the card is the listing**,
and equality holds by construction. Worth stating explicitly rather than leaving a
reader to wonder which side is authoritative.

## Staging

Each stage ships on its own and is additive; nothing breaks for adopters on 0.8.x.

1. **Widget reads the card.** Parse and validate `#ai-page`; feed `resources` into
   the existing resource planner, `prompts` into the prompt list, `tools` into the
   local-tools path. No behaviour change when the card is absent.
2. **Widget resolves page reads.** `resources/read` and `prompts/get` against the
   page, per decisions 2 and 3.
3. **PubDictionaries emits a card**, keeping `aiState` and `ai-actions` in place.
4. **Remove PD's bespoke channels** once the card path is proven in production.
5. **Deprecate the globals** across adopters — much later, and only with notice:
   sparql-support and others are on them.

Backward compatibility is not optional here. A page with no card must behave exactly
as it does today.

## Testing

Per `docs/custom-element-distribution.md` and the existing suite: jsdom against the
**built bundle**, one jsdom before import, and every new branch mutation-tested.
Specific cases worth pinning: a card absent (falls back to globals), a card present
alongside globals (card wins, or merges — decide), a malformed card (ignored, not
fatal), a `stable` resource read once and re-attached, a `volatile` one re-read.

[sep]: ../../../modelcontextprotocol/seps/0000-static-primitives.md
