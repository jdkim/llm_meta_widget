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
let sentBodies = []
// Set to override the /api/llms answer for one test.
let hubLlms = null

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
    if (u.includes("single_llm_calls")) {
      sentBodies.push(JSON.parse(init.body || "{}"))
      return new Response('event: done\ndata: {"content":"ok","finish_reason":"stop"}\n\n',
                          { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    if (u.includes("/api/llms"))        return json(hubLlms || { llms: [ { models: [ { value: "m1" }, { value: "m2" } ] } ] })
    if (/\/api\/mcp_servers\/[^/]+\/tools/.test(u)) {
      const uuid = u.match(/mcp_servers\/([^/]+)\/tools/)[1]
      const s = hubServers.find((x) => x.uuid === uuid)
      return json({ tools: (s && s.tools) || [] })
    }
    if (u.includes("/api/mcp_servers")) return json({ mcp_servers: hubServers })
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
beforeEach(() => { hubServers = []; sentBodies = []; hubLlms = null })

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
async function mountWithPage({ card, actions }) {
  document.body.innerHTML = ""
  if (actions) putActionsTag(actions)
  if (card) putCard(card)
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
