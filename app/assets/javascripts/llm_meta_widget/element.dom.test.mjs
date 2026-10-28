// Behavioural tests for the custom element, in a real DOM.
//
// element.js itself cannot be imported here — its CSS imports need esbuild's
// loader — so these drive the BUILT bundle, which has the stylesheets inlined.
// That is the point: the bundle is what ships, and until now the 1,154 lines of
// panel logic had no executable coverage at all. Three bugs came out of that in
// one session (leaked ERB, picker flags ignored, pre-configured tools wiped),
// two of which reached production.
//
// One jsdom for the whole file, created BEFORE the import: the element class
// closes over whatever `HTMLElement` exists at module-evaluation time, so a
// per-test jsdom would hand it a class from a different realm.
import { test, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { JSDOM } from "jsdom"
import { fileURLToPath } from "node:url"

const BUNDLE = fileURLToPath(new URL("./llm-meta-widget.js", import.meta.url))
const HUB = "https://hub.example"

// What the stub hub answers with. Tests mutate this before mounting.
let hubServers = []
let streamScript = null
let sentBodies = []
// Every fetch the element makes, so a test can assert HOW it asked and not
// only what came back. The 304 bug was invisible to the payload alone.
let fetchLog = []
// A status to answer /api/llms with instead of 200, for one test.
let hubLlmsStatus = null
// Set to override the /api/llms answer for one test.
let hubLlms = null
// What a hub-proxied tool call answers, for a test that needs a big one.
let hubToolResult = { ok: true }
// A host-wide manifest, and what its resources/list answers.
let hostManifest = { servers: [] }
let hostResources = []

function installGlobals() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example/page" })
  const { window } = dom
  for (const k of [ "window", "document", "HTMLElement", "customElements", "Event", "CustomEvent",
                    "Node", "getComputedStyle", "sessionStorage", "localStorage", "location" ]) {
    globalThis[k] = window[k]
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    fetchLog.push({ url: u, init })
    if (u.includes("single_llm_calls")) {
      sentBodies.push(JSON.parse(init.body || "{}"))
      // A test can script the stream, one entry per round, to exercise a tool
      // call. Until 0.11.1 nothing here could emit one, so no DOM test had ever
      // driven a dispatch.
      const body = (streamScript && streamScript.length)
        ? streamScript.shift()
        : 'event: done\ndata: {"content":"ok","finish_reason":"stop"}\n\n'
      const sse = { status: 200, headers: { "Content-Type": "text/event-stream" } }
      // A script entry may be { parts, gap } instead of a string, to deliver the
      // stream in chunks over time. A test that must act WHILE a turn is still
      // streaming cannot use a body returned all at once: by the time it runs the
      // turn is over, and nothing it does can be disturbed by anything.
      if (body && typeof body === "object" && body.parts) {
      	const encoder = new TextEncoder()
      	const stream = new ReadableStream({
      		async start(controller) {
      			for (const part of body.parts) {
      				controller.enqueue(encoder.encode(part))
      				await new Promise((r) => setTimeout(r, body.gap ?? 40))
      			}
      			controller.close()
      		}
      	})
      	return new Response(stream, sse)
      }
      return new Response(body, sse)
    }
    // `headers` matters: mcpRpc reads content-type, and a response without it
    // throws — which listMcpResources swallows, so an MCP path would behave as
    // if the server had returned nothing at all.
    const json = (body) => ({
    	ok: true, status: 200,
    	headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    	json: async () => body, text: async () => JSON.stringify(body)
    })
    if (u.includes("/api/llms")) {
    	if (hubLlmsStatus && hubLlmsStatus !== 200) {
    		// A 304 carries no body, which is the whole point: Response.ok is
    		// false and r.json() would throw.
    		return { ok: false, status: hubLlmsStatus, headers: { get: () => null },
    		         json: async () => { throw new Error("no body on " + hubLlmsStatus) } }
    	}
    	return json(hubLlms || { llms: [ { models: [ { value: "m1" }, { value: "m2" } ] } ] })
    }
    if (/\/api\/mcp_servers\/[^/]+\/tools/.test(u)) {
      const uuid = u.match(/mcp_servers\/([^/]+)\/tools/)[1]
      const s = hubServers.find((x) => x.uuid === uuid)
      return json({ tools: (s && s.tools) || [] })
    }
    if (u.includes("/api/mcp_servers")) return json({ mcp_servers: hubServers })
    // A host-wide (Class 2) server: a well-known manifest naming an endpoint,
    // plus JSON-RPC at that endpoint. `hostResources` is what resources/list
    // answers, so a test can offer an oversized reference.
    if (u.includes("/.well-known/mcp.json")) return json(hostManifest)
    if (u.includes("/host-mcp")) {
    	const rpc = JSON.parse(init.body || "{}")
    	if (rpc.method === "resources/list") return json({ result: { resources: hostResources } })
    	if (rpc.method === "resources/read") {
    		return json({ result: { contents: [ { uri: rpc.params && rpc.params.uri, text: "R".repeat(200) } ] } })
    	}
    	return json({ result: {} })
    }
    // A hub-proxied tool's real result goes back to the model, unlike a page
    // action's (the loop reports only {ok, applied} for those) — so this is the
    // only path a test can use to put a large result in the context.
    if (/\/api\/mcp_tools\/[^/]+\/call/.test(u)) return json({ result: hubToolResult })
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" }
  }
}

installGlobals()
await import(BUNDLE)

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// Mount a fresh widget. Clears the previous one first: the panel uses fixed ids
// and the element refuses to start when one is already on the page.
async function mount(attrs = {}, settle = 60) {
  document.body.innerHTML = ""
  const el = document.createElement("llm-meta-widget")
  const base = { "llm-url": HUB, model: "m1", "well-known-urls": "" }
  for (const [ k, v ] of Object.entries({ ...base, ...attrs })) {
    if (v !== null) el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(settle)
  return document.getElementById("llm-meta-widget-chat")
}

before(() => { assert.ok(customElements.get("llm-meta-widget"), "the bundle should register the element") })
// Every test mounts at the same path, and the transcript is keyed by path, so
// without this a test restores the previous test's conversation — which made an
// assertion about "the saved question" read a question from two tests ago.
beforeEach(() => {
  hubServers = []; sentBodies = []; hubLlms = null; fetchLog = []; hubLlmsStatus = null; streamScript = null; hubToolResult = { ok: true }; hostManifest = { servers: [] }; hostResources = []
  try { window.sessionStorage.clear() } catch { /* storage may be unavailable */ }
})

test("the rendered panel shows no template syntax", async () => {
  const panel = await mount()
  assert.ok(panel, "panel should be in the document")
  // textContent, NOT innerHTML: the parser treats `<%` as text, so innerHTML
  // serialises it as `&lt;%` and a naive regex over innerHTML never matches.
  const found = ((panel.textContent || "").match(/<%|%>/g) || [])
  assert.deepEqual(found, [], "template delimiters must never reach the rendered panel")
})

test("enable-model-picker=false removes the select from the DOM", async () => {
  // A hub is configured so the TOOL picker stays enabled — otherwise both are
  // off, the whole .lmw-input-controls row is pruned, and this would pass on
  // the wrapper's removal without ever exercising the model-picker prune.
  const on = await mount({ "tool-hub-url": HUB })
  assert.ok(on.querySelector(".lmw-model-picker"), "picker should be present by default")
  const off = await mount({ "tool-hub-url": HUB, "enable-model-picker": "false" })
  assert.equal(off.querySelector(".lmw-model-picker"), null, "disabled picker must be removed, not merely hidden")
})

test("enable-tool-picker=false removes the tools picker from the DOM", async () => {
  const on = await mount({ "tool-hub-url": HUB })
  assert.ok(on.querySelector(".lmw-tools-picker"), "picker should be present when a hub is configured")
  const off = await mount({ "tool-hub-url": HUB, "enable-tool-picker": "false" })
  assert.equal(off.querySelector(".lmw-tools-picker"), null, "disabled tools picker must be removed")
})

test("with both pickers off, the controls row goes too", async () => {
  const panel = await mount({ "enable-model-picker": "false", "enable-tool-picker": "false" })
  assert.equal(panel.querySelector(".lmw-input-controls"), null, "an empty controls row should not be left behind")
})

test("a pre-configured remote tool survives the picker's first render", async () => {
  // The regression: the picker rebuilt the tool list from its own (empty)
  // selection on first render and silently discarded the page's pre-selection.
  // The visible symptom was a model answering from the tool DESCRIPTION.
  hubServers = [ { uuid: "u1", name: "Srv", tools: [
    { id: 222, name: "the_tool", description: "d", input_schema: { type: "object", properties: {} } },
    { id: 223, name: "other",    description: "d", input_schema: { type: "object", properties: {} } },
  ] } ]
  const block = document.createElement("script")
  block.type = "application/json"
  block.id = "remote-mcp-tools"
  block.textContent = JSON.stringify([ { id: 222, name: "the_tool", description: "d", input_schema: {} } ])
  document.body.appendChild(block)
  // mount() clears the body, so re-attach the block after it does.
  document.body.innerHTML = ""
  document.body.appendChild(block)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "",
                                          "tool-hub-url": HUB, "remote-tools-schema-id": "remote-mcp-tools" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(40)
  // The picker is loaded lazily, on first open (ensurePickerLoaded), so the
  // regression only reproduces once the panel has actually been opened.
  document.getElementById("llm-meta-widget-toggle").click()
  await tick(150)
  const panel = document.getElementById("llm-meta-widget-chat")
  const boxes = [ ...panel.querySelectorAll('.lmw-tools-list input[type="checkbox"]') ]
  const checked = boxes.filter((b) => b.checked).map((b) => b.value)
  assert.deepEqual(checked, [ "222" ], "the pre-configured tool must still be selected after the picker renders")
  assert.equal(panel.querySelector(".lmw-tools-count").textContent, "1", "and must be counted")
})

// --- state readers (0.8.0 object shape) -------------------------------------

// Send one turn and return the system prompt the model was given.
async function systemPromptAfterATurn(panel) {
  const input = panel.querySelector(".lmw-input")
  input.value = "hello"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  panel.querySelector(".lmw-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(120)
  const body = sentBodies.at(-1)
  const system = (body?.messages || []).find((m) => m.role === "system")
  return system?.content || ""
}

test("a reader's description reaches the model next to its value", async () => {
  window.aiState = {
    annotation_mode: {
      description: "whether matches are replaced or added to existing ones",
      read: () => "append"
    }
  }
  const panel = await mount()
  const prompt = await systemPromptAfterATurn(panel)
  // Description and value together on one line — the model should not have to
  // match a name against a glossary printed somewhere else in the prompt.
  assert.match(prompt, /- annotation_mode \(whether matches are replaced or added to existing ones\): "append"/)
  delete window.aiState
})

test("a bare function is refused by name, and the other readers still work", async () => {
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(" "))
  try {
    window.aiState = {
      legacy_reader: () => "from the removed 0.7 form",
      pending_merges: { description: "merges awaiting confirmation", read: () => 3 }
    }
    const panel = await mount()
    const prompt = await systemPromptAfterATurn(panel)

    // Named, and told what the shape should be.
    assert.ok(errors.some((e) => e.includes("legacy_reader") && e.includes("bare function")),
              `expected an error naming the key; got ${JSON.stringify(errors)}`)
    // Skipped, not guessed at.
    assert.doesNotMatch(prompt, /legacy_reader/)
    assert.doesNotMatch(prompt, /from the removed 0.7 form/)
    // One bad entry must not take the page's good readers down with it.
    assert.match(prompt, /- pending_merges \(merges awaiting confirmation\): 3/)
  } finally {
    console.error = realError
    delete window.aiState
  }
})

test("an object missing read is refused too, and says which field is missing", async () => {
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(" "))
  try {
    window.aiState = { half_declared: { description: "declared but unreadable" } }
    const panel = await mount()
    const prompt = await systemPromptAfterATurn(panel)
    assert.ok(errors.some((e) => e.includes("half_declared") && e.includes("missing read")),
              `expected the message to name the missing field; got ${JSON.stringify(errors)}`)
    assert.doesNotMatch(prompt, /half_declared/)
  } finally {
    console.error = realError
    delete window.aiState
  }
})

