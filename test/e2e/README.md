# End-to-end tests

These drive the widget in a real headless Chrome, on a real host page, against
a real llm_meta hub and a real model. They are the only automated coverage of
the panel's wiring: `orchestrator.test.mjs` tests the decisions, and these test
that the panel actually consults them.

They cannot run in CI — they need a live PubDictionaries, a live hub, and a
model — so they are run by hand after changing the panel.

    bundle exec ruby test/e2e/prompts_and_resources_test.rb

Each prints a JSON summary and saves a screenshot beside itself. Expect 2–4
minutes per run: most of it is waiting for the model.

| Script | What it proves |
| --- | --- |
| `page_actions_test.rb` | A tool call changes real page state (`add_dictionaries` moves the form), and a host MCP tool answers from the server (`find_ids` → UBERON_0000945) |
| `prompts_and_resources_test.rb` | The prompt template renders and runs, its arguments come from page state, and the resource is attached on turn 1 only — then again after Clear |
| `resource_gate_test.rb` | A resource the server declares as over-budget or `on-demand` is never fetched at all |

## How they assert

Each wraps `window.fetch` before the first send and keeps the outgoing request
bodies. Claims are then read from the bytes actually sent to the hub, never
from what the assistant says: a model can claim it used the catalog, but the
request body either carries `pubdictionaries://dictionaries` or it does not.

## Host page

`PD_URL` overrides the page under test; it defaults to
`https://test2.pubannotation.org/text_annotation`, which proxies to whichever
PubDictionaries dev instance is running.

Do not point these at `http://localhost:6000`. Chrome refuses port 6000
outright — it is X11, on Chrome's unsafe-port list — and the failure looks like
an unexplained timeout. Run PubDictionaries on another port, or go through the
public hostname above.

The hub must allow the page's origin, or every call fails CORS with no catalog
and no answer; allowed origins live in the hub's `config/initializers/cors.rb`.

The assertions are written against PubDictionaries' annotation page: they read
`window.aiState.text()` and `window.aiState.selected_dictionaries()`, and
select a dictionary by the name on its tile. Another host page exercises the
same widget but needs its own readers and fixtures.

## Chromium note

The Selenium profile directory is created beside the script rather than in
`/tmp`, because snap-confined Chromium cannot write there and fails with a
silent 120-second timeout.
