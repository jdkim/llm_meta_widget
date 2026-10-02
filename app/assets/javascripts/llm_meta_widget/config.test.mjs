// Tests for <llm-meta-widget>'s attribute reading.
//
// The panel's logic has never had unit tests — only ESLint and the browser e2e
// runs — so the custom-element move was deliberately split: the half that can
// be tested headlessly is config.js, and these are its tests. They exist mostly
// to pin the three conventions that are easy to get backwards (value-not-boolean
// pickers, tri-state well-known-urls, "" meaning absent for the allowlists),
// because each of those fails quietly rather than loudly.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readConfig, DEFAULTS } from "./config.js"

// readConfig only needs hasAttribute/getAttribute, so no DOM is required.
function el(attrs = {}) {
  return {
    hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
  }
}

const MINIMAL = { "llm-url": "https://hub.example", model: "m" }

test("reads the two required attributes", () => {
  const c = readConfig(el(MINIMAL))
  assert.equal(c.LLM_BASE, "https://hub.example")
  assert.equal(c.MODEL, "m")
})

test("falls back to the documented defaults for everything optional", () => {
  const c = readConfig(el(MINIMAL))
  assert.equal(c.API_KEY_UUID, DEFAULTS.API_KEY_UUID)
  assert.equal(c.ACTIONS_SCHEMA_ID, DEFAULTS.ACTIONS_SCHEMA_ID)
  assert.equal(c.STATE_GLOBAL, DEFAULTS.STATE_GLOBAL)
  assert.equal(c.ACTIONS_GLOBAL, DEFAULTS.ACTIONS_GLOBAL)
  assert.equal(c.REMOTE_TOOLS_SCHEMA_ID, DEFAULTS.REMOTE_TOOLS_SCHEMA_ID)
  assert.equal(c.LLM_PROVIDER, DEFAULTS.LLM_PROVIDER)
  assert.equal(c.MAX_ROUNDS, DEFAULTS.MAX_ROUNDS)
  assert.equal(c.GREETING, null)
  assert.equal(c.TOOL_HUB_BASE, null)
})

// --- tool hub, and the picker that depends on it ---------------------------

test("an absent tool-hub-url means no Class 1, and an empty one is the same thing", () => {
  assert.equal(readConfig(el(MINIMAL)).TOOL_HUB_BASE, null)
  assert.equal(readConfig(el({ ...MINIMAL, "tool-hub-url": "" })).TOOL_HUB_BASE, null)
})

test("the tool picker needs a hub, whatever the attribute says", () => {
  // Class 1 tools are registered on a hub; without one there is nothing to pick.
  assert.equal(readConfig(el(MINIMAL)).ENABLE_TOOL_PICKER, false)
  assert.equal(
    readConfig(el({ ...MINIMAL, "enable-tool-picker": "true" })).ENABLE_TOOL_PICKER,
    false,
    "asking for the picker without a hub must not enable it",
  )
  assert.equal(
    readConfig(el({ ...MINIMAL, "tool-hub-url": "https://hub.example" })).ENABLE_TOOL_PICKER,
    true,
  )
})

// --- the pickers are VALUE attributes, not HTML boolean attributes ---------

test("pickers default to true, so only the exact string false disables them", () => {
  const withHub = { ...MINIMAL, "tool-hub-url": "https://hub.example" }
  assert.equal(readConfig(el(withHub)).ENABLE_MODEL_PICKER, true)
  assert.equal(readConfig(el(withHub)).ENABLE_TOOL_PICKER, true)

  assert.equal(readConfig(el({ ...withHub, "enable-model-picker": "false" })).ENABLE_MODEL_PICKER, false)
  assert.equal(readConfig(el({ ...withHub, "enable-tool-picker": "false" })).ENABLE_TOOL_PICKER, false)

  // Presence alone must NOT mean false — the HTML boolean-attribute habit would
  // read `enable-model-picker` as "disabled", which is backwards here.
  assert.equal(readConfig(el({ ...withHub, "enable-model-picker": "" })).ENABLE_MODEL_PICKER, true)
  assert.equal(readConfig(el({ ...withHub, "enable-model-picker": "no" })).ENABLE_MODEL_PICKER, true)
})

// --- well-known-urls is tri-state -----------------------------------------