test("an object missing description is refused, and says which field is missing", async () => {
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a.join(" "))
  try {
    window.aiState = { unlabelled: { read: () => "a value with no stated meaning" } }
    const panel = await mount()
    const prompt = await systemPromptAfterATurn(panel)
    assert.ok(errors.some((e) => e.includes("unlabelled") && e.includes("missing description")),
              `expected the message to name the missing field; got ${JSON.stringify(errors)}`)
    assert.doesNotMatch(prompt, /unlabelled/)
    assert.doesNotMatch(prompt, /a value with no stated meaning/)
  } finally {
    console.error = realError
    delete window.aiState
  }
})

test("a page that declares no state says so, rather than showing an empty block", async () => {
  // An empty "Current page state:" heading reads as "this page has no state I can
  // see", which is a different claim from "this page declares none".
  delete window.aiState
  const panel = await mount()
  const prompt = await systemPromptAfterATurn(panel)
  assert.match(prompt, /\(this page declares no state\)/)
})

test("a reader that throws reports the error in place of its value", async () => {
  // The page's bug must not take down the turn, and must not look like a real
  // value either — the model is told that this one reader failed.
  window.aiState = {
    broken:  { description: "a reader with a bug", read: () => { throw new Error("page bug") } },
    healthy: { description: "a reader that works", read: () => "fine" }
  }
  const panel = await mount()
  const prompt = await systemPromptAfterATurn(panel)
  assert.match(prompt, /- broken \(a reader with a bug\): "<error: page bug>"/)
  assert.match(prompt, /- healthy \(a reader that works\): "fine"/)
  delete window.aiState
})

// The attribution link. The widget answers from a hub the visitor never sees,
// so the panel is the only place that can say what is behind it — and on an
// adopter's page it is the only mention of AIbranch at all.
test("the header credits the service, linking out to it", async () => {
  const panel = await mount()
  const credit = panel.querySelector(".lmw-powered")
  const link = credit && credit.querySelector("a")

  assert.ok(credit, "the panel should credit the service that answers it")
  assert.ok(link, "the credit should carry a link")
  // Only the NAME is clickable — "(powered by " and ")" stay plain text, so
  // the link target is the word a reader would actually aim at.
  assert.equal(link.textContent.trim(), "AIbranch")
  assert.match(credit.textContent, /\(powered by AIbranch\)/)
  assert.equal(credit.tagName, "SPAN", "the wrapper must not itself be a link")
  assert.equal(link.getAttribute("href"), "https://chat.aibranch.org/")
  // It sits on someone else's page: never navigate their tab away, and never
  // hand them the referrer-opener pair.
  assert.equal(link.getAttribute("target"), "_blank")
  assert.match(link.getAttribute("rel") || "", /noopener/)
})

test("the credit travels with the title, not loose in the header bar", async () => {
  const panel = await mount()
  const group = panel.querySelector(".lmw-title-group")

  assert.ok(group, "title and credit should share one group")
  assert.ok(group.querySelector(".lmw-title"), "the title belongs in the group")
  assert.ok(group.querySelector(".lmw-powered"), "the credit belongs in the group")
  // The header is space-between with two children. A third child would be
  // pushed to the centre, away from the title it qualifies.
  assert.equal(panel.querySelector(".lmw-header").children.length, 2)
})

// The picker offers only models that can do what the widget is for.
//
// medgemma is free and local, so it was listed — and picking it ended the next
// turn with `internal_error: medgemma1.5:4b does not support tools`, because
// every turn here declares page actions. The hub already reports the
// capability; the picker simply ignored it.
const ollamaFamily = (models) => ({ llms: [ { family: "ollama", available_models: models } ] })

test("the model picker hides a model that cannot call tools", async () => {
  hubLlms = ollamaFamily([
    { value: "tooly",   label: "tooly",   supports_tools: true },
    { value: "notools", label: "notools", supports_tools: false },
  ])

  const panel = await mount({ "tool-hub-url": HUB, model: "tooly" })
  const offered = [ ...panel.querySelectorAll(".lmw-model-picker option") ].map((o) => o.value)

  assert.ok(offered.includes("tooly"), `tool-capable model should be offered: ${offered}`)
  assert.ok(!offered.includes("notools"), `a model that cannot call tools must not be offered: ${offered}`)
})

test("a hub that does not report the capability still gets its models listed", async () => {
  // Older hubs omit supports_tools entirely. Absent is not a claim of "no".
  // NOT the configured model: that one is unshifted back in regardless, which
  // would mask the filter and let this pass for the wrong reason.
  hubLlms = ollamaFamily([
    { value: "configured", label: "configured", supports_tools: true },
    { value: "legacy",     label: "legacy" },
  ])

  const panel = await mount({ "tool-hub-url": HUB, model: "configured" })
  const offered = [ ...panel.querySelectorAll(".lmw-model-picker option") ].map((o) => o.value)

  assert.ok(offered.includes("legacy"), `absent capability must not hide a model: ${offered}`)
})

test("the host's configured model is kept even if it cannot call tools", async () => {
  // The escape hatch: a deployment with no tools at all can still name one.
  hubLlms = ollamaFamily([ { value: "notools", label: "notools", supports_tools: false } ])

  const panel = await mount({ "tool-hub-url": HUB, model: "notools" })
  const offered = [ ...panel.querySelectorAll(".lmw-model-picker option") ].map((o) => o.value)

  assert.ok(offered.includes("notools"), `the configured model must never vanish: ${offered}`)
})

// ---- page card, stage 1 -------------------------------------------------
//
// Stage 1 is the card's TOOLS reaching the model. Prompts and resources are
// parsed but not yet wired — they need read/get resolution against the page.
const CARD_MEDIA_TYPE = "application/mcp-static-primitives+json"

// The spec's locator: discovery is by media type, and the element needs no id.
function putTypedCard(ext, card = {}) {
  const el = document.createElement("script")
  el.type = CARD_MEDIA_TYPE
  el.textContent = JSON.stringify(Object.assign({}, card,
    { _meta: { "io.modelcontextprotocol/static-primitives": ext } }))
  document.body.appendChild(el)
  return el
}

// The escape hatch kept for a host that cannot set the type: an id-addressed
// block of plain JSON. Read only when no typed block is present.
function putCard(ext) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = "ai-page"
  el.textContent = JSON.stringify({ _meta: { "io.modelcontextprotocol/static-primitives": ext } })
  document.body.appendChild(el)
  return el
}

