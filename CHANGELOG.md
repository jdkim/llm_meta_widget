# Changelog

This file starts at 0.8.0, the first release with a breaking change worth
calling out. Earlier releases are in the git history (`git log --oneline v0.7.6`).

## 0.13.0

### Changed: a page card declares its transport in `transports`, not `remotes`

The declaration that says how to reach a page's handlers has moved, following
SEP revision d44bd25a. It is now an array inside the extension data:

```json
{
  "_meta": {
    "io.modelcontextprotocol/static-primitives": {
      "transports": [ { "type": "page-global", "global": "mcp" } ],
      "tools": [], "prompts": [], "resources": []
    }
  }
}
```

The reason is that the Server Card's `Remote.type` can only be
`streamable-http` or `sse`, so `page-global` was never a valid value at the top
level. It is an array because a page may come to offer more than one page-local
transport, and the order is the author's preference.

The widget reads the array in order and uses the first type it supports. It
will not skip a supported entry for a later one. Only `page-global` is
supported today; a card offering only `page-postmessage`, `page-jsonrpc` or
`page-worker` gets no handlers rather than the wrong ones, and says so.

**Top-level `remotes` still works in this release**, with a warning, so a page
and a widget can be updated in either order without the page losing its tools
in between. Move to `transports`; a later release will drop the fallback. If a
page declares both, `transports` decides and nothing is reported.


### Added: the panel says when reference data did not fit

A resource refused by the budget used to disappear with nothing but a line in
the browser console: the model answered from less than the page offered, and
nobody was told. The panel now reports it, naming the resource, its size and
what the model allows — once per budget, on the first turn it affects, and
again if a different model changes the figures.

The model is deliberately NOT told. It cannot fetch a resource — only the
client reads those — so telling it would spend context on something it can do
nothing about. The reader can act: choose a model with a larger window, or ask
the page author for a smaller reference.

A resource the page withholds on purpose (`autoAttach: false`) is not reported,
since that is the author's choice rather than an omission.

## 0.12.2

### Changed: one oversized tool result is shortened, not paid for by the others

A single tool result may now use at most 40% of the model's context window. A
result above that is cut to the cap, with a note in the result itself telling
the model how much was shown and to call the tool again with a narrower query.

This replaces giving up older results as the first response to a turn that will
not fit. Dropping the oldest results is a sound rule when results are of
similar size, and a poor one otherwise: on a real turn (2026-10-17) it gave up
two results of 80 tokens each — 160 tokens against a shortfall of about 2,600 —
and left untouched the one result that was causing the problem, at 120,667
tokens, or 94% of the window. The two results it discarded were ones the model
had asked for.

Measured over 179 real tool results: the median is 2.1% of the window, so the
cap touches 4.5% of results. All six over-budget requests in that sample were
caused by one oversized result, and the cap clears every one of them. On the
turn above it frees about 69,000 tokens and nothing has to be given up at all.

Giving up older results remains, for a conversation that is too long in
aggregate rather than because of one result.

The panel reports both, with the numbers: what was shortened or given up, how
many tokens the turn needed, and how many the model holds.

### Fixed: scrolling the panel after a turn with thinking blocks (Chrome)

After a turn that showed thinking blocks, the panel could not be scrolled. The
scrollbar moved a few tens of pixels and stopped, by wheel, trackpad and
keyboard alike, while `scrollTop` set from script still worked and held. This
was reported from two different deployments and took several wrong diagnoses
from us before the mechanism was found.

A thinking block is a `<details>` holding its own scroller. Closing one with
`open = false`, at a moment when that block is the only reason the message list
overflows, leaves Chrome with a stale wheel range — the list's overflow from
that instant, often only tens of pixels. `scrollTop` and `scrollHeight` remain
correct, which is why nothing in the page looked wrong. Chrome 154 reproduces
it with no widget code involved at all; Firefox 158 does not, and it has been
reported upstream.

The widget now takes the scroller off the inner box before closing it, and
closes on the second animation frame, because one frame is not enough for
Chrome to pick up the new overflow. Measured on a real deployment: 6 of 6 turns
healthy after the change, against 3 of 4 faulting before, with the triggering
condition confirmed present 2 to 4 times in every passing run.

One consequence: a finished thinking block that a reader reopens is shown at
full height rather than as a 10em scrolling box. Putting the scroller back when
it reopens would let a manual close trigger the same Chrome state again.

## 0.12.1

### Fixed: a tool result is counted as JSON, not as prose

