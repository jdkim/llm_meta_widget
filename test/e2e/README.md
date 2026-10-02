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
| `working_indicator_test.rb` | The panel says when it is working, stops saying so when it is not, and puts reasoning above the answer |
| `survives_navigation_test.rb` | The conversation survives a page navigation — transcript, tool record AND the model's context — and a different page starts fresh |
| `ollama_only_test.rb` | The widget works with **no llm_meta_server at all** — chat straight to an Ollama, page actions and chips intact |

## How they assert

Each wraps `window.fetch` before the first send and keeps the outgoing request
bodies. Claims are then read from the bytes actually sent to the hub, never
from what the assistant says: a model can claim it used the catalog, but the
request body either carries `pubdictionaries://dictionaries` or it does not.

## Host page

`ollama_only_test.rb` is the exception to everything below: it needs no host
app and no hub. It renders the partial itself, serves it over a socket it
opens, and talks to an Ollama — `OLLAMA_URL` and `OLLAMA_MODEL` override the
defaults, and it exits with a clear SKIPPED if no Ollama answers. That also
makes it the one test here that proves the partial stands alone.

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

## Local anonymous TogoMCP round trip

Start `llm_meta_server` on port 3000 with the Ollama model available and
TogoMCP active, public, and `public_to_anonymous`. Then run:

```sh
bundle exec ruby test/e2e/remote_tool_test.rb
```

This renders the actual helper/partial, serves it on `127.0.0.1:3001` (already
allowed by the hub's development CORS policy), selects only
`TogoMCP_Usage_Guide`, and sends a real request. It asserts two successful
`single_llm_calls`, one successful `/api/mcp_tools/:id/call`, no Authorization
header, and the returned tool result in the next LLM request. Both LLM turns
must carry `options.num_ctx=65536`; the fixture also sets `num_predict=4096`.
The final turn must contain an answer and no further tool calls. Nothing is
mocked.

Defaults: `HUB_URL=http://localhost:3000`, `MODEL=glm-4-7-flash`,
`WIDGET_PORT=3001`, `E2E_TIMEOUT=600` seconds (the guide is large).
`MODEL` is the catalog **value**, not the display/provider name `glm-4.7-flash`. The default API-key selector is `ollama-local`; it is
not a credential. Both `llm_url` and `tool_hub_url` are set to the local hub.

`E2E_OUTPUT_DIR` overrides the output directory (default
`tmp/remote-tool-e2e`). It contains `wire.json`, `summary.json`, and a screenshot.
Failures exit nonzero. The wire log includes full prompts and tool responses.

If headless Chrome cannot start, use `SERVE_ONLY=1` with the same command.
Open `http://127.0.0.1:3001/index.html`, open the assistant, expand Tools and
TogoMCP, check only `TogoMCP_Usage_Guide`, and ask it to call the guide once
with empty arguments and summarize it. The fixture records browser traffic
in `wire.json` automatically. Validate the captured exchange with:

```sh
ruby test/e2e/remote_tool_wire.rb tmp/remote-tool-e2e/wire.json
```

This validator works for either browser path. Ollama can emit a null call ID;
the widget preserves the assistant call and uses an empty `tool_call_id` plus
the tool name for its result. The validator checks that representation too.
Stop the fixture with Ctrl-C when finished.