function putActionsTag(tools) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = "ai-actions"
  el.textContent = JSON.stringify(tools)
  document.body.appendChild(el)
  return el
}

// mount() clears document.body, so the tag has to go in after the element
// exists; these drive the declaration path by re-mounting with it present.
async function mountWithPage({ card, actions, typedCards }) {
  document.body.innerHTML = ""
  if (actions) putActionsTag(actions)
  if (card) putCard(card)
  for (const ext of typedCards || []) putTypedCard(ext)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)
  return el
}

test("a page with no card behaves exactly as before", async () => {
  await mountWithPage({ actions: [ { name: "legacy_action", description: "d", input_schema: {} } ] })

  assert.ok(document.getElementById("llm-meta-widget-chat"), "the panel should still mount")
  assert.equal(document.getElementById("ai-page"), null, "no card was added")
})

// Send one turn and return the tool names the model was actually offered.
async function localToolsAfterATurn() {
  const panel = document.getElementById("llm-meta-widget-chat")
  const input = panel.querySelector(".lmw-input")
  input.value = "hello"
  input.dispatchEvent(new window.Event("input", { bubbles: true }))
  panel.querySelector(".lmw-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(120)
  return (sentBodies.at(-1)?.local_tools || []).map((t) => t.name)
}

test("the card's tools are the ones sent to the model", async () => {
  await mountWithPage({
    card: { tools: [ { name: "from_card", description: "d", inputSchema: {} } ] },
    actions: [ { name: "from_tag", description: "d", input_schema: {} } ]
  })

  // The card REPLACES the tag rather than merging: two sources for one list
  // would leave a reader working out which the page meant.
  assert.deepEqual(await localToolsAfterATurn(), [ "from_card" ])
})

test("without a card the #ai-actions tag is still what is sent", async () => {
  await mountWithPage({ actions: [ { name: "from_tag", description: "d", input_schema: {} } ] })

  assert.deepEqual(await localToolsAfterATurn(), [ "from_tag" ])
})

test("a card declaring no tools falls back to the tag", async () => {
  // An empty or prompts-only card must not silently disarm a page that still
  // declares its actions the old way.
  await mountWithPage({
    card: { prompts: [ { name: "annotate" } ] },
    actions: [ { name: "from_tag", description: "d", input_schema: {} } ]
  })

  assert.deepEqual(await localToolsAfterATurn(), [ "from_tag" ])
})

test("page-card-id points the widget at a differently named card", async () => {
  // Hosts with an id clash need to move it, exactly as actions-schema-id allows.
  document.body.innerHTML = ""
  const el2 = document.createElement("script")
  el2.type = "application/json"
  el2.id = "my-card"
  el2.textContent = JSON.stringify({ _meta: { "io.modelcontextprotocol/static-primitives": {
    tools: [ { name: "from_renamed_card", description: "d", inputSchema: {} } ] } } })
  document.body.appendChild(el2)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "", "page-card-id": "my-card" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  assert.deepEqual(await localToolsAfterATurn(), [ "from_renamed_card" ])
})

test("a malformed card does not stop the panel mounting", async () => {
  document.body.innerHTML = ""
  const bad = document.createElement("script")
  bad.type = "application/json"
  bad.id = "ai-page"
  bad.textContent = "{not json"
  document.body.appendChild(bad)
  const el = document.createElement("llm-meta-widget")
  el.setAttribute("llm-url", HUB); el.setAttribute("model", "m1"); el.setAttribute("well-known-urls", "")
  document.body.appendChild(el)
  await tick(60)

  assert.ok(document.getElementById("llm-meta-widget-chat"), "a host typo must not cost the assistant")
})

// ---- page prompts, end to end -------------------------------------------

test("a card-declared prompt appears as a button and sends its handler's text", async () => {
  window.aiPrompts = { annotate: (args) => "Annotate: " + (args.subject || "nothing") }
  await mountWithPage({ card: { prompts: [ { name: "annotate", description: "Annotate the page" } ] } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  assert.ok(button, "a page prompt should render as a button like a server's")

  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  const sent = sentBodies.at(-1)
  const user = (sent?.messages || []).filter((m) => m.role === "user").at(-1)
  assert.match(String(user?.content ?? ""), /Annotate: /)
  delete window.aiPrompts
})

test("a page prompt with no handler reports it instead of sending an empty turn", async () => {
  window.aiPrompts = {}
  await mountWithPage({ card: { prompts: [ { name: "annotate", description: "Annotate" } ] } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const before = sentBodies.length
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  assert.equal(sentBodies.length, before, "nothing should be sent when the prompt cannot be built")
  assert.match(panel.textContent, /annotate/)
  delete window.aiPrompts
})

// ---- page resources, end to end -----------------------------------------

test("a card-declared resource reaches the system prompt with its description", async () => {
  window.aiResources = { "page:text": () => "carpal tunnel syndrome" }
  await mountWithPage({ card: { resources: [
    { uri: "page:text", name: "Text", description: "the text to annotate" }
  ] } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const system = await systemPromptAfterATurn(panel)

  assert.match(system, /Text \(the text to annotate\): carpal tunnel syndrome/)
  delete window.aiResources
})

test("a volatile page resource is re-read on the second turn", async () => {
  let n = 0
  window.aiResources = { "page:text": () => "value " + (++n) }
  await mountWithPage({ card: { resources: [
    { uri: "page:text", name: "Text", description: "d", volatility: "volatile" }
  ] } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const first = await systemPromptAfterATurn(panel)
  const second = await systemPromptAfterATurn(panel)

  assert.match(first, /value 1/)
  assert.match(second, /value 2/, "a form field read at boot is stale by the next turn")
  delete window.aiResources
})

test("a page with no resources sends the same prompt it always did", async () => {
  await mountWithPage({ card: { tools: [ { name: "t", description: "d", inputSchema: {} } ] } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const system = await systemPromptAfterATurn(panel)

  assert.match(system, /Current page state/)
  assert.doesNotMatch(system, /page:\//)
})

// The globals are renameable, and "readConfig parsed the attribute" is not the
// same claim as "the panel read from the renamed object". Only driving a turn
// distinguishes them.
test("resources-global points the panel at a renamed map", async () => {
  window.myResources = { "page:t": () => "from the renamed map" }
  document.body.innerHTML = ""
  const card = document.createElement("script")
  card.type = "application/json"; card.id = "ai-page"
  card.textContent = JSON.stringify({ _meta: { "io.modelcontextprotocol/static-primitives": {
    resources: [ { uri: "page:t", name: "T", description: "d" } ] } } })
  document.body.appendChild(card)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "", "resources-global": "myResources" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  const system = await systemPromptAfterATurn(document.getElementById("llm-meta-widget-chat"))
  assert.match(system, /from the renamed map/)
  delete window.myResources
})

test("prompts-global points the panel at a renamed map", async () => {
  window.myPrompts = { annotate: () => "from the renamed prompts" }
  document.body.innerHTML = ""
  const card = document.createElement("script")
  card.type = "application/json"; card.id = "ai-page"
  card.textContent = JSON.stringify({ _meta: { "io.modelcontextprotocol/static-primitives": {
    prompts: [ { name: "annotate", description: "Annotate" } ] } } })
  document.body.appendChild(card)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "", "prompts-global": "myPrompts" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  const panel = document.getElementById("llm-meta-widget-chat")
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  const user = (sentBodies.at(-1)?.messages || []).filter((m) => m.role === "user").at(-1)
  assert.match(String(user?.content ?? ""), /from the renamed prompts/)
  delete window.myPrompts
})

// A prompt's declared arguments are looked up by plain NAME, while page
// resources are addressed by URI. On a page that keeps its state in resources
// and has no aiState, every argument therefore arrived empty and the visitor
// was asked to retype what was already on screen. The orchestrator knows how to
// bridge the two; this proves the element actually asks it to, which is the
// half that was missing when the bridge shipped.
test("a page resource fills a card-declared prompt's argument", async () => {
  window.aiResources = { "page:text": () => "aspirin inhibits COX" }
  window.aiPrompts = { annotate: (args) => "ANNOTATE[" + (args.text || "empty") + "]" }
  await mountWithPage({ card: {
    prompts: [ { name: "annotate", description: "Annotate the page",
                 arguments: [ { name: "text", required: false } ] } ],
    resources: [ { uri: "page:text", name: "Text", description: "the text", volatility: "volatile" } ]
  } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  const sent = sentBodies.at(-1)
  const user = (sent?.messages || []).filter((m) => m.role === "user").at(-1)
  assert.match(String(user?.content ?? ""), /ANNOTATE\[aspirin inhibits COX\]/,
               "the argument should be filled from the page resource of that name")
  delete window.aiResources
  delete window.aiPrompts
})

// aiState is the page saying explicitly what it wants under that name, so it
// must win over a resource that happens to share it. Without this, the merge
// order is free to flip and nothing notices.
test("an explicit aiState reader wins over a page resource of the same name", async () => {
  window.aiState = { text: { description: "declared directly", read: () => "from aiState" } }
  window.aiResources = { "page:text": () => "from the resource" }
  window.aiPrompts = { annotate: (args) => "ANNOTATE[" + (args.text || "empty") + "]" }
  await mountWithPage({ card: {
    prompts: [ { name: "annotate", description: "Annotate the page",
                 arguments: [ { name: "text", required: false } ] } ],
    resources: [ { uri: "page:text", name: "Text", description: "the text", volatility: "volatile" } ]
  } })

  const panel = document.getElementById("llm-meta-widget-chat")
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  const user = (sentBodies.at(-1)?.messages || []).filter((m) => m.role === "user").at(-1)
  assert.match(String(user?.content ?? ""), /ANNOTATE\[from aiState\]/)
  delete window.aiState
  delete window.aiResources
  delete window.aiPrompts
})

// ---- discovery by media type (SEP-0000 "HTML-delivery mode") -------------
//
// The media type is the locator. An id the page picks cannot be found by a
// client that was not told it, which is the whole reason a Server Card needs no
// canonical filename and a page card does.

test("a card is found by its media type with no id at all", async () => {
  await mountWithPage({ typedCards: [ { tools: [ { name: "typed_tool", description: "d", inputSchema: {} } ] } ] })

  assert.deepEqual(await localToolsAfterATurn(), [ "typed_tool" ])
})

test("several typed blocks in one document merge", async () => {
  await mountWithPage({ typedCards: [
    { tools: [ { name: "from_first", description: "d", inputSchema: {} } ] },
    { tools: [ { name: "from_second", description: "d", inputSchema: {} } ] }
  ] })

  assert.deepEqual((await localToolsAfterATurn()).sort(), [ "from_first", "from_second" ])
})

test("a duplicate tool name across blocks drops every copy", async () => {
  // Not "first wins": which component is first depends on partial order, which
  // the page author does not control. The author is told instead.
  await mountWithPage({ typedCards: [
    { tools: [ { name: "clash", description: "one", inputSchema: {} },
               { name: "kept", description: "d", inputSchema: {} } ] },
    { tools: [ { name: "clash", description: "two", inputSchema: {} } ] }
  ] })

  assert.deepEqual(await localToolsAfterATurn(), [ "kept" ])
})

test("a duplicate resource uri across blocks drops every copy", async () => {
  window.aiResources = { "page:x": () => "value" }
  await mountWithPage({ typedCards: [
    { resources: [ { uri: "page:x", name: "X", description: "d" } ] },
    { resources: [ { uri: "page:x", name: "X again", description: "d" } ] }
  ] })

  const panel = document.getElementById("llm-meta-widget-chat")
  panel.querySelector("textarea").value = "hello"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(140)

  const system = (sentBodies.at(-1)?.messages || []).find((m) => m.role === "system")
  assert.doesNotMatch(String(system?.content ?? ""), /page:x|X again/)
  delete window.aiResources
})

test("the id-addressed block is still read when no typed block exists", async () => {
  await mountWithPage({ card: { tools: [ { name: "legacy_id_tool", description: "d", inputSchema: {} } ] } })

  assert.deepEqual(await localToolsAfterATurn(), [ "legacy_id_tool" ])
})

test("a typed block wins over an id-addressed one", async () => {
  // The id is an escape hatch, not a second channel: a page that sets the type
  // has said where its card is.
  await mountWithPage({
    card: { tools: [ { name: "from_id", description: "d", inputSchema: {} } ] },
    typedCards: [ { tools: [ { name: "from_type", description: "d", inputSchema: {} } ] } ]
  })

  assert.deepEqual(await localToolsAfterATurn(), [ "from_type" ])
})

test("one malformed block does not take the other blocks down with it", async () => {
  // A page built from components has one card per component. A typo in one
  // component's JSON must cost that component's primitives, not the page's.
  document.body.innerHTML = ""
  const bad = document.createElement("script")
  bad.type = CARD_MEDIA_TYPE
  bad.textContent = "{not json"
  document.body.appendChild(bad)
  putTypedCard({ tools: [ { name: "survivor", description: "d", inputSchema: {} } ] })
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  assert.deepEqual(await localToolsAfterATurn(), [ "survivor" ])
})

test("a present but unreadable typed block does not fall back to the id block", async () => {
  // The page said where its card is by setting the type. Reading the id block
  // instead would silently serve primitives the page had replaced.
  document.body.innerHTML = ""
  putCard({ tools: [ { name: "stale_id_tool", description: "d", inputSchema: {} } ] })
  const bad = document.createElement("script")
  bad.type = CARD_MEDIA_TYPE
  bad.textContent = "{not json"
  document.body.appendChild(bad)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  assert.deepEqual(await localToolsAfterATurn(), [],
                   "a typed block that is present but broken must not resurrect the id block")
})

test("a card carrying both the media type and the legacy id is read once", async () => {
  // A host in transition wants its page readable by the widget its visitors
  // already have AND by the current one: the type for new widgets, the id for
  // older ones. The card must not then be counted twice.
  document.body.innerHTML = ""
  const el = document.createElement("script")
  el.type = CARD_MEDIA_TYPE
  el.id = "ai-page"
  el.textContent = JSON.stringify({ _meta: { "io.modelcontextprotocol/static-primitives": {
    tools: [ { name: "both_channels", description: "d", inputSchema: {} } ]
  } } })
  document.body.appendChild(el)
  const w = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    w.setAttribute(k, v)
  }
  document.body.appendChild(w)
  await tick(60)

  assert.deepEqual(await localToolsAfterATurn(), [ "both_channels" ],
                   "declared once, so offered once")
})


// ---- the page-local transport, end to end -------------------------------
//
// A card that declares its global is the only form another consumer could
// discover. These prove the element actually dispatches through it, because
// the resolver being correct in isolation proved nothing last time.

async function mountWithGlobal(ext) {
  document.body.innerHTML = ""
  // transports lives INSIDE the extension data, not at the card's top level.
  putTypedCard(Object.assign({ transports: [ { type: "page-global", global: "mcp" } ] }, ext),
               { name: "org.example/page" })
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)
  return el
}

test("a tool declared with a page-global transport dispatches to that global", async () => {
  const called = []
  window.mcp = { tools: { from_global: (args) => { called.push(args); return "ok" } } }
  await mountWithGlobal({ tools: [ { name: "from_global", description: "d", inputSchema: {} } ] })

  assert.deepEqual(await localToolsAfterATurn(), [ "from_global" ])
  delete window.mcp
})

test("the escape-hatch card is checked for a duplicate transport too", async () => {
  // boot() routes even a single typed block through the merge, which is where a
  // transport declared twice is caught and the first kept. The id-addressed
  // escape hatch used to skip the merge, which made it the one path where that
  // authoring error went unreported.
  document.body.innerHTML = ""
  putCard({
    transports: [ { type: "page-global", global: "first" },
                  { type: "page-global", global: "second" } ],
    tools: [ { name: "t", description: "d", inputSchema: {} } ]
  })

  const said = []
  const realWarn = console.warn
  console.warn = (m) => said.push(String(m))
  try {
    const el = document.createElement("llm-meta-widget")
    for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
      el.setAttribute(k, v)
    }
    document.body.appendChild(el)
    await tick(60)
  } finally {
    console.warn = realWarn
  }

  assert.match(said.join(" "), /declared more than once/)
})

test("a prompt resolves through the declared global", async () => {
  window.mcp = { prompts: { annotate: () => "FROM THE GLOBAL" } }
  await mountWithGlobal({ prompts: [ { name: "annotate", description: "Annotate" } ] })

  const panel = document.getElementById("llm-meta-widget-chat")
  const button = [ ...panel.querySelectorAll(".lmw-prompt") ].find((b) => /annotate/i.test(b.textContent))
  button.dispatchEvent(new window.Event("click", { bubbles: true }))
  await tick(140)

  const user = (sentBodies.at(-1)?.messages || []).filter((m) => m.role === "user").at(-1)
  assert.match(String(user?.content ?? ""), /FROM THE GLOBAL/)
  delete window.mcp
})

test("a resource is read through the declared global", async () => {
  window.mcp = { resources: { "page:text": () => "read via the global" } }
  await mountWithGlobal({ resources: [ { uri: "page:text", name: "Text", description: "d",
                                         volatility: "volatile" } ] })

  const panel = document.getElementById("llm-meta-widget-chat")
  panel.querySelector("textarea").value = "hello"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(140)

  const system = (sentBodies.at(-1)?.messages || []).find((m) => m.role === "system")
  assert.match(String(system?.content ?? ""), /read via the global/)
  delete window.mcp
})

test("the legacy globals still work when the card declares no transport", async () => {
  window.aiActions = { legacy_tool: () => "ok" }
  await mountWithPage({ typedCards: [ { tools: [ { name: "legacy_tool", description: "d", inputSchema: {} } ] } ] })

  assert.deepEqual(await localToolsAfterATurn(), [ "legacy_tool" ])
  delete window.aiActions
})

// ---- a turn survives a page action that navigates ----------------------
//
// The transcript was written once, after the chat loop returned — which a page
// action that navigates never lets happen. PubDictionaries' submit_annotation
// submits a form, so the turn was lost: the question, whatever the assistant
// had already said, and the record of what ran. Reported from test2 on
// 2026-10-15 as "it called submit_annotation, without any response to the chat".
//
// A real navigation cannot be driven in jsdom, so these assert the property
// that makes one survivable: by the time a tool handler runs, the turn is
// already in storage.

test("the question is in storage before a tool handler runs", async () => {
  let seen = null
  window.aiActions = {
    navigating_tool: () => {
      seen = JSON.parse(window.sessionStorage.getItem("llm_meta_widget:" + location.pathname))
      return "ok"
    }
  }
  streamScript = [
    'event: text_delta\ndata: {"delta":"Choosing MONDO. Submitting now."}\n\n' +
    'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"navigating_tool","arguments":{}}}\n\n' +
    'event: done\ndata: {"content":"Choosing MONDO. Submitting now.","finish_reason":"tool_calls"}\n\n',
    'event: done\ndata: {"content":"done","finish_reason":"stop"}\n\n'
  ]
  await mountWithPage({ typedCards: [ { tools: [ { name: "navigating_tool", description: "d", inputSchema: {} } ] } ] })
  const panel = document.getElementById("llm-meta-widget-chat")
  panel.querySelector("textarea").value = "annotate this for me"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(200)

  assert.ok(seen, "nothing was in storage when the handler ran")
  const roles = seen.turns.map((t) => t.role)
  assert.ok(roles.includes("user"), "the question was not saved before the tool ran")
  assert.equal(seen.turns.find((t) => t.role === "user").content, "annotate this for me")
  delete window.aiActions
})

test("what the assistant said before the tool call is in storage too", async () => {
  let seen = null
  window.aiActions = {
    navigating_tool: () => {
      seen = JSON.parse(window.sessionStorage.getItem("llm_meta_widget:" + location.pathname))
      return "ok"
    }
  }
  // The stub streams text and then a tool call, which is the shape that loses
  // its answer: the text is on screen but was never saved.
  streamScript = [
    'event: text_delta\ndata: {"delta":"Choosing MONDO. Submitting now."}\n\n' +
    'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"navigating_tool","arguments":{}}}\n\n' +
    'event: done\ndata: {"content":"Choosing MONDO. Submitting now.","finish_reason":"tool_calls"}\n\n',
    'event: done\ndata: {"content":"done","finish_reason":"stop"}\n\n'
  ]
  sentBodies.length = 0
  await mountWithPage({ typedCards: [ { tools: [ { name: "navigating_tool", description: "d", inputSchema: {} } ] } ] })
  const panel = document.getElementById("llm-meta-widget-chat")
  panel.querySelector("textarea").value = "say something then act"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(200)

  const assistant = seen && seen.turns.find((t) => t.role === "assistant")
  assert.ok(assistant, "no assistant turn was saved before the tool ran")
  delete window.aiActions
})

// --- budgeting the turn against the model's real window -----------------
//
// A repeat visit is the normal case, and it was the broken one. The hub answers
// /api/llms and /api/mcp_servers with an ETag and must-revalidate, so the second
// page load sends a conditional request and gets 304 Not Modified. Response.ok
// is false for a 304, and the handlers turned that into an empty payload: no
// context window, so the resource budget fell to its floor and both tool-result
// truncation and eviction stood down, and no hub tools, so the panel said there
// were none. It worked on a first load and silently stopped on every one after.

test("asks for the model list without a conditional request", async () => {
  document.body.innerHTML = ""
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  const llms = fetchLog.find((c) => c.url.includes("/api/llms"))
  assert.ok(llms, "the element must ask for the model list at all")
  assert.equal(llms.init && llms.init.cache, "no-store",
               "a cached ETag would make the browser send a conditional request and get a bodyless 304")
})

test("asks for the hub tool list without a conditional request", async () => {
  document.body.innerHTML = ""
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, "tool-hub-url": HUB, model: "m1", "well-known-urls": "" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(60)

  const servers = fetchLog.find((c) => c.url.includes("/api/mcp_servers") && !c.url.includes("/tools"))
  assert.ok(servers, "the element must ask for the hub tool list at all")
  assert.equal(servers.init && servers.init.cache, "no-store")
})

test("says so when the model list cannot be read, instead of budgeting at the floor in silence", async () => {
  hubLlmsStatus = 304
  const said = []
  const realWarn = console.warn
  console.warn = (m) => said.push(String(m))
  try {
    document.body.innerHTML = ""
    const el = document.createElement("llm-meta-widget")
    for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "" })) {
      el.setAttribute(k, v)
    }
    document.body.appendChild(el)
    await tick(60)
  } finally {
    console.warn = realWarn
  }

  assert.match(said.join(" "), /\/api\/llms answered 304/)
  assert.match(said.join(" "), /context window is unknown/)
})

// These drive the whole path: /api/llms reports a window, the element hands it
// to the loop, and the loop gives up an old tool result rather than letting the
// provider refuse the round. A unit test of evictOldToolResults cannot see any
// of that wiring.

async function turnWithAHugeToolResult({ window: contextWindow }) {
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: contextWindow }
  ] } ] }
  // A hub-registered (Class 1) tool, because its real result is what goes back
  // to the model — a page action's does not (the loop reports only
  // {ok, applied} for those). 600,000 characters is ~150k tokens, which is
  // what TogoMCP's usage guide and endpoint list came to together.
  hubServers = [ { uuid: "s1", name: "big", tools: [ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ] } ]
  hubToolResult = { text: "z".repeat(600_000) }
  streamScript = [
    'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"big_tool","arguments":{}}}\n\n' +
    'event: done\ndata: {"content":"","finish_reason":"tool_calls"}\n\n',
    'event: done\ndata: {"content":"done","finish_reason":"stop"}\n\n'
  ]

  // Pre-select the tool the way a host does: a JSON block of chosen tools plus
  // tool-hub-url. mount() clears the body, so the block goes in after.
  const block = document.createElement("script")
  block.type = "application/json"
  block.id = "remote-mcp-tools"
  block.textContent = JSON.stringify([ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ])
  document.body.innerHTML = ""
  document.body.appendChild(block)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "",
                                          "tool-hub-url": HUB, "remote-tools-schema-id": "remote-mcp-tools" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(120)
  const panel = document.getElementById("llm-meta-widget-chat")
  panel.querySelector("textarea").value = "ask the big tool twice"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(1200)
  return panel
}

test("a tool result too big for the model's window is shortened, not dropped", async () => {
  // ~150k tokens against a 64k model. Dropping it would throw away what the
  // model just asked for; capping it at 40% of the window keeps a usable
  // prefix and tells the model to narrow its query.
  const panel = await turnWithAHugeToolResult({ window: 64_000 })

  const last = sentBodies[sentBodies.length - 1]
  const toolMessages = (last.messages || []).filter((m) => m.role === "tool")
  assert.equal(toolMessages.length, 1, "the result must still be there")
  assert.doesNotMatch(toolMessages[0].content, /dropped to make room/, "it must not be dropped")
  assert.match(toolMessages[0].content, /truncated: \d+ of \d+ characters shown/)
  assert.match(toolMessages[0].content, /narrower query/)
  assert.ok(toolMessages[0].content.length < 600_000 * 0.5, "and it must actually be shorter")
  assert.match(panel.textContent, /Shortened/, "the visitor should be told")
})

test("without a window from the hub nothing is given up", async () => {
  // The same turn against a hub that reports no window: the widget must not
  // invent one, so the result is sent whole and the provider decides.
  const panel = await turnWithAHugeToolResult({ window: null })

  const last = sentBodies[sentBodies.length - 1]
  const toolMessages = (last.messages || []).filter((m) => m.role === "tool")
  assert.equal(toolMessages.length, 1)
  assert.ok(toolMessages[0].content.length > 500_000, "nothing should have been dropped")
  assert.doesNotMatch(panel.textContent, /Dropped an earlier/)
})

// --- the budget follows the model, not the session ----------------------

// A page resource whose declared size (20,000 bytes) sits between the budget
// of a 32k model (8,192) and that of a 128k one (32,000), so whether it is
// attached at all is decided by the derived budget. A fixed 8 KB budget — what
// the widget used before — refuses it for both.
let SIZE_UNDER_TEST = 20_000
async function systemPromptForWindow(ctxWindow) {
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: ctxWindow }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "BIGREFBODY" + "R".repeat(20_000) }
  await mountWithPage({ card: { resources: [
    { uri: "page:big_ref", name: "BigRef", description: "a large reference", size: SIZE_UNDER_TEST }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")
  const system = await systemPromptAfterATurn(panel)
  delete globalThis.window.aiResources
  return system
}

test("a 128k model may attach a resource a 32k model may not", async () => {
  // A resource under the floor attaches on any model: this is the control, so
  // a failure above means "over budget", not "page resources never attach".
  SIZE_UNDER_TEST = 7_000
  const underFloor = await systemPromptForWindow(32_768)
  assert.match(underFloor, /BIGREFBODY/, "a 7,000-byte resource fits even the floor budget")

  SIZE_UNDER_TEST = 20_000
  const onSmall = await systemPromptForWindow(32_768)
  assert.doesNotMatch(onSmall, /BIGREFBODY/, "8,192 bytes cannot afford a 20,000-byte resource")

  const onBig = await systemPromptForWindow(128_000)
  assert.match(onBig, /BIGREFBODY/, "32,000 bytes can")
})

test("a resource skipped for budget is reported once, not every turn", async () => {
  // The plan is remembered per budget. Re-planning every turn would behave the
  // same but write the same notice into the page's console on every message,
  // which is somebody else's console.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 32_768 }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "R".repeat(20_000) }
  const notices = []
  const realInfo = console.info
  console.info = (...args) => { notices.push(args.join(" ")) }
  try {
    await mountWithPage({ card: { resources: [
      { uri: "page:big_ref", name: "BigRef", description: "d", size: 20_000 }
    ] } })
    const panel = document.getElementById("llm-meta-widget-chat")
    await systemPromptAfterATurn(panel)
    await systemPromptAfterATurn(panel)
  } finally {
    console.info = realInfo
  }

  const about = notices.filter((n) => n.includes("page:big_ref"))
  assert.equal(about.length, 1, "two turns on one model should plan once")
  delete globalThis.window.aiResources
})

test("switching model makes a resource affordable that was not", async () => {
  // The budget moves with the model, so the plan has to be made again: a plan
  // kept from the first model refuses the resource for ever.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "small", supports_tools: true, max_input_tokens: 32_768 },
    { value: "m2", label: "big", supports_tools: true, max_input_tokens: 128_000 }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "BIGREFBODY" + "R".repeat(20_000) }
  await mountWithPage({ card: { resources: [
    { uri: "page:big_ref", name: "BigRef", description: "a large reference", size: 20_000 }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")

  const before = await systemPromptAfterATurn(panel)
  assert.doesNotMatch(before, /BIGREFBODY/, "the 32k model cannot afford it")

  const picker = panel.querySelector("select")
  picker.value = "m2"
  picker.dispatchEvent(new window.Event("change", { bubbles: true }))

  const after = await systemPromptAfterATurn(panel)
  assert.match(after, /BIGREFBODY/, "the 128k model can, so the plan must be made again")
  delete globalThis.window.aiResources
})

test("switching model in the picker moves the window with it", async () => {
  // The defect this covers: `change` set MODEL and left the window behind, so
  // a visitor moving from a 262k model to a 32k one kept budgeting for 262k —
  // no eviction, and a resource allowance the small model cannot hold.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "big", supports_tools: true, max_input_tokens: 1_000_000 },
    { value: "m2", label: "small", supports_tools: true, max_input_tokens: 16_000 }
  ] } ] }
  hubServers = [ { uuid: "s1", name: "big", tools: [ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ] } ]
  hubToolResult = { text: "z".repeat(600_000) }
  streamScript = [
    'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"big_tool","arguments":{}}}\n\n' +
    'event: done\ndata: {"content":"","finish_reason":"tool_calls"}\n\n',
    'event: done\ndata: {"content":"done","finish_reason":"stop"}\n\n'
  ]
  const block = document.createElement("script")
  block.type = "application/json"
  block.id = "remote-mcp-tools"
  block.textContent = JSON.stringify([ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ])
  document.body.innerHTML = ""
  document.body.appendChild(block)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "",
                                          "tool-hub-url": HUB, "remote-tools-schema-id": "remote-mcp-tools" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(150)

  // Start on the 1M model, where ~150k tokens is affordable, then switch down.
  const panel = document.getElementById("llm-meta-widget-chat")
  const picker = panel.querySelector("select")
  picker.value = "m2"
  picker.dispatchEvent(new window.Event("change", { bubbles: true }))

  panel.querySelector("textarea").value = "ask the big tool"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(1200)

  const last = sentBodies[sentBodies.length - 1]
  const toolMessages = (last.messages || []).filter((m) => m.role === "tool")
  assert.equal(toolMessages.length, 1)
  // The per-result cap is a share of the window, so it moves with the model:
  // under the 1M model this result is affordable whole, under the 16k one it
  // is not. If the switch left the window behind, nothing would be shortened.
  assert.match(toolMessages[0].content, /truncated: \d+ of \d+ characters shown/,
    "after switching to the 16k model the result must be capped")
})

// --- wide tables ---------------------------------------------------------

test("a markdown table is given its own horizontal scroller", async () => {
  // Without the wrapper the table is itself the scrolling box, gets capped at
  // the bubble width, squeezes its columns, and .message's word-wrap breaks
  // every word one character per line — a six-column table of genomic
  // notation became a column of single letters (PubDictionaries, 2026-10-16).
  const table = [ "| rsID | Genomic notation | Effect |",
                  "|---|---|---|",
                  "| rs28929474 | NC_000014.9:g.94378610C>T | none |" ].join("\n")
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true } ] } ] }
  // Streamed as a delta, the way real content arrives.
  streamScript = [ 'event: text_delta\ndata: ' + JSON.stringify({ delta: table }) + '\n\n' +
                   'event: done\ndata: ' + JSON.stringify({ content: table, finish_reason: "stop" }) + '\n\n' ]

  const panel = await mount()
  panel.querySelector("textarea").value = "list them"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(200)

  const rendered = panel.querySelector(".message.assistant .message-content table")
  assert.ok(rendered, "the table should render")
  assert.equal(rendered.parentNode.className, "lmw-table-scroll",
    "the table must sit inside the scroller, not be the scroller")
})