The turn was sized at roughly four characters per token, which is right for
prose and badly wrong for a tool result. A request of 289,101 characters that
the provider counted as 135,291 tokens was estimated at 72,275 — 53% of its
real size — so nothing was given up and the provider refused the turn with its
own error text. That request was 33% letters, 16% digits and 45% punctuation:
JSON, which tokenizes about twice as densely as prose.

Characters are now counted in three classes — letters and spaces, CJK, and
everything else — which puts that request at 106% of its real size. Erring
high is deliberate here: underestimating ends the turn, while overestimating
gives up an old tool result slightly early. Tool schemas are counted the same
way, since a schema is JSON too.

### Fixed: following the output no longer fights a reader who scrolls

0.12.0 decided whether to follow the output from the `scroll` event. A browser
dispatches that event a frame after the position changes, while deltas arrive
every few milliseconds, so a delta could pin the view before the listener
heard that the reader had moved — and the pin put them back at the end, so the
decision never flipped. The question is now asked synchronously, immediately
before anything is added, which has no such window.

A separate report of the panel jumping to the TOP after a turn ends had a
different cause, fixed in 0.12.2 below.

## 0.12.0

Nothing a page must provide changes in this release: no new attribute, no
change to how the widget finds anything a page declares. A host moving a CDN
pin from `@0.11` to `@0.12` has nothing to edit.


### Fixed: the panel can be read while a turn is still running

Adding content mid-turn always scrolled the panel back to the end — a tool
chip, a thinking block, or any delta. On a short answer nobody notices. On a
long tool-using turn the deltas keep coming for minutes, so scrolling back
through the answer was impossible by any means: wheel, trackpad and keyboard
all appeared dead, because each attempt was undone within milliseconds.

The panel now follows the output only while the reader is at the end of it.
Scroll away and it leaves you alone; come back to the end and it resumes.
Asking a new question always returns you to the end, and a conversation
restored after a page load still opens at its end.

### Fixed: a wide table is readable instead of one letter per column

A markdown table was itself the scrolling box (`display: block;
overflow-x: auto`), so it was capped at the bubble width, squeezed its columns,
and `word-wrap: break-word` then broke every word one character per line. A
six-column table of genomic notation became a column of single letters. Tables
now sit in a wrapper that scrolls sideways while the table keeps its natural
width: the same answer went from 3,155px to 1,426px of message height in
Chromium, and the columns are readable.


### Added: a turn is sized against the model's real context window

The widget now reads each model's context window from the hub (`/api/llms`
reports `max_input_tokens`) and uses it for two decisions it used to make from
fixed guesses.

**Old tool results are given up rather than letting the round be refused.**
When the next round would not fit, the oldest tool results are replaced — one
at a time, stopping as soon as the round fits — with a short note saying the
result was dropped and may be fetched again. Nothing else is touched: not the
system prompt, not the questions, and not what the assistant said about those
results, so the model keeps its own summary of what it read. The panel says
which tool's result went, so a thinner context is visible rather than silent.

A tool message is replaced, never removed, because a provider rejects a
`tool_call` that has no matching result.

The declared tools are counted too, not only the messages. Their names,
descriptions and schemas are part of every request — around twenty tools is a
few thousand tokens before the conversation starts — so a budget that counted
messages alone would evict too late to help.

**The reference-resource budget scales with the window.** It was a fixed 8 KB
whatever the model. It is now about 6% of the window — the same share 8 KB was
of the 32,000-token model it was chosen for — so a 128,000-token model may
attach about 32 KB, up to a 64 KB cap. A model whose window the hub does not
report keeps the old 8 KB.

Nothing changes for a host that does not want this: there is no new attribute,
and a hub that does not report a window makes the widget behave exactly as
before. It is a release of llm_meta_server, not the widget, that turns the
behaviour on.

## 0.11.1

### Fixed: a page action that navigates no longer loses the turn

The transcript was saved once, after the chat loop finished. A page action that
navigates — submitting a form, following a link — unloads the page while the
loop is still running, so that turn was never saved: not the question, not
whatever the assistant had already said, and not the record of which tools ran.
After the navigation the panel came back with the previous turns and nothing of
the one that had just happened.

The turn is now saved as it happens. The question is saved before the model is
called, streamed text is saved as it arrives, and a save always happens
immediately before a tool call runs, because that call may be the one that
navigates.

This matters to any page that declares an action which navigates. Nothing to
change in your page.

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
