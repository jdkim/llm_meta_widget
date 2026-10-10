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
    if (u.includes("/api/llms"))        return json({ llms: [ { models: [ { value: "m1" }, { value: "m2" } ] } ] })
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
beforeEach(() => { hubServers = []; sentBodies = [] })

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