test("re-rendering a turn does not nest one table scroller inside another", async () => {
  // Streaming re-renders the same bubble on every delta, so an unguarded wrap
  // would bury the table one wrapper deeper each time.
  const table = "| a | b |\n|---|---|\n| 1 | 2 |"
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  streamScript = [ 'event: text_delta\ndata: ' + JSON.stringify({ delta: table }) + '\n\n' +
                   'event: text_delta\ndata: ' + JSON.stringify({ delta: "\n\nmore" }) + '\n\n' +
                   'event: done\ndata: ' + JSON.stringify({ content: table + "\n\nmore", finish_reason: "stop" }) + '\n\n' ]

  const panel = await mount()
  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(250)

  assert.equal(panel.querySelectorAll(".lmw-table-scroll .lmw-table-scroll").length, 0)
  assert.equal(panel.querySelectorAll(".lmw-table-scroll").length, 1)
})

// --- reading back through a long answer ---------------------------------
//
// jsdom lays nothing out, so scrollHeight/clientHeight are 0 and every element
// reads as "at the bottom". These give the scroller a geometry so the
// distinction between following and reading back can exist at all.

function giveGeometry(el, { clientHeight, scrollHeight, growBy = 0 }) {
  let top = 0
  // Real layout GROWS as content arrives, and it does so SYNCHRONOUSLY: by the
  // time a handler pins, the new content is already measured. Deriving the
  // height from the text does the same here. A fixed height, or one grown from
  // a MutationObserver (a microtask, so it lands too late), gives the same
  // answer before and after a change — and then measuring at the wrong moment
  // costs nothing, which is how the first fix passed its tests and shipped
  // broken.
  const height = () => scrollHeight + (growBy ? (el.textContent || "").length * growBy : 0)
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true })
  Object.defineProperty(el, "scrollHeight", { get: height, configurable: true })
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v) => { top = Math.max(0, Math.min(v, height() - clientHeight)) },
    configurable: true
  })
}