test("well-known-urls: absent means auto-discover same-origin", () => {
  assert.equal(readConfig(el(MINIMAL)).WELL_KNOWN_URLS, null)
})

test("well-known-urls: empty means discovery OFF, which null would not", () => {
  // This is the whole reason for the convention: null and [] mean different
  // things downstream, and an attribute cannot express the difference.
  assert.deepEqual(readConfig(el({ ...MINIMAL, "well-known-urls": "" })).WELL_KNOWN_URLS, [])
  assert.deepEqual(readConfig(el({ ...MINIMAL, "well-known-urls": "   " })).WELL_KNOWN_URLS, [])
})

test("well-known-urls: a value is split, trimmed and de-blanked", () => {
  const c = readConfig(el({ ...MINIMAL, "well-known-urls": " https://a/.well-known/mcp.json , https://b/x ,, " }))
  assert.deepEqual(c.WELL_KNOWN_URLS, ["https://a/.well-known/mcp.json", "https://b/x"])
})

// --- allowlists ------------------------------------------------------------

test("models / hub-tools: absent means no allowlist", () => {
  const c = readConfig(el(MINIMAL))
  assert.equal(c.MODEL_ALLOWLIST, null)
  assert.equal(c.HUB_TOOLS_ALLOWLIST, null)
})

test("models / hub-tools: empty is treated as absent, not as an empty allowlist", () => {
  // An allowlist permitting nothing would silently offer zero models, which is
  // never what anyone meant by models="".
  assert.equal(readConfig(el({ ...MINIMAL, models: "" })).MODEL_ALLOWLIST, null)
  assert.equal(readConfig(el({ ...MINIMAL, "hub-tools": "  " })).HUB_TOOLS_ALLOWLIST, null)
})

test("models / hub-tools: split, trimmed, blanks dropped", () => {
  const c = readConfig(el({ ...MINIMAL, models: "a, b ,,c", "hub-tools": " TogoMCP ,pubdictionaries" }))
  assert.deepEqual(c.MODEL_ALLOWLIST, ["a", "b", "c"])
  assert.deepEqual(c.HUB_TOOLS_ALLOWLIST, ["TogoMCP", "pubdictionaries"])
})

// --- numbers ---------------------------------------------------------------

test("max-rounds parses, and a non-number falls back rather than becoming NaN", () => {
  assert.equal(readConfig(el({ ...MINIMAL, "max-rounds": "12" })).MAX_ROUNDS, 12)
  // NaN here would make the chat loop terminate immediately and look like the
  // model refusing to act, so falling back matters.
  assert.equal(readConfig(el({ ...MINIMAL, "max-rounds": "lots" })).MAX_ROUNDS, DEFAULTS.MAX_ROUNDS)
  assert.equal(readConfig(el({ ...MINIMAL, "max-rounds": "" })).MAX_ROUNDS, DEFAULTS.MAX_ROUNDS)
})

// --- shape -----------------------------------------------------------------

test("returns exactly the sixteen keys the panel logic reads", () => {
  // The logic moved from the ERB template unchanged, so it still reads these
  // names. A key going missing here would surface as an undefined deep inside
  // the panel rather than as a clear error.
  assert.deepEqual(Object.keys(readConfig(el(MINIMAL))).sort(), [
    "ACTIONS_GLOBAL", "ACTIONS_SCHEMA_ID", "API_KEY_UUID", "ENABLE_MODEL_PICKER",
    "ENABLE_TOOL_PICKER", "GREETING", "HUB_TOOLS_ALLOWLIST", "LLM_BASE",
    "LLM_PROVIDER", "MAX_ROUNDS", "MODEL", "MODEL_ALLOWLIST",
    "REMOTE_TOOLS_SCHEMA_ID", "STATE_GLOBAL", "TOOL_HUB_BASE", "WELL_KNOWN_URLS",
  ])
})

test("tolerates being handed nothing at all", () => {
  // The element bails with a clear error when llm-url/model are missing; this
  // just checks readConfig itself does not throw first.
  const c = readConfig(el({}))
  assert.equal(c.LLM_BASE, null)
  assert.equal(c.MODEL, null)
  assert.equal(c.MAX_ROUNDS, DEFAULTS.MAX_ROUNDS)
})
