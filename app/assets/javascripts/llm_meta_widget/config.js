// Attribute reading for <llm-meta-widget>.
//
// Separate from element.js so it can be unit-tested without a DOM and without
// the bundler: it takes anything with hasAttribute/getAttribute, so the tests
// pass a plain object. The panel's own logic has never had unit tests — this is
// the half of the custom-element move that can have them, so it does.
//
// Three cases are not obvious, and are the ones adopters get wrong:
//
//   * The pickers default to TRUE, so they cannot be HTML boolean attributes
//     (presence-means-true would be backwards — you would have to add an
//     attribute to get the default). They are value attributes: disable with
//     enable-tool-picker="false". Any other value, including "", is true.
//   * well-known-urls is TRI-state, because the Ruby option distinguished nil
//     (auto-discover same-origin /.well-known/mcp.json) from [] (discovery off)
//     from an explicit list, and attributes cannot express nil versus empty:
//       absent  -> null  (auto-discover)
//       ""      -> []    (off)
//       "a,b"   -> ["a","b"]
//   * models / hub-tools treat "" as absent rather than as an empty allowlist,
//     because an allowlist that permits nothing is never what anyone meant.
//
// Key names are the UPPER_CASE ones the panel logic already used, so that logic
// moved across untouched.

export const DEFAULTS = Object.freeze({
  API_KEY_UUID:           "ollama-local",
  ACTIONS_SCHEMA_ID:      "ai-actions",
  STATE_GLOBAL:           "aiState",
  ACTIONS_GLOBAL:         "aiActions",
  REMOTE_TOOLS_SCHEMA_ID: "remote-mcp-tools",
  LLM_PROVIDER:           "llm_meta_server",
  MAX_ROUNDS:             3,
});

const splitList = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);

export function readConfig(el) {
  const raw = (n) => (el && el.hasAttribute(n) ? el.getAttribute(n) : null);
  const str = (n, d) => { const v = raw(n); return v === null ? d : v; };
  const bool = (n, d) => { const v = raw(n); return v === null ? d : v !== "false"; };
  const int = (n, d) => {
    const v = raw(n);
    if (v === null) return d;
    const i = parseInt(v, 10);
    return Number.isNaN(i) ? d : i;
  };
  const list = (n) => {
    const v = raw(n);
    return v === null || v.trim() === "" ? null : splitList(v);
  };

  const toolHub = str("tool-hub-url", null) || null;   // "" collapses to null
  const wellKnown = raw("well-known-urls");

  return {
    LLM_BASE:               str("llm-url", null),
    TOOL_HUB_BASE:          toolHub,
    API_KEY_UUID:           str("api-key-uuid", DEFAULTS.API_KEY_UUID),
    MODEL:                  str("model", null),
    ACTIONS_SCHEMA_ID:      str("actions-schema-id", DEFAULTS.ACTIONS_SCHEMA_ID),
    GREETING:               str("greeting", null),
    STATE_GLOBAL:           str("state-global", DEFAULTS.STATE_GLOBAL),
    ACTIONS_GLOBAL:         str("actions-global", DEFAULTS.ACTIONS_GLOBAL),
    REMOTE_TOOLS_SCHEMA_ID: str("remote-tools-schema-id", DEFAULTS.REMOTE_TOOLS_SCHEMA_ID),
    MAX_ROUNDS:             int("max-rounds", DEFAULTS.MAX_ROUNDS),
    WELL_KNOWN_URLS:        wellKnown === null
                              ? null
                              : (wellKnown.trim() === "" ? [] : splitList(wellKnown)),
    LLM_PROVIDER:           str("llm-provider", DEFAULTS.LLM_PROVIDER),
    ENABLE_MODEL_PICKER:    bool("enable-model-picker", true),
    // Class 1 tools are registered on a hub, so the picker needs one — which is
    // independent of who answers the chat. Page actions and the host's own
    // .well-known MCP work regardless.
    ENABLE_TOOL_PICKER:     bool("enable-tool-picker", true) && toolHub !== null,
    MODEL_ALLOWLIST:        list("models"),
    HUB_TOOLS_ALLOWLIST:    list("hub-tools"),
  };
}