async function streamingPanelScrolledUp({ growBy = 0, bigDeltas = false } = {}) {
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  // Chunked on purpose: the scroll has to happen while deltas are still
  // arriving, which is the only moment the old code could yank the view.
  streamScript = [ { gap: 70, parts: (bigDeltas
    ? [ 1, 2, 3, 4 ].map((n) => 'event: text_delta\ndata: ' +
        JSON.stringify({ delta: "| col | col | col |\\n".repeat(40) + " part " + n + " " }) + '\n\n')
    : [ 'event: text_delta\ndata: {"delta":"first part. "}\n\n',
        'event: text_delta\ndata: {"delta":"second part. "}\n\n',
        'event: text_delta\ndata: {"delta":"third part. "}\n\n',
        'event: text_delta\ndata: {"delta":"fourth part. "}\n\n' ]
  ).concat([ 'event: done\ndata: {"content":"all of it","finish_reason":"stop"}\n\n' ]) } ]
  const panel = await mount()
  const msgs = panel.querySelector(".lmw-messages")
  giveGeometry(msgs, { clientHeight: 450, scrollHeight: 1049, growBy })
  return { panel, msgs }
}

test("a reader who scrolled up is not dragged back by streaming output", async () => {
  // The bug: wheel, trackpad and keyboard all appeared dead during a long
  // turn, because every delta pinned the view to the end again.
  const { panel, msgs } = await streamingPanelScrolledUp()
  msgs.scrollTop = 100                                   // reading back
  msgs.dispatchEvent(new window.Event("scroll"))         // as a real scroll would

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(100)
  // Sending re-follows on purpose, so scroll away again now that it streams.
  msgs.scrollTop = 100
  msgs.dispatchEvent(new window.Event("scroll"))
  await tick(400)                      // the remaining chunks arrive here

  assert.match(panel.textContent, /fourth part/, "the rest of the turn must have streamed in")
  assert.equal(msgs.scrollTop, 100, "the view must stay where the reader put it")
})

