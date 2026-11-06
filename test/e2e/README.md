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
| `remote_tool_test.rb` | A standalone static custom element sends an anonymous turn, executes one hub-proxied MCP tool, and returns the complete result to the next LLM turn |
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


## Standalone anonymous remote MCP round trip

This fixture serves the committed custom-element bundle directly, without a
Rails host or ERB rendering. It does not override generation settings: the hub
catalog/provider defaults and current context-window management remain in charge.
No production widget behavior is changed by this fixture.

For a live hub with the guide tool active and public to anonymous visitors:

```sh
HUB_URL=http://localhost:3000 MODEL=gpt-oss-120b \
  bundle exec ruby test/e2e/remote_tool_test.rb
```

The model must support tools and be permitted by the hub's anonymous policy.
`MCP_SERVER` (default TogoMCP), `MCP_TOOL` (default TogoMCP_Usage_Guide),
`WIDGET_PORT` (default 0, an automatically selected free port), `E2E_TIMEOUT` (seconds, default 600), and
`E2E_OUTPUT_DIR` are configurable. The live hub must allow the fixture's exact
origin in CORS. Set `WIDGET_PORT=3001` (or another available port) when
a fixed CORS origin such as `http://127.0.0.1:3001` is required. This run consumes real model/tool usage.
Only use an environment you are authorized to exercise.

For deterministic wiring checks without any live model or MCP server:

```sh
MOCK_HUB=1 bundle exec ruby test/e2e/remote_tool_test.rb
```

Mock mode returns a 117KB Unicode tool result and a deterministic answer. It
proves client wiring, not live model behavior, remote MCP transport or cross-origin
CORS. The normal mode calls the configured hub directly; there is no local API
proxy hiding CORS failures.

With `SERVE_ONLY=1`, Selenium is not loaded and another browser can drive the
same static page. Start a fresh conversation with Clear if needed. Open the chat, expand Tools
and the server row, select **only** the named guide checkbox, and
send the prompt shown on the page. The local server captures wire evidence at
`tmp/remote-tool-e2e/wire.json`. Validate that capture with:

```sh
ruby test/e2e/remote_tool_wire.rb tmp/remote-tool-e2e/wire.json
```

The validator checks exactly two successful anonymous LLM turns, one MCP proxy
call, order, selected tool ID, empty arguments, matching tool-call history, full
untruncated result equality and a nonempty final answer without SSE errors. It
also checks that no fixed Ollama generation options were injected. The validator's
positive and rejection cases run without a browser in `npm run test:rb`.
Automatic Selenium runs additionally write `summary.json` (marked mock/live) and
`remote_tool.png`. Captures contain prompts and full tool results; authorization
values are redacted, and authenticated requests fail validation. Keep artifacts
out of version control. Each run overwrites the output directory's evidence.

The wire validator exits 1 for a failed behavioral assertion and 2 for a malformed capture.
