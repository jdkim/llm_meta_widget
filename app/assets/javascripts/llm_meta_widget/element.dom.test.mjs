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

function installGlobals() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example/page" })
  const { window } = dom
  for (const k of [ "window", "document", "HTMLElement", "customElements", "Event", "CustomEvent",
                    "Node", "getComputedStyle", "sessionStorage", "localStorage", "location" ]) {
    globalThis[k] = window[k]
  }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
  globalThis.fetch = async (url) => {
    const u = String(url)
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
beforeEach(() => { hubServers = [] })

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