test("a reader at the end still follows the output as it grows", async () => {
  // The panel grows while the turn streams, so following means the view moves
  // WITH the end — not that it stays at one number. Measuring after a change
  // instead of before makes the reader look like they fell behind, and the
  // panel quietly stops following them.
  // ~0.3px per character, roughly what wrapped text costs. A bigger figure
  // makes even a label change blow past SCROLL_PIN_SLACK, which no real layout
  // does; a much smaller one keeps every delta inside the slack, where the
  // timing of the check cannot matter. The deltas below are table-sized, which
  // is when it does.
  const { panel, msgs } = await streamingPanelScrolledUp({ growBy: 0.3, bigDeltas: true })
  msgs.scrollTop = msgs.scrollHeight                     // the end, whatever it is now

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(600)

  assert.ok(msgs.scrollHeight > 1049, "the panel should have grown as it streamed")
  assert.equal(msgs.scrollTop, msgs.scrollHeight - 450, "the view must still be at the end")
})

test("a reader a few pixels short of the end still follows", async () => {
  // Browsers leave fractional gaps, and a reader who meant to be at the end
  // often sits a pixel or two above it. Treating that as "reading back" would
  // silently stop following for someone who never scrolled on purpose.
  const { panel, msgs } = await streamingPanelScrolledUp()
  msgs.scrollTop = 580                                   // 19px short of 599
  msgs.dispatchEvent(new window.Event("scroll"))

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(100)
  msgs.scrollTop = 580
  msgs.dispatchEvent(new window.Event("scroll"))
  await tick(400)

  assert.equal(msgs.scrollTop, 599, "close to the end counts as the end")
})

