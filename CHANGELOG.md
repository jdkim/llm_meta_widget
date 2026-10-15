# Changelog

This file starts at 0.8.0, the first release with a breaking change worth
calling out. Earlier releases are in the git history (`git log --oneline v0.7.6`).

## 0.11.0

### Added: a page can say where its handlers live

A page card can declare the global that holds its handler maps, the way a
Server Card declares its endpoint:

```json
"remotes": [ { "type": "page-global", "global": "mcp" } ]
```

```js
window.mcp = { tools: { }, prompts: { }, resources: { } };
```

A consumer that parses the card can then find the handlers and dispatch to
them. `window.aiActions`, `window.aiPrompts` and `window.aiResources` are names
only this widget knows, and they are configurable per page, so nothing outside
could rely on them.

**Existing pages keep working.** When the card declares no transport, the three
globals are read as before, and each kind falls back on its own — so tools can
move into the declared global while prompts and resources stay where they are.

Two blocks declaring different globals is an authoring error: the first is
used and the other is reported to the console.

## 0.10.1

Documentation only. The 0.10.0 release notes and the README section on the page
card were written after that release was published, so the copies on RubyGems
and npm still described 0.9.1. There is no code change: a page running 0.10.0
behaves exactly as one running 0.10.1.

## 0.10.0

### Changed: a page card is found by its media type

A card inside a page is now located by the `type` attribute of its `<script>`
element, not by an `id`:

```html
<script type="application/mcp-static-primitives+json"> … </script>
```

A client matches `script[type="application/mcp-static-primitives+json"]`, so the
element needs no `id`. This follows SEP-0000's "HTML-delivery mode". The reason
for the change: an `id` that each page chooses cannot be found by a client that
was not told the id, so an `id` cannot serve as a locator.

**Existing pages keep working.** When no block carries the media type, the widget
reads `page_card_id:` (still `"ai-page"` by default) exactly as before. That
option is now only an escape hatch for a host that cannot set the type. Pages
using it should move to the media type, because the fallback may be removed in a
later release.

### Added: a document may hold several cards

A page built from components can give each component its own card block. The
widget reads every block and joins the arrays by primitive type.

Declaring the same tool or prompt `name`, or the same resource `uri`, in two
blocks is an error: every copy is dropped and a message naming it is written to
the console. The first block does not win, because which block comes first
depends on the order the page's parts are rendered in, and the page author did
not choose that order.

A block whose JSON cannot be read costs only that block. The other blocks still
load.

## 0.9.1

### Fixed: prompt arguments were empty on a page that declares resources

A prompt's arguments are looked up by plain name (`text`), while page resources
are addressed by URI (`page:text`). A page that kept its state in resources and
had no `window.aiState` therefore had every prompt argument arrive empty, and
the person was asked to type in something the page could already see.

Page resources now fill prompt arguments of the matching name. An explicit
`window.aiState` entry still wins, so a page running both channels keeps the
behaviour it declared.

## 0.9.0

### Added: the page card

A page can declare its tools, prompts and resources in one block of JSON, using
the same envelope an MCP server puts in its Server Card. Three globals hold the
handlers, each keyed by the identifier its own MCP operation takes:

| declared in the card | implemented in | keyed by |
|---|---|---|
| `tools` | `window.aiActions` | tool `name` |
| `prompts` | `window.aiPrompts` | prompt `name` |
| `resources` | `window.aiResources` | resource `uri` |

See "The page card" in the README. Nothing is required: a page that declares no
card behaves as before, and a page that declares no `tools` still uses its
`ai-actions` block.

Page resources are addressed `page:<name>`. That scheme is experimental and
unregistered.

## 0.8.6

### Changed: a resource's size is declared in the base `size` field

`size` on the resource entry replaces `_meta…sizeBytes`, following the change to
the base MCP `Resource` interface. `sizeBytes` is still read if `size` is absent,
and is still reported for now; both will be removed in a later release. Servers
should emit `size`.

## 0.8.0

### Breaking: state readers must declare a description

`window.aiState` entries are now objects, not bare functions:

```js
window.aiState = {
  text: {
    description: "the text the user wants to annotate",
    read: function() { return $("#text").val() || ""; }
  }
};
```

The bare-function form (`text: function() {…}`) is **removed**, with no fallback.
A key still using it is reported to the console by name, with the shape it should
have, and skipped — the page's other readers keep working.

**Why.** Every other channel the widget declares to the model already carries a
developer-authored description: Class 3 action schemas, Class 2 `.well-known`
tools, Class 1 hub-registered tools, static-primitives resources. State readers
were the exception — the model saw a bare key and inferred meaning from its name.
That holds for `text` and fails for `annotation_mode` or `pending_merges`.

**What to change.** Wrap each reader in `{ description, read }`. The description
is the place to tell the model what it must know about the value, not merely what
the value is — an enumeration it must choose from, a unit, a null convention.

The system prompt now renders one line per reader with the description inline:

```
Current page state:
- text (the text the user wants to annotate): "The stomach was examined."
- selected_dictionaries (the dictionaries the user has chosen): ["uberon"]
```

Prompt-argument pre-filling (`promptArgFromState`) reads the same shape, so a
page left on the old form also stops pre-filling prompt arguments.