test("asking a new question brings the reader back to the end", async () => {
  // Otherwise someone who scrolled up, then asked something, would watch a
  // panel that never moves and looks broken.
  const { panel, msgs } = await streamingPanelScrolledUp()
  msgs.scrollTop = 0
  msgs.dispatchEvent(new window.Event("scroll"))

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(200)

  assert.equal(msgs.scrollTop, 599, "the new turn should be visible")
})

// Every kind of mid-turn update has to respect the reader, not just text. On
// the turn where this was reported, thinking blocks and tool chips were
// appearing the whole time, and any one of them pinning is enough to make the
// panel unscrollable again.

test("thinking output does not drag a reader who scrolled up", async () => {
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  // gap 150 so the thinking block is CREATED after the scroll below, not
  // before it: otherwise the site that creates it is never exercised while the
  // reader is away, and pinning there would go unnoticed.
  streamScript = [ { gap: 150, parts: [
    'event: text_delta\ndata: {"delta":"starting. "}\n\n',
    'event: thinking_delta\ndata: {"delta":"considering the first option. "}\n\n',
    'event: thinking_delta\ndata: {"delta":"considering the second option. "}\n\n',
    'event: done\ndata: {"content":"starting. ","finish_reason":"stop"}\n\n'
  ] } ]
  const panel = await mount()
  const msgs = panel.querySelector(".lmw-messages")
  giveGeometry(msgs, { clientHeight: 450, scrollHeight: 1049 })

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(80)
  msgs.scrollTop = 120
  msgs.dispatchEvent(new window.Event("scroll"))
  await tick(700)

  assert.match(panel.textContent, /considering the second option/, "the thinking must have streamed in")
  assert.equal(msgs.scrollTop, 120, "a thinking block and its deltas must not pin the view")
})

test("a tool chip appearing does not drag a reader who scrolled up", async () => {
  window.aiActions = { note_it: () => "done" }
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  streamScript = [
    { gap: 150, parts: [
      'event: text_delta\ndata: {"delta":"about to call. "}\n\n',
      'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"note_it","arguments":{}}}\n\n',
      'event: done\ndata: {"content":"about to call. ","finish_reason":"tool_calls"}\n\n'
    ] },
    'event: done\ndata: {"content":"finished","finish_reason":"stop"}\n\n'
  ]
  await mountWithPage({ typedCards: [ { tools: [ { name: "note_it", description: "d", inputSchema: {} } ] } ] })
  const panel = document.getElementById("llm-meta-widget-chat")
  const msgs = panel.querySelector(".lmw-messages")
  giveGeometry(msgs, { clientHeight: 450, scrollHeight: 1049 })

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(80)
  msgs.scrollTop = 140
  msgs.dispatchEvent(new window.Event("scroll"))
  await tick(700)

  assert.match(panel.textContent, /note_it/, "the tool chip must have been added")
  assert.equal(msgs.scrollTop, 140, "a tool chip must not pin the view")
  delete window.aiActions
})

test("a system notice appearing mid-turn does not drag the reader", async () => {
  // The notice that an old tool result was dropped arrives through appendTurn,
  // in the middle of a turn, exactly when someone might be reading back
  // through what the tool returned.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 64_000 } ] } ] }
  hubServers = [ { uuid: "s1", name: "big", tools: [ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ] } ]
  hubToolResult = { text: "z".repeat(600_000) }
  streamScript = [
    { gap: 150, parts: [
      'event: text_delta\ndata: {"delta":"calling the tool. "}\n\n',
      'event: tool_call\ndata: {"tool_call":{"id":"c1","name":"big_tool","arguments":{}}}\n\n',
      'event: done\ndata: {"content":"calling the tool. ","finish_reason":"tool_calls"}\n\n'
    ] },
    'event: done\ndata: {"content":"finished","finish_reason":"stop"}\n\n'
  ]
  const block = document.createElement("script")
  block.type = "application/json"
  block.id = "remote-mcp-tools"
  block.textContent = JSON.stringify([ { id: "t1", name: "big_tool", description: "d", input_schema: {} } ])
  document.body.innerHTML = ""
  document.body.appendChild(block)
  const el = document.createElement("llm-meta-widget")
  for (const [ k, v ] of Object.entries({ "llm-url": HUB, model: "m1", "well-known-urls": "",
                                          "tool-hub-url": HUB, "remote-tools-schema-id": "remote-mcp-tools" })) {
    el.setAttribute(k, v)
  }
  document.body.appendChild(el)
  await tick(150)
  const panel = document.getElementById("llm-meta-widget-chat")
  const msgs = panel.querySelector(".lmw-messages")
  giveGeometry(msgs, { clientHeight: 450, scrollHeight: 1049 })

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(80)
  msgs.scrollTop = 160
  msgs.dispatchEvent(new window.Event("scroll"))
  await tick(900)

  assert.match(panel.textContent, /Shortened an oversized big_tool result/, "the notice must have appeared")
  assert.equal(msgs.scrollTop, 160, "a system notice must not pin the view")
})

test("a reader who scrolls is not re-pinned before the scroll event arrives", async () => {
  // The race the first fix missed. A browser dispatches `scroll` a frame AFTER
  // the position changes, while deltas arrive every few milliseconds — so a
  // delta can pin the view before the listener learns the reader moved, and
  // the pin then makes atBottom() true again, so the flag never flips.
  //
  // Here the scroll position changes with NO event dispatched, exactly as in
  // the window between a real scroll and its event.
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  streamScript = [ { gap: 70, parts: [
    'event: text_delta\ndata: {"delta":"first. "}\n\n',
    'event: text_delta\ndata: {"delta":"second. "}\n\n',
    'event: text_delta\ndata: {"delta":"third. "}\n\n',
    'event: text_delta\ndata: {"delta":"fourth. "}\n\n',
    'event: done\ndata: {"content":"all","finish_reason":"stop"}\n\n'
  ] } ]
  const panel = await mount()
  const msgs = panel.querySelector(".lmw-messages")
  giveGeometry(msgs, { clientHeight: 450, scrollHeight: 1049 })

  panel.querySelector("textarea").value = "go"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(100)
  msgs.scrollTop = 100              // the reader scrolls; the event has not fired yet
  await tick(400)                   // more deltas land in the meantime

  assert.match(panel.textContent, /fourth/, "the rest of the turn must have streamed in")
  assert.equal(msgs.scrollTop, 100, "the view must stay where the reader put it")
})

// --- collapsing a thinking block (the Chrome wheel-range bug) ------------
//
// Closing a <details> that holds its own scroller, at a moment when that block
// is the only reason the message list overflows, leaves Chrome with a stale
// WHEEL range: the reader can scroll a few pixels and no further, by any input
// method, while scrollTop set from script still works. Confirmed on Chrome 154
// with no widget code involved, and never on Firefox 158.
// https://issues.chromium.org/issues/574960594
//
// The order is the fix: the inner box must stop being a scroller BEFORE the
// close. These assert that order, not merely the end state.

async function turnWithAThinkingBlock() {
  hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
  streamScript = [ { gap: 120, parts: [
    'event: thinking_delta\ndata: {"delta":"weighing the first option. "}\n\n',
    'event: thinking_delta\ndata: {"delta":"weighing the second option. "}\n\n',
    'event: text_delta\ndata: {"delta":"Here is the answer. "}\n\n',
    'event: done\ndata: {"content":"Here is the answer. ","finish_reason":"stop"}\n\n'
  ] } ]
  const panel = await mount()
  panel.querySelector("textarea").value = "think then answer"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(200)                       // the thinking block exists by now
  const details = panel.querySelector("details")
  assert.ok(details, "a thinking block should have been created")

  // Record what the inner box looked like at the instant the close happened.
  const seen = {}
  let open = true
  // Count frames, so the deferral is observable at all: jsdom has no layout, so
  // the only thing a test here can see about "two frames later" is the count.
  let frames = 0
  const realRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (fn) => realRaf(() => { frames++; fn() })
  Object.defineProperty(details, "open", {
    configurable: true,
    get: () => open,
    set: (v) => {
      if (v === false && !("overflowAtClose" in seen)) {
        const body = details.querySelector(".message-thinking-content")
        seen.overflowAtClose = body && body.style.overflow
        seen.maxHeightAtClose = body && body.style.maxHeight
        seen.framesBeforeClose = frames
      }
      open = v
    }
  })
  await tick(600)                       // the text delta collapses it
  globalThis.requestAnimationFrame = realRaf
  return { panel, details, seen }
}

test("the inner box stops scrolling before the block is closed", async () => {
  const { seen } = await turnWithAThinkingBlock()

  assert.equal(seen.overflowAtClose, "visible",
    "the scroller must be gone BEFORE open=false, which is the whole fix")
  assert.equal(seen.maxHeightAtClose, "none")
})

test("the close waits two frames after the scroller is removed", async () => {
  // Chrome needs a frame to pick up the new overflow before the close lands;
  // one frame was not enough in testing. Closing in the same task as the style
  // change is what reproduced the stale wheel range.
  const { seen } = await turnWithAThinkingBlock()

  assert.ok(seen.framesBeforeClose >= 2,
    `the close should land two frames later, got ${seen.framesBeforeClose}`)
})

test("the block really does end up closed and labelled finished", async () => {
  const { panel, details } = await turnWithAThinkingBlock()

  assert.equal(details.open, false, "it must still collapse")
  assert.match(panel.textContent, /thinking \(finished\)/)
})

test("a finished thinking block stops reading as active", async () => {
  // .thinking-active is what marks a block as still running; left on, a
  // finished block keeps whatever the active styling says.
  const { details } = await turnWithAThinkingBlock()

  assert.equal(details.classList.contains("thinking-active"), false)
})

test("the block still closes where requestAnimationFrame does not exist", async () => {
  // The deferral is a workaround for one browser; the block closing is the
  // behaviour. Somewhere without rAF it must still close, not stay open for
  // ever.
  const real = globalThis.requestAnimationFrame
  delete globalThis.requestAnimationFrame
  try {
    hubLlms = { llms: [ { family: "ollama", available_models: [ { value: "m1", label: "m1" } ] } ] }
    streamScript = [ { gap: 120, parts: [
      'event: thinking_delta\ndata: {"delta":"weighing it. "}\n\n',
      'event: text_delta\ndata: {"delta":"The answer. "}\n\n',
      'event: done\ndata: {"content":"The answer. ","finish_reason":"stop"}\n\n'
    ] } ]
    const panel = await mount()
    panel.querySelector("textarea").value = "think then answer"
    panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
    await tick(600)

    const details = panel.querySelector("details")
    assert.ok(details, "the thinking block should still be built")
    assert.equal(details.open, false, "and it must still end up closed")
  } finally {
    globalThis.requestAnimationFrame = real
  }
})

// --- reference data that did not fit --------------------------------------
//
// It used to vanish with only a console line: the model answered from less than
// the page offered and nobody was told. The MODEL is deliberately not told —
// it cannot fetch a resource, so the notice would cost tokens for nothing —
// but the reader can act on it.

async function turnWithAnOversizedResource(declaredSize) {
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 32_768 }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "R".repeat(declaredSize) }
  await mountWithPage({ card: { resources: [
    { uri: "page:big_ref", name: "BigRef", description: "a large reference", size: declaredSize }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")
  const system = await systemPromptAfterATurn(panel)
  delete globalThis.window.aiResources
  return { panel, system }
}

test("a reference refused for size is reported to the reader", async () => {
  // 20,000 bytes against a 32k model's 8,192-byte budget.
  const { panel, system } = await turnWithAnOversizedResource(20_000)

  assert.match(panel.textContent, /Did not attach the BigRef reference/)
  assert.match(panel.textContent, /20 KB/)
  assert.match(panel.textContent, /8 KB for reference data/)
  assert.match(panel.textContent, /larger context window/)
  assert.doesNotMatch(system, /Did not attach/, "the model is not told: it cannot act on it")
})

test("the notice is given once, not on every turn", async () => {
  // The budget has not changed between the turns, so the refusal is the same
  // fact twice — saying it again would be noise in somebody else's page.
  const { panel } = await turnWithAnOversizedResource(20_000)
  globalThis.window.aiResources = { "page:big_ref": () => "R".repeat(20_000) }
  await systemPromptAfterATurn(panel)
  delete globalThis.window.aiResources

  const said = (panel.textContent.match(/Did not attach the BigRef/g) || []).length
  assert.equal(said, 1, `two turns, one notice — got ${said}`)
})

test("a reference that fits produces no notice", async () => {
  const { panel } = await turnWithAnOversizedResource(2_000)

  assert.doesNotMatch(panel.textContent, /Did not attach/)
})

test("a reference the page withholds on purpose is not reported", async () => {
  // autoAttach:false is the page author's decision, not an omission.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 32_768 } ] } ] }
  globalThis.window.aiResources = { "page:held": () => "small" }
  await mountWithPage({ card: { resources: [
    { uri: "page:held", name: "Held", description: "d", size: 100,
      _meta: { "io.modelcontextprotocol/static-primitives": { autoAttach: false } } }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")
  await systemPromptAfterATurn(panel)

  assert.doesNotMatch(panel.textContent, /Did not attach/)
  delete globalThis.window.aiResources
})

test("a host-wide reference refused for size is reported too", async () => {
  // This is the path PubDictionaries' catalog takes — a resource from a
  // host-wide MCP server, not from the page card. Both paths record a refusal,
  // and only a test per path can show it.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 32_768 } ] } ] }
  // The manifest publishes servers with their tools; endpoints are learned
  // from it, which is how the resource listing is reached at all.
  hostManifest = { servers: [ { url: "https://host.example/host-mcp",
                                tools: [ { name: "search", description: "d", input_schema: {} } ] } ] }
  // mimeType matters: loadHostResource only considers application/json, so a
  // fixture without it offers no candidate and the test proves nothing.
  hostResources = [ { uri: "catalog://dictionaries", name: "Dictionary catalog",
                      description: "every dictionary", size: 40_000,
                      mimeType: "application/json" } ]

  const panel = await mount({ "well-known-urls": "https://host.example/.well-known/mcp.json" }, 300)
  panel.querySelector("textarea").value = "which dictionaries exist"
  panel.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  await tick(250)

  assert.match(panel.textContent, /Did not attach the Dictionary catalog reference/)
  assert.match(panel.textContent, /39 KB/)
})

test("a second refusal is counted, not listed one by one", async () => {
  globalThis.window.aiResources = {
    "page:a": () => "A".repeat(20_000), "page:b": () => "B".repeat(20_000)
  }
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "m1", supports_tools: true, max_input_tokens: 32_768 } ] } ] }
  await mountWithPage({ card: { resources: [
    { uri: "page:a", name: "RefA", description: "d", size: 20_000 },
    { uri: "page:b", name: "RefB", description: "d", size: 20_000 }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")
  await systemPromptAfterATurn(panel)

  assert.match(panel.textContent, /Did not attach the RefA reference and 1 other reference/)
  delete globalThis.window.aiResources
})

test("switching to a model with less room reports the refusal again", async () => {
  // The budget follows the model, so the same reference can be affordable on
  // one and not on the next. Saying it once per session would leave a reader
  // who switched down wondering why the answer got vaguer.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "roomy", supports_tools: true, max_input_tokens: 1_000_000 },
    { value: "m2", label: "tight", supports_tools: true, max_input_tokens: 32_768 }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "R".repeat(20_000) }
  await mountWithPage({ card: { resources: [
    { uri: "page:big_ref", name: "BigRef", description: "d", size: 20_000 }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")

  const before = await systemPromptAfterATurn(panel)
  assert.match(before, /RRRR/, "the roomy model affords it, so no notice yet")
  assert.doesNotMatch(panel.textContent, /Did not attach/)

  const picker = panel.querySelector("select")
  picker.value = "m2"
  picker.dispatchEvent(new window.Event("change", { bubbles: true }))
  await systemPromptAfterATurn(panel)

  assert.match(panel.textContent, /Did not attach the BigRef reference/,
    "after switching down, the reference no longer fits and the reader is told")
  delete globalThis.window.aiResources
})

test("switching between two models that both refuse says it again, with the new figures", async () => {
  // Once-per-budget, not once-per-session. A reader who switches and still does
  // not get the reference should be told under the new budget — otherwise the
  // first notice looks like it was dealt with.
  hubLlms = { llms: [ { family: "ollama", available_models: [
    { value: "m1", label: "small", supports_tools: true, max_input_tokens: 32_768 },
    { value: "m2", label: "medium", supports_tools: true, max_input_tokens: 48_000 }
  ] } ] }
  globalThis.window.aiResources = { "page:big_ref": () => "R".repeat(20_000) }
  await mountWithPage({ card: { resources: [
    { uri: "page:big_ref", name: "BigRef", description: "d", size: 20_000 }
  ] } })
  const panel = document.getElementById("llm-meta-widget-chat")

  await systemPromptAfterATurn(panel)
  assert.equal((panel.textContent.match(/Did not attach the BigRef/g) || []).length, 1,
    "refused on the 32k model")

  const picker = panel.querySelector("select")
  picker.value = "m2"
  picker.dispatchEvent(new window.Event("change", { bubbles: true }))
  await systemPromptAfterATurn(panel)

  // 48,000 * 6.25% * 4 = 12,000 bytes, still short of 20,000.
  assert.equal((panel.textContent.match(/Did not attach the BigRef/g) || []).length, 2,
    "and refused again on the 48k model, under its own budget")
  assert.match(panel.textContent, /12 KB for reference data/)
  delete globalThis.window.aiResources
})
