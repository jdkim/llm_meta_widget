// The chat panel as a custom element.
//
// Previously this lived as inline script inside _chat_panel.html.erb, which
// made the widget a Rails-only artefact: a host needed the engine to render the
// template and to serve the assets. The logic was never Rails-specific — the
// template contributed one helper call and sixteen injected `var`s — so it now
// lives here, reads its configuration from attributes, and is bundled into a
// single ES module any host can load:
//
//   <script type="module" src=".../llm-meta-widget.js"></script>
//   <llm-meta-widget llm-url="https://hub.example" model="qwen3-8-27b-fast">
//   </llm-meta-widget>
//
// No shadow DOM, deliberately: the styles are global today, the e2e suite and
// adopters both reach in with ordinary selectors, and isolation would break
// every one of them for no benefit yet. See docs/custom-element-distribution.md.
//
// The host page's contract is unchanged — `window.aiState`, `window.aiActions`
// and the `#ai-actions` JSON block are still page-level globals, because they
// belong to the host, not to this element.
import { runChatLoop, fetchMcpManifest, listMcpPrompts, getMcpPrompt,
         listMcpResources, readMcpResource, promptMessagesToText,
         loadHostResource, resourceLinesForTurn, resolvePromptArguments,
         promptButtonProps, promptArgumentSummary, fetchOllamaModels,
         createConversationStore, conversationKeyFor } from "./orchestrator.js";
import { marked } from "./marked.esm.js";
import { readConfig } from "./config.js";
import conversationCss from "../../stylesheets/llm_meta_widget/conversation.css";
import panelCss from "../../stylesheets/llm_meta_widget/panel.css";

// Standard prose settings — GFM (tables, autolinks, strikethrough), break
// single newlines into <br> so streamed LLM output that uses bare newlines
// still reads naturally.
marked.setOptions({ gfm: true, breaks: true });

const MARKUP = `
<button type="button" id="llm-meta-widget-toggle" title="Open AI assistant" aria-label="Open AI assistant">
	<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
		<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3l-3.5 3.5V12H4a2 2 0 0 1-2-2V4Zm3 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>
	</svg>
</button>

<div id="llm-meta-widget-chat" class="llm-meta-conversation">
	<div class="lmw-header">
		<span class="lmw-title-group">
			<span class="lmw-title">AI assistant</span>
			<span class="lmw-powered">(powered by <a href="https://chat.aibranch.org/" target="_blank" rel="noopener noreferrer">AIbranch</a>)</span>
		</span>
		<div class="lmw-header-right">
			<button type="button" class="lmw-clear" title="Clear conversation">clear</button>
			<button type="button" class="lmw-hide" title="Hide">−</button>
		</div>
	</div>
	<div class="lmw-messages"></div>
	<div class="lmw-input-container">
		<div class="lmw-prompts" style="display:none"></div>
		<form class="lmw-form">
			<div class="lmw-input-wrapper">
				<textarea class="lmw-input" placeholder="Enter your message..." rows="2" autocomplete="off"></textarea>
				<button type="submit" class="lmw-send" title="Send message">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M15.964.686a.5.5 0 0 0-.65-.65L.293 6.011a.513.513 0 0 0 .002.947l4.708 1.878 8.94-6.94-6.94 8.94 1.879 4.708c.163.407.756.416.951.016l6.13-13.884Z"/>
					</svg>
				</button>
			</div>
			<div class="lmw-input-controls">
				<select class="lmw-model-picker" title="Select model" aria-label="Select model" style="display:none">
				</select>
				<details class="lmw-tools-picker">
					<summary>
						🔧 Tools
						<span class="lmw-tools-count lmw-tools-count-zero">0</span>
					</summary>
					<div class="lmw-tools-list">
						<div class="lmw-tools-empty">Loading…</div>
					</div>
				</details>
			</div>
		</form>
	</div>
</div>
`;

let stylesInjected = false;
function injectStylesOnce(doc) {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = doc.createElement("style");
  style.setAttribute("data-llm-meta-widget", "styles");
  style.textContent = conversationCss + "\n" + panelCss;
  doc.head.appendChild(style);
}

export class LlmMetaWidgetElement extends HTMLElement {
  connectedCallback() {
    if (this.__lmwWired) return;             // moving the node must not re-boot
    this.__lmwWired = true;

    if (!this.getAttribute("llm-url") || !this.getAttribute("model")) {
      console.error("[llm-meta-widget] llm-url and model are both required attributes; not starting.");
      return;
    }
    // The panel uses fixed element ids, so a second instance would fight the
    // first over every lookup. One per page; see the design note's open
    // question on multi-instance support.
    if (document.getElementById("llm-meta-widget-chat")) {
      console.warn("[llm-meta-widget] a widget is already on this page; ignoring this one.");
      return;
    }

    injectStylesOnce(document);
    this.insertAdjacentHTML("beforeend", MARKUP);
    boot(readConfig(this));
  }
}

if (typeof customElements !== "undefined" && !customElements.get("llm-meta-widget")) {
  customElements.define("llm-meta-widget", LlmMetaWidgetElement);
}

// Everything below is the panel's original logic, moved verbatim from the ERB
// template. The only change is the sixteen bindings above it, which the
// template used to inject.
// Removes a node if it is there. Used to honour the picker flags: see boot().
function dropNode(node) {
	if (node && node.parentNode) node.parentNode.removeChild(node);
}

function boot(cfg) {
  var LLM_BASE               = cfg.LLM_BASE;
  var TOOL_HUB_BASE          = cfg.TOOL_HUB_BASE;
  var API_KEY_UUID           = cfg.API_KEY_UUID;
  var MODEL                  = cfg.MODEL;
  var ACTIONS_SCHEMA_ID      = cfg.ACTIONS_SCHEMA_ID;
  var GREETING               = cfg.GREETING;
  var STATE_GLOBAL           = cfg.STATE_GLOBAL;
  var ACTIONS_GLOBAL         = cfg.ACTIONS_GLOBAL;
  var REMOTE_TOOLS_SCHEMA_ID = cfg.REMOTE_TOOLS_SCHEMA_ID;
  var MAX_ROUNDS             = cfg.MAX_ROUNDS;
  var WELL_KNOWN_URLS        = cfg.WELL_KNOWN_URLS;
  var LLM_PROVIDER           = cfg.LLM_PROVIDER;
  var ENABLE_MODEL_PICKER    = cfg.ENABLE_MODEL_PICKER;
  var ENABLE_TOOL_PICKER     = cfg.ENABLE_TOOL_PICKER;
  var MODEL_ALLOWLIST        = cfg.MODEL_ALLOWLIST;
  var HUB_TOOLS_ALLOWLIST    = cfg.HUB_TOOLS_ALLOWLIST;

  	var root         = document.getElementById("llm-meta-widget-chat");
  	var toggleBtn    = document.getElementById("llm-meta-widget-toggle");
  	var historyEl    = root.querySelector(".lmw-messages");
  	var formEl       = root.querySelector(".lmw-form");
  	var inputEl      = root.querySelector(".lmw-input");
  	var clearBtn     = root.querySelector(".lmw-clear");
  	var hideBtn      = root.querySelector(".lmw-hide");
  	// The ERB partial omitted these nodes entirely when their flag was false.
  	// One static template cannot express that, so prune instead — otherwise a
  	// disabled Tools picker still renders, and the lookups below never return
  	// the null the rest of boot() is written against.
  	if (!ENABLE_MODEL_PICKER) dropNode(root.querySelector(".lmw-model-picker"));
  	if (!ENABLE_TOOL_PICKER) dropNode(root.querySelector(".lmw-tools-picker"));
  	if (!ENABLE_MODEL_PICKER && !ENABLE_TOOL_PICKER) dropNode(root.querySelector(".lmw-input-controls"));

  	var modelPicker  = root.querySelector(".lmw-model-picker");   // null when disabled
  	var toolsPicker  = root.querySelector(".lmw-tools-picker");   // null when disabled
  	var toolsListEl  = root.querySelector(".lmw-tools-list");     // null when disabled
  	var toolsCountEl = root.querySelector(".lmw-tools-count");    // null when disabled

  	// Persistence keys — open/close state + resized geometry (width/height).
  	// Position is re-computed each open so the widget lands at bottom-right
  	// of the CURRENT viewport (not wherever the user resized it last time).
  	// Size is preserved because that's a user preference; position is a
  	// spawn convention.
  	var STORAGE_KEY_OPEN = "llm_meta_widget:open";
  	var STORAGE_KEY_SIZE = "llm_meta_widget:size";  // stored as "WxH" in px

  	// Floors matching the CSS min-width/min-height (24em / 16em). A panel
  	// measured mid-layout reports a few pixels; saving that produced a sliver
  	// anchored off the bottom of the window, and — worse — it was stored, so
  	// every later visit reopened at the sliver size. Sizes below the floor are
  	// neither saved nor honoured, which also heals a value already stored.
  	var MIN_SAVED_WIDTH  = 320;
  	var MIN_SAVED_HEIGHT = 240;

  	function plausibleSize(w, h) {
  		return w >= MIN_SAVED_WIDTH && h >= MIN_SAVED_HEIGHT &&
  		       w <= window.innerWidth * 2 && h <= window.innerHeight * 2;
  	}

  	function applyStoredSize() {
  		try {
  			var raw = localStorage.getItem(STORAGE_KEY_SIZE);
  			if (!raw) return;
  			var parts = raw.split("x");
  			var w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
  			if (!plausibleSize(w, h)) {
  				localStorage.removeItem(STORAGE_KEY_SIZE);   // heal a bad value
  				return;
  			}
  			root.style.width  = w + "px";
  			root.style.height = h + "px";
  		} catch (e) { /* noop */ }
  	}
  	function saveCurrentSize() {
  		try {
  			var rect = root.getBoundingClientRect();
  			var w = Math.round(rect.width), h = Math.round(rect.height);
  			if (!plausibleSize(w, h)) return;   // layout noise, not a choice
  			localStorage.setItem(STORAGE_KEY_SIZE, w + "x" + h);
  		} catch (e) { /* noop */ }
  	}

  	// Anchor the widget at bottom-right of the viewport, given whatever
  	// size it currently has. Uses top/left in pixels (required for CSS
  	// `resize: both` — a bottom/right-pinned element can't be dragged out
  	// past the viewport edge to grow).
  	function positionAtBottomRight(attempt) {
  		var margin = 16;  // ~1em from the viewport edges
  		var rect = root.getBoundingClientRect();
  		var top  = Math.max(margin, window.innerHeight - rect.height - margin);
  		var left = Math.max(margin, window.innerWidth  - rect.width  - margin);
  		root.style.top  = top  + "px";
  		root.style.left = left + "px";

  		// Measured before layout settled: the panel reports a sliver and gets
  		// anchored to the very bottom of the window. Re-measure next frame.
  		var tries = attempt || 0;
  		if (rect.height < MIN_SAVED_HEIGHT && tries < 3 && typeof requestAnimationFrame === "function") {
  			requestAnimationFrame(function() { positionAtBottomRight(tries + 1); });
  		}
  	}

  	function setOpen(open) {
  		if (open) {
  			applyStoredSize();          // restore user's preferred size (if any)
  			root.classList.remove("lmw-collapsed");
  			toggleBtn.classList.add("lmw-hidden");
  			// Position AFTER unhiding so getBoundingClientRect returns real size.
  			positionAtBottomRight();
  			try { inputEl.focus(); } catch (e) { /* noop */ }
  			// Fire-and-forget the hub-picker fetch on first open; subsequent
  			// opens are no-ops (pickerLoaded flag). We deliberately don't
  			// await — the widget is immediately usable with the initial MODEL
  			// and no hub tools; pickers populate a moment later.
  			ensurePickerLoaded().catch(function(e) { console.warn("[widget] picker load failed:", e); });
  		} else {
  			saveCurrentSize();          // capture whatever the user resized to
  			root.classList.add("lmw-collapsed");
  			toggleBtn.classList.remove("lmw-hidden");
  		}
  		try { localStorage.setItem(STORAGE_KEY_OPEN, open ? "1" : "0"); } catch (e) { /* noop */ }
  	}
  	var initialOpen = false;
  	try { initialOpen = localStorage.getItem(STORAGE_KEY_OPEN) === "1"; } catch (e) { /* noop */ }
  	setOpen(initialOpen);
  	window.addEventListener("resize", function() {
  		if (!root.classList.contains("lmw-collapsed")) positionAtBottomRight();
  	});

  	toggleBtn.addEventListener("click", function() { setOpen(true); });
  	hideBtn.addEventListener("click", function() { setOpen(false); });

  	// Persist size on every resize interaction. ResizeObserver fires
  	// continuously during a drag; save + reposition on each tick so the
  	// widget stays anchored to bottom-right as the user grows it.
  	if (typeof ResizeObserver === "function") {
  		var sawFirstResizeTick = false;
  		var ro = new ResizeObserver(function() {
  			if (root.classList.contains("lmw-collapsed")) return;
  			positionAtBottomRight();
  			// ResizeObserver always delivers an initial observation, and that
  			// one reports whatever the layout happened to be mid-boot. Only
  			// later ticks can be a user dragging the corner.
  			if (!sawFirstResizeTick) { sawFirstResizeTick = true; return; }
  			saveCurrentSize();
  		});
  		ro.observe(root);
  	}

  	// [{role, content, tools}] — grows across turns. `tools` is for the
  	// transcript only; the model is sent role and content.
  	var conversation = [];

  	// A page action that navigates used to take the conversation with it. The
  	// transcript lives in sessionStorage — per tab, gone when the tab closes —
  	// keyed by path, so submitting a form and landing back on the same page
  	// with a new query string keeps the thread.
  	var conversationStore = createConversationStore({
  		storage: window.sessionStorage,
  		key:     conversationKeyFor(window.location)
  	});

  	function persistConversation() {
  		conversationStore.save({
  			turns: conversation,
  			open:  !root.classList.contains("lmw-collapsed"),
  			model: MODEL
  		});
  	}
  	var actionsSchemaEl = document.getElementById(ACTIONS_SCHEMA_ID);
  	var localTools = actionsSchemaEl ? JSON.parse(actionsSchemaEl.textContent) : [];
  	var remoteToolsEl = document.getElementById(REMOTE_TOOLS_SCHEMA_ID);
  	// remoteTools is a mutable live list: starts from the schema-provided
  	// baseline (if any), then the level-1 picker adds/removes entries as
  	// the visitor toggles server checkboxes. Passed to runChatLoop on
  	// every submit so the current selection is respected turn-by-turn.
  	// Keep the baseline separately: refreshRemoteToolsFromPicker() rebuilds
  	// remoteTools wholesale, so without a pristine copy the pre-configured
  	// tools vanish the moment the picker first renders.
  	var baselineRemoteTools = remoteToolsEl ? JSON.parse(remoteToolsEl.textContent) : [];
  	var remoteTools = baselineRemoteTools.slice();

  	// Level-1 picker caches. hubMcpServers[] is the list of anon-visible
  	// servers fetched from GET /api/mcp_servers; each server has an
  	// embedded `tools` array. selectedToolIds is the set of *individual*
  	// tool ids currently ON — same granularity as chat.aibranch.org's
  	// tool_selector: each tool can be toggled individually, and each
  	// server has a bulk-toggle checkbox that reflects/drives its children's
  	// state (all-on / indeterminate / all-off).
  	var hubMcpServers = [];
  	var selectedToolIds = new Set();
  	// A pre-configured tool IS a selection: seed the set so the picker renders
  	// it checked and the visitor can turn it off, rather than the picker
  	// silently overriding the page.
  	baselineRemoteTools.forEach(function(t) { selectedToolIds.add(t.id); });

  	function anyAllowedByAllowlist(name, allowlist) {
  		return allowlist === null || allowlist.indexOf(name) >= 0;
  	}

  	function refreshRemoteToolsFromPicker() {
  		// Flatten every SELECTED tool (across all servers) into remoteTools,
  		// adapted to runChatLoop's expected { id, name, description, input_schema }.
  		var flat = [];
  		var seen = {};
  		hubMcpServers.forEach(function(s) {
  			(s.tools || []).forEach(function(t) {
  				if (!selectedToolIds.has(t.id)) return;
  				seen[t.id] = true;
  				flat.push({
  					id:           t.id,
  					name:         t.name,
  					description:  t.description,
  					input_schema: t.input_schema
  				});
  			});
  		});
  		// A baseline tool whose server the picker never listed (not anon-visible,
  		// or the fetch failed) has no checkbox to be found through — keep it
  		// unless the visitor explicitly turned it off.
  		baselineRemoteTools.forEach(function(t) {
  			if (!seen[t.id] && selectedToolIds.has(t.id)) { flat.push(t); seen[t.id] = true; }
  		});
  		remoteTools = flat;
  		if (toolsCountEl) {
  			toolsCountEl.textContent = flat.length;
  			toolsCountEl.classList.toggle("lmw-tools-count-zero", flat.length === 0);
  		}
  	}

  	// Reflect the mix of child-tool states onto a server's bulk checkbox
  	// (checked / indeterminate / unchecked). Called after any child
  	// checkbox change, and after applying a bulk toggle.
  	function refreshServerBulkCheckbox(server, bulkCheckbox) {
  		var tools = server.tools || [];
  		var n = tools.length;
  		if (n === 0) { bulkCheckbox.checked = false; bulkCheckbox.indeterminate = false; return; }
  		var onCount = 0;
  		tools.forEach(function(t) { if (selectedToolIds.has(t.id)) onCount++; });
  		bulkCheckbox.checked       = (onCount === n);
  		bulkCheckbox.indeterminate = (onCount > 0 && onCount < n);
  	}

  	async function loadHubResourcesForPickers() {
  		// Called once on first widget open (idempotent — pickerLoaded flag
  		// below). Fetches models + MCP servers from the hub's anon endpoints
  		// and populates each picker. Non-fatal if either fetch fails (widget
  		// still works with the initial `model:` + no hub tools).
  		var tasks = [];

  		if (ENABLE_MODEL_PICKER && modelPicker && LLM_PROVIDER === "ollama") {
  			// No hub to ask: Ollama lists its own models.
  			tasks.push(fetchOllamaModels({ baseUrl: LLM_BASE }).then(function(names) {
  				var flat = names
  					.filter(function(n) { return anyAllowedByAllowlist(n, MODEL_ALLOWLIST); })
  					.map(function(n) { return { value: n, label: n }; });
  				if (!flat.some(function(m) { return m.value === MODEL; })) {
  					flat.unshift({ value: MODEL, label: MODEL });
  				}
  				modelPicker.innerHTML = "";
  				flat.forEach(function(m) {
  					var opt = document.createElement("option");
  					opt.value = m.value;
  					opt.textContent = m.label;
  					if (m.value === MODEL) opt.selected = true;
  					modelPicker.appendChild(opt);
  				});
  				if (flat.length > 1) modelPicker.style.display = "";
  			}));
  		} else if (ENABLE_MODEL_PICKER && modelPicker) {
  			tasks.push(fetch(LLM_BASE + "/api/llms", { headers: { "Accept": "application/json" } })
  				.then(function(r) { return r.ok ? r.json() : { llms: [] }; })
  				.then(function(payload) {
  					// /api/llms is heterogeneous per family:
  					//   - OpenAI/Anthropic/Google: `models: [{ name, display_name, ... }]`
  					//   - Ollama:                   `available_models: [{ value, label, ... }]`
  					// Anon widget uses api_key_uuid = "ollama-local" so only Ollama models
  					// are invocable; filter to that family and use its subshape.
  					var flat = [];
  					(payload.llms || []).forEach(function(llm) {
  						if (llm.family !== "ollama") return;
  						(llm.available_models || []).forEach(function(m) {
  							if (anyAllowedByAllowlist(m.value, MODEL_ALLOWLIST)) {
  								flat.push({ value: m.value, label: m.label });
  							}
  						});
  					});
  					// Ensure the host-configured MODEL is in the list even if the
  					// server doesn't return it — visitor should always see the
  					// current selection, and we don't want to silently switch.
  					if (!flat.some(function(m) { return m.value === MODEL; })) {
  						flat.unshift({ value: MODEL, label: MODEL });
  					}
  					modelPicker.innerHTML = "";
  					flat.forEach(function(m) {
  						var opt = document.createElement("option");
  						opt.value = m.value;
  						opt.textContent = m.label;
  						if (m.value === MODEL) opt.selected = true;
  						modelPicker.appendChild(opt);
  					});
  					if (flat.length > 1) modelPicker.style.display = "";
  				})
  				.catch(function(e) { console.warn("[widget] model list fetch failed:", e); }));
  		}

  		if (ENABLE_TOOL_PICKER && toolsListEl) {
  			tasks.push(fetch(TOOL_HUB_BASE + "/api/mcp_servers", { headers: { "Accept": "application/json" } })
  				.then(function(r) { return r.ok ? r.json() : { mcp_servers: [] }; })
  				.then(function(payload) {
  					hubMcpServers = (payload.mcp_servers || []).filter(function(s) {
  						return anyAllowedByAllowlist(s.name, HUB_TOOLS_ALLOWLIST);
  					});
  					toolsListEl.innerHTML = "";
  					if (hubMcpServers.length === 0) {
  						var empty = document.createElement("div");
  						empty.className = "lmw-tools-empty";
  						empty.textContent = "No hub-registered tools available.";
  						toolsListEl.appendChild(empty);
  						return;
  					}
  					hubMcpServers.forEach(function(s) {
  						var serverBlock = document.createElement("div");
  						serverBlock.className = "lmw-tools-server";

  						// Server header row: bulk checkbox + name + tool count + expand caret.
  						// Bulk checkbox toggles ALL of the server's tools at once and reflects
  						// the mix of child states (indeterminate when partial).
  						var headerRow = document.createElement("div");
  						headerRow.className = "lmw-tools-server-row";

  						var bulkCb = document.createElement("input");
  						bulkCb.type = "checkbox";
  						bulkCb.className = "lmw-tools-server-bulk";
  						bulkCb.title = "Enable all tools on this server";
  						bulkCb.addEventListener("click", function(e) {
  							// Prevent header-row click from toggling expand.
  							e.stopPropagation();
  						});
  						bulkCb.addEventListener("change", function() {
  							var shouldOn = bulkCb.checked;
  							(s.tools || []).forEach(function(t) {
  								if (shouldOn) selectedToolIds.add(t.id);
  								else          selectedToolIds.delete(t.id);
  							});
  							bulkCb.indeterminate = false;
  							// Sync every visible individual checkbox for this server.
  							childList.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
  								cb.checked = shouldOn;
  							});
  							refreshRemoteToolsFromPicker();
  						});

  						var nameSpan = document.createElement("span");
  						nameSpan.className = "lmw-tools-server-name";
  						var toolCount = (s.tools || []).length;
  						nameSpan.textContent = s.name + " (" + toolCount + " tool" + (toolCount === 1 ? "" : "s") + ")";

  						var caret = document.createElement("span");
  						caret.className = "lmw-tools-server-caret";
  						caret.textContent = "▸";

  						headerRow.appendChild(bulkCb);
  						headerRow.appendChild(nameSpan);
  						headerRow.appendChild(caret);

  						// Individual-tool rows — one checkbox per tool, indented.
  						// Hidden by default; header click expands. This mirrors
  						// chat.aibranch.org's lazy-expand server UX.
  						var childList = document.createElement("div");
  						childList.className = "lmw-tools-server-children";
  						childList.style.display = "none";

  						(s.tools || []).forEach(function(t) {
  							var toolLabel = document.createElement("label");
  							toolLabel.className = "lmw-tools-item lmw-tools-item-child";
  							toolLabel.title = t.description || t.name;
  							var cb = document.createElement("input");
  							cb.type = "checkbox";
  							cb.value = t.id;
  							cb.checked = selectedToolIds.has(t.id);
  							cb.addEventListener("change", function() {
  								if (cb.checked) selectedToolIds.add(t.id);
  								else            selectedToolIds.delete(t.id);
  								refreshServerBulkCheckbox(s, bulkCb);
  								refreshRemoteToolsFromPicker();
  							});
  							var span = document.createElement("span");
  							span.textContent = t.name;
  							toolLabel.appendChild(cb);
  							toolLabel.appendChild(span);
  							childList.appendChild(toolLabel);
  						});

  						headerRow.addEventListener("click", function() {
  							var isOpen = childList.style.display !== "none";
  							childList.style.display = isOpen ? "none" : "block";
  							caret.textContent = isOpen ? "▸" : "▾";
  						});

  						serverBlock.appendChild(headerRow);
  						serverBlock.appendChild(childList);
  						toolsListEl.appendChild(serverBlock);

  						// Initial bulk-checkbox state (all unchecked at first render).
  						refreshServerBulkCheckbox(s, bulkCb);
  					});
  					refreshRemoteToolsFromPicker();
  				})
  				.catch(function(e) { console.warn("[widget] MCP server list fetch failed:", e); }));
  		}

  		await Promise.all(tasks);
  	}

  	if (modelPicker) {
  		modelPicker.addEventListener("change", function() { MODEL = modelPicker.value; });
  	}

  	// Close the tools dropdown on any click outside its area. Native
  	// <details> only closes on summary re-click; visitors expect a
  	// dropdown/popover to dismiss on outside click, matching native
  	// select/menu behavior. `.contains(target)` includes the summary
  	// AND the drop-down list (both are descendants of the <details>).
  	if (toolsPicker) {
  		document.addEventListener("click", function(e) {
  			if (!toolsPicker.open) return;
  			if (toolsPicker.contains(e.target)) return;
  			toolsPicker.open = false;
  		});
  	}

  	var pickerLoaded = false;
  	async function ensurePickerLoaded() {
  		if (pickerLoaded) return;
  		pickerLoaded = true;   // set first so parallel opens don't double-fetch
  		try { await loadHubResourcesForPickers(); }
  		catch (e) { pickerLoaded = false; throw e; }
  	}

  	// Fetch well-known MCP manifests at boot. Auto-discovers same origin
  	// if WELL_KNOWN_URLS is null; empty array disables entirely.
  	var hostWideTools = [];
  	var hostWidePrompts = [];
  	var resourceContext = null;   // payload of the host's reference resource
  	var resourcePlan = null;      // the pre-flight decision, kept so Clear can re-arm the gate

  	// Beyond ~2k tokens a reference resource starts crowding out the
  	// conversation on a 32k-context local model — production PubDictionaries
  	// is 218 dictionaries / ~35KB / ~10k tokens.
  	var RESOURCE_BUDGET_BYTES = 8000;


  	// Before anything asynchronous: if this page was navigated away from and
  	// back, the visitor should see their conversation immediately.
  	restoreConversation();

  	var wellKnownReady = (async function() {
  		var urls = WELL_KNOWN_URLS === null
  			? [ window.location.origin + "/.well-known/mcp.json" ]
  			: WELL_KNOWN_URLS;
  		for (var i = 0; i < urls.length; i++) {
  			var tools = await fetchMcpManifest(urls[i]);
  			hostWideTools = hostWideTools.concat(tools);
  		}

  		// The manifest publishes TOOLS only, so the endpoints are learned from
  		// them. A server offering only prompts or resources is invisible here —
  		// worth knowing when deciding what a static manifest should carry.
  		var endpoints = [];
  		hostWideTools.forEach(function(t) {
  			if (t.endpoint && endpoints.indexOf(t.endpoint) === -1) endpoints.push(t.endpoint);
  		});

  		for (var j = 0; j < endpoints.length; j++) {
  			var endpoint = endpoints[j];
  			var prompts = await listMcpPrompts({ endpoint: endpoint });
  			hostWidePrompts = hostWidePrompts.concat(prompts);

  			if (resourcePlan === null) {
  				// Listing, size gate and read all live in the orchestrator, where
  				// they are tested together — a gate nothing consults is exactly
  				// the bug this shape prevents.
  				var loaded = await loadHostResource({
  					endpoint:    endpoint,
  					budgetBytes: RESOURCE_BUDGET_BYTES,
  					list:        listMcpResources,
  					read:        readMcpResource,
  					onSkip: function(plan) {
  						console.info("[llm_meta_widget] not attaching " + plan.uri +
  						             " (" + plan.reason + ", sizeBytes=" + plan.sizeBytes + ")");
  					}
  				});
  				// A volatile resource comes back with no context — it is read
  				// per turn instead — so the plan, not the payload, is what says
  				// whether this endpoint offered anything worth attaching.
  				if (loaded && loaded.plan && loaded.plan.fetch) {
  					resourceContext = loaded.context;
  					resourcePlan    = loaded.plan;
  				}
  			}
  		}
  		renderPromptButtons();
  		renderWelcome();
  	})();

  	// ---- server-offered prompt templates --------------------------------
  	//
  	// One button per prompt the host's MCP server offers. Clicking it fills
  	// the prompt's arguments from page state, asks the server to materialise
  	// the message (prompts/get), then drops the text into the textarea and
  	// submits — so it travels the exact path a typed message does.

  	var promptsEl = root.querySelector(".lmw-prompts");

  	function renderPromptButtons() {
  		if (!promptsEl) return;
  		promptsEl.textContent = "";
  		if (!hostWidePrompts.length) { promptsEl.style.display = "none"; return; }

  		hostWidePrompts.forEach(function(prompt) {
  			var props = promptButtonProps(prompt);
  			var button = document.createElement("button");
  			button.type = "button";
  			button.className = "lmw-prompt";
  			button.textContent = props.label;
  			button.title = props.title;
  			button.addEventListener("click", function() { runPromptTemplate(prompt, button); });
  			promptsEl.appendChild(button);
  		});
  		promptsEl.style.display = "";
  	}

  	// Put a saved transcript back on screen: the same bubbles, the same
  	// markdown, and the same record of which tools ran. Called once at boot,
  	// before the welcome block, which is only for a genuinely fresh start.
  	function restoreConversation() {
  		var saved = conversationStore.load();
  		if (!saved || !saved.turns.length) return false;

  		conversation = saved.turns;
  		saved.turns.forEach(function(turn) {
  			var body = appendTurn(turn.role, turn.role === "assistant" ? "" : turn.content);
  			if (turn.role === "assistant") renderMarkdownInto(body, turn.content || "");
  			if (!turn.tools || !turn.tools.length) return;
  			var row = document.createElement("div");
  			row.className = "lmw-tool-chips";
  			turn.tools.forEach(function(tool) {
  				var chip = document.createElement("span");
  				chip.className = "lmw-tool-chip" + (tool.error ? " error" : "");
  				chip.textContent = (tool.error ? "❌ " : "🔧 ") + tool.name;
  				row.appendChild(chip);
  			});
  			if (body.parentNode) body.parentNode.appendChild(row);
  		});
  		historyEl.scrollTop = historyEl.scrollHeight;
  		return true;
  	}

  	// A blank panel tells a first-time visitor nothing. Open with a greeting
  	// and the offers themselves — each template showing what it will take from
  	// the page and what it will ask for — so the assistant is the page's way
  	// in rather than a box you must already know how to talk to.
  	function renderWelcome() {
  		// A restored transcript is not a fresh start; the greeting would push
  		// the conversation the visitor is mid-way through off the screen.
  		if (!historyEl || historyEl.querySelector(".message")) return;
  		historyEl.textContent = "";

  		var box = document.createElement("div");
  		box.className = "lmw-welcome";

  		var hello = document.createElement("p");
  		hello.className = "lmw-welcome-hello";
  		hello.textContent = GREETING ||
  			"Hi — I can work this page for you. Tell me what you need in your own words" +
  			(hostWidePrompts.length ? ", or start with one of these:" : ".");
  		box.appendChild(hello);

  		var state = window[STATE_GLOBAL] || {};
  		hostWidePrompts.forEach(function(prompt) {
  			var props = promptButtonProps(prompt);
  			var card  = document.createElement("div");
  			card.className = "lmw-welcome-card";

  			var start = document.createElement("button");
  			start.type = "button";
  			start.className = "lmw-welcome-start";
  			start.textContent = props.label;
  			start.addEventListener("click", function() { runPromptTemplate(prompt, start); });
  			card.appendChild(start);

  			if (prompt.description) {
  				var why = document.createElement("p");
  				why.className = "lmw-welcome-why";
  				why.textContent = prompt.description;
  				card.appendChild(why);
  			}

  			// Name the placeholders, filled or not, so the offer is concrete:
  			// a newcomer can see the text box is empty before clicking.
  			var summary = promptArgumentSummary(prompt, state);
  			if (summary.length) {
  				var slots = document.createElement("ul");
  				slots.className = "lmw-welcome-slots";
  				summary.forEach(function(slot) {
  					var li = document.createElement("li");
  					li.className = slot.filled ? "filled" : "empty";
  					li.textContent = slot.filled
  						? slot.name + ": " + (slot.value.length > 60 ? slot.value.slice(0, 60) + "…" : slot.value)
  						: slot.name + ": not set yet — I'll ask, or work it out";
  					slots.appendChild(li);
  				});
  				card.appendChild(slots);
  			}
  			box.appendChild(card);
  		});

  		historyEl.appendChild(box);
  	}

  	async function runPromptTemplate(prompt, button) {
  		var resolved = resolvePromptArguments(prompt, window[STATE_GLOBAL] || {});
  		var args = resolved.args;
  		var missing = resolved.missing;

  		// Say which page field is empty rather than letting the server answer
  		// -32602 for something the user can actually fix on screen.
  		if (missing.length) {
  			appendTurn("error", "Cannot run \"" + (prompt.title || prompt.name) + "\" yet — nothing to use for: " +
  			                     missing.join(", ") + ". Fill that in on the page first.");
  			return;
  		}

  		button.disabled = true;
  		try {
  			var result = await getMcpPrompt({ endpoint: prompt.endpoint, name: prompt.name, args: args });
  			var text = promptMessagesToText(result);
  			if (!text) { appendTurn("error", "The server returned an empty prompt."); return; }
  			inputEl.value = text;
  			pendingTurnLabel = promptButtonProps(prompt).label;
  			if (typeof formEl.requestSubmit === "function") formEl.requestSubmit();
  			else formEl.dispatchEvent(new Event("submit", { cancelable: true }));
  		} catch (e) {
  			appendTurn("error", "Prompt failed: " + (e && e.message ? e.message : e));
  		} finally {
  			button.disabled = false;
  		}
  	}

  	// Set just before a template submits, so its turn is labelled by what the
  	// user actually did — "Annotate text" — instead of showing a paragraph of
  	// server-written instructions as though they had typed it. The instructions
  	// stay one click away rather than hidden: what was sent is what is shown.
  	var pendingTurnLabel = null;

  	function appendTurn(role, text, turnLabel) {
  		// Class names mirror llm_meta_chat's chats/_message.html.erb —
  		// `.message.<role>`, `.message-role`, `.message-content` — so the
  		// shared conversation.css styles apply directly (see the <link>
  		// above). The .lmw-* prefix is reserved for widget-CHROME classes
  		// (header, clear button, scroll region, input area) that aren't
  		// part of the shared conversation surface.
  		var welcome = historyEl.querySelector(".lmw-welcome");
  		if (welcome) welcome.remove();

  		var div = document.createElement("div");
  		div.className = "message " + role;
  		var label = document.createElement("div");
  		label.className = "message-role";
  		label.textContent = roleLabel(role);
  		var body = document.createElement("div");
  		body.className = "message-content";
  		// User / system / error turns render as plain text (safe from any
  		// injection via user input or server-supplied strings). Assistant
  		// content is rendered as markdown but only after the assistant's
  		// text is streamed in via renderMarkdownInto — this appendTurn
  		// creates the empty container.
  		if (turnLabel) {
  			var details = document.createElement("details");
  			var summary = document.createElement("summary");
  			summary.textContent = turnLabel;
  			var full = document.createElement("div");
  			full.className = "lmw-sent-text";
  			full.textContent = text;
  			details.appendChild(summary);
  			details.appendChild(full);
  			body.appendChild(details);
  		} else {
  			body.textContent = text;
  		}
  		div.appendChild(label);
  		div.appendChild(document.createTextNode(" "));
  		div.appendChild(body);
  		historyEl.appendChild(div);
  		historyEl.scrollTop = historyEl.scrollHeight;
  		body.roleLabel = label;   // so a turn in flight can show it is working
  		return body;
  	}

  	// Render a raw-markdown buffer into an element's innerHTML. marked's
  	// default HTML output escapes user content, so passing arbitrary
  	// LLM output is safe against XSS. Called per-delta so streaming
  	// assistant text formats live (headings/lists/code blocks/etc.).
  	function renderMarkdownInto(el, mdText) {
  		try { el.innerHTML = marked.parse(mdText); }
  		catch (e) { el.textContent = mdText; }  // fall back to raw on parse error
  	}

  	// Role labels mirror llm_meta_chat's chats/_message.html.erb:
  	//   user      → "👤 You"
  	//   assistant → "🤖 <model>"
  	// so the widget reads as the same UI as the full chat host.
  	function roleLabel(role) {
  		if (role === "user")      return "👤 You";
  		if (role === "assistant") return "🤖 " + MODEL;
  		if (role === "system")    return "• system";
  		if (role === "error")     return "⚠ error";
  		return role;
  	}

  	// While a turn is in flight the assistant's label becomes a turning gear.
  	// Same markup and class names as llm_meta_chat's message_stream_controller,
  	// so the shared conversation.css drives both. Without it there is no sign
  	// whether the assistant is still working or has quietly stopped — and on a
  	// local model a tool round can take a long time before the first token.
  	function markWorking(label) {
  		if (!label || label.classList.contains("is-working")) return;
  		label.innerHTML = '<span class="role-spinner" aria-hidden="true">\u2699\uFE0F</span> Working…';
  		label.classList.add("is-working");
  	}

  	function markDone(label) {
  		if (!label || !label.classList.contains("is-working")) return;
  		label.classList.remove("is-working");
  		label.textContent = roleLabel("assistant");
  	}

  	// Tool chips, written as the tools run rather than assembled at the end.
  	// The end-of-turn footer was invisible for as long as the turn lasted —
  	// minutes on a thinking model — so a visitor watched tools execute with
  	// no idea which ones.
  	var liveChips = null;      // the container inside the current bubble
  	var pendingChips = [];     // chips awaiting their outcome, oldest first

  	function chipRow() {
  		if (liveChips && liveChips.parentNode) return liveChips;
  		if (!activeAssistantBody || !activeAssistantBody.parentNode) return null;
  		liveChips = document.createElement("div");
  		liveChips.className = "lmw-tool-chips";
  		// Inside the bubble but OUTSIDE .message-content: every text delta
  		// re-renders that element's markdown from scratch, which silently
  		// erased any chip already written into it.
  		activeAssistantBody.parentNode.appendChild(liveChips);
  		return liveChips;
  	}

  	function announceToolCall(toolCall) {
  		var row = chipRow();
  		if (!row) return;
  		var chip = document.createElement("span");
  		chip.className = "lmw-tool-chip running";
  		chip.textContent = "⏳ " + toolCall.name;
  		chip.dataset.tool = toolCall.name;
  		row.appendChild(chip);
  		pendingChips.push(chip);
  		historyEl.scrollTop = historyEl.scrollHeight;
  	}

  	function resolveToolCall(outcome) {
  		// Match by name, oldest first: ids are not always echoed back, and a
  		// repeated name resolves in call order.
  		var idx = pendingChips.findIndex(function(c) { return c.dataset.tool === outcome.toolCall.name; });
  		var chip = idx === -1 ? null : pendingChips.splice(idx, 1)[0];
  		if (!chip) return;
  		chip.className = "lmw-tool-chip" + (outcome.error ? " error" : "");
  		chip.textContent = (outcome.error ? "❌ " : "🔧 ") + outcome.toolCall.name;
  		if (outcome.error) chip.title = outcome.error.message || String(outcome.error);
  	}

  	var currentThinkingBlock = null;
  	var currentThinkingBody  = null;
  	// The assistant bubble of the turn in flight. Reasoning belongs ABOVE that
  	// bubble's content, the way llm_meta_chat places it — appending it to the
  	// transcript instead left it below the answer it was reasoning towards.
  	var activeAssistantBody  = null;

  	function ensureThinkingBlock() {
  		if (currentThinkingBody) return currentThinkingBody;
  		// Class names match llm_meta_chat's .message-thinking pattern so
  		// the shared conversation.css applies directly.
  		var details = document.createElement("details");
  		details.className = "message-thinking";
  		details.open = true;
  		details.classList.add("thinking-active");
  		var summary = document.createElement("summary");
  		summary.textContent = "🤔 thinking…";
  		var dots = document.createElement("span");
  		dots.className = "thinking-dots";
  		for (var i = 0; i < 3; i++) {
  			var dot = document.createElement("span");
  			dot.textContent = ".";
  			dots.appendChild(dot);
  		}
  		summary.appendChild(dots);
  		var body = document.createElement("div");
  		body.className = "message-thinking-content";
  		details.appendChild(summary);
  		details.appendChild(body);
  		if (activeAssistantBody && activeAssistantBody.parentNode) {
  			activeAssistantBody.parentNode.insertBefore(details, activeAssistantBody);
  		} else {
  			historyEl.appendChild(details);
  		}
  		historyEl.scrollTop = historyEl.scrollHeight;
  		currentThinkingBlock = details;
  		currentThinkingBody  = body;
  		return body;
  	}

  	function collapseThinkingBlock() {
  		if (currentThinkingBlock) {
  			currentThinkingBlock.classList.remove("thinking-active");
  			currentThinkingBlock.open = false;
  			var summary = currentThinkingBlock.querySelector("summary");
  			if (summary) summary.textContent = "🤔 thinking (finished)";
  		}
  		currentThinkingBlock = null;
  		currentThinkingBody  = null;
  	}

  	// Every declaration channel the widget hands the model carries a
  	// developer-authored description — Class 3 action schemas, Class 2
  	// .well-known tools, Class 1 hub tools, static-primitives resources. State
  	// readers used to be the exception: the model saw a bare key and had to
  	// infer meaning from its name, which holds for `text` and falls apart for
  	// `annotation_mode` or `pending_merges`. Each reader now declares what it
  	// returns, in the same shape as everything else.
  	//
  	// The bare-function form is GONE as of 0.8.0 — no fallback branch. A page
  	// that still uses it is told exactly what to change, per key, and that key
  	// is skipped; the rest of the page still works.
  	function stateReaders() {
  		var declared = window[STATE_GLOBAL] || {};
  		var out = [];
  		Object.keys(declared).forEach(function(key) {
  			var entry = declared[key];
  			var hasDescription = entry && typeof entry.description === "string" && entry.description.trim() !== "";
  			var hasRead        = entry && typeof entry.read === "function";
  			if (!hasDescription || !hasRead) {
  				console.error(
  					"[llm-meta-widget] " + STATE_GLOBAL + "." + key + " is not a valid state reader. " +
  					"Expected { description: \"what this value is\", read: function () { … } }, got " +
  					(typeof entry === "function" ? "a bare function (the 0.7 form, removed in 0.8)" : describeValue(entry)) +
  					". Skipping " + key + "."
  				);
  				return;
  			}
  			out.push({ key: key, description: entry.description, read: entry.read });
  		});
  		return out;
  	}

  	function describeValue(v) {
  		if (v === null) return "null";
  		if (Array.isArray(v)) return "an array";
  		if (typeof v === "object") {
  			var missing = [];
  			if (typeof v.description !== "string" || v.description.trim() === "") missing.push("description");
  			if (typeof v.read !== "function") missing.push("read");
  			return "an object missing " + missing.join(" and ");
  		}
  		return typeof v;
  	}

  	function currentPageState() {
  		return stateReaders().map(function(r) {
  			var value;
  			try { value = r.read(); } catch (e) { value = "<error: " + e.message + ">"; }
  			return { key: r.key, description: r.description, value: value };
  		});
  	}

  	// One line per reader, with its description inline. A separate glossary
  	// above the values would make the model match names across two lists; the
  	// point is that it reads the meaning and the value together.
  	function pageStateLines() {
  		var readers = currentPageState();
  		if (readers.length === 0) return [ "(this page declares no state)" ];
  		return readers.map(function(r) {
  			return "- " + r.key + " (" + r.description + "): " + JSON.stringify(r.value);
  		});
  	}

  	function currentSystemPrompt(resourceLines) {
  		return [
  			"You are integrated into a web page as an AI assistant. You have tools available to change page state or fetch information.",
  			"",
  			"RULES for tool use:",
  			"1. If the user's question can be answered from the Current page state below, answer directly with a plain-text response — do NOT invoke a tool.",
  			"2. If the user requests a state change, or needs information not in the page state, invoke the matching tool via a function call. Do not describe your intent in text without actually invoking (a textual promise like \"I will add X\" is a failure).",
  			"3. After a tool returns a result, use it: either take the next step the task needs, or — if the task is done — answer in plain text. Do not stop silently after a tool call.",
  			"4. NEVER repeat a call you have already made with the same or similar arguments — its result is already in the conversation history.",
  			"",
  			"Current page state:"
  		].concat(pageStateLines()).concat(resourceLines || []).join("\n");
  	}

  	// Runs once per send, before the system prompt is built: a volatile
  	// resource is re-read here, a stable one re-uses the copy taken at boot.
  	// Either way it is attached to every turn — the server's hint governs
  	// re-FETCHING; how often to include it is this client's call.
  	async function resourceLinesForThisTurn() {
  		var turn = await resourceLinesForTurn({
  			plan:        resourcePlan,
  			cached:      resourceContext,
  			endpoint:    resourcePlan && resourcePlan.endpoint,
  			read:        readMcpResource,
  			budgetBytes: RESOURCE_BUDGET_BYTES
  		});
  		resourceContext = turn.cached;
  		return turn.lines;
  	}

  	// Per-turn AbortController — lets the Clear button (or a new submit)
  	// terminate an in-flight runChatLoop.
  	var currentAbort = null;

  	clearBtn.addEventListener("click", function() {
  		if (currentAbort) { try { currentAbort.abort(); } catch (e) { /* noop */ } }
  		conversation = [];
  		conversationStore.clear();
  		historyEl.innerHTML = "";
  		renderWelcome();
  	});

  	// Enter submits, Shift+Enter inserts a newline — matches llm_meta_chat's
  	// input UX so users can type multi-line prompts without accidentally
  	// firing the form.
  	inputEl.addEventListener("keydown", function(e) {
  		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
  			e.preventDefault();
  			if (typeof formEl.requestSubmit === "function") formEl.requestSubmit();
  			else formEl.dispatchEvent(new Event("submit", { cancelable: true }));
  		}
  	});

  	formEl.addEventListener("submit", async function(event) {
  		event.preventDefault();
  		var userText = inputEl.value.trim();
  		if (!userText) return;
  		inputEl.value = "";
  		appendTurn("user", userText, pendingTurnLabel);
  		pendingTurnLabel = null;

  		if (currentAbort) { try { currentAbort.abort(); } catch (e) { /* noop */ } }
  		currentAbort = new AbortController();

  		var assistantBody = appendTurn("assistant", "");
  		activeAssistantBody = assistantBody;
  		liveChips = null;
  		pendingChips = [];
  		markWorking(assistantBody.roleLabel);
  		var assistantMarkdown = "";  // accumulate raw markdown, re-render on each delta

  		try {
  			// Discovery has to finish before the system prompt is built: the
  			// resource catalog is attached to the first turn only, so building
  			// messages first would silently ship that turn without it AND mark
  			// it as sent.
  			await wellKnownReady;

  			var resourceLines = await resourceLinesForThisTurn();
  			var messages = [{ role: "system", content: currentSystemPrompt(resourceLines) }]
  				.concat(conversation.map(function(t) { return { role: t.role, content: t.content }; }))
  				.concat([{ role: "user", content: userText }]);

  			var result = await runChatLoop({
  				baseUrl:       LLM_BASE,
  				toolHubUrl:    TOOL_HUB_BASE,
  				apiKeyUuid:    API_KEY_UUID,
  				modelName:     MODEL,
  				messages:      messages,
  				localTools:    localTools,
  				remoteTools:   remoteTools,
  				hostWideTools: hostWideTools,
  				aiActions:     window[ACTIONS_GLOBAL] || {},
  				maxRounds:     MAX_ROUNDS,
  				provider:      LLM_PROVIDER === "ollama" ? "ollama" : "hub",
  				signal:        currentAbort.signal,
  				onToolCall: function(toolCall) { announceToolCall(toolCall); },
  				onToolDispatched: function(outcome) { resolveToolCall(outcome); },
  				onPhase: function(name) {
  					// 'thinking' covers the long silence before the first
  					// token; 'responding' means text is on its way.
  					if (name === "responding") markDone(assistantBody.roleLabel);
  					else markWorking(assistantBody.roleLabel);
  				},
  				onRoundStart: function(roundIdx) {
  					// A new round means more work: tool results are going back
  					// to the model, which is the longest wait of all.
  					markWorking(assistantBody.roleLabel);
  					// Loop mechanics are debugging info, not user-facing signal.
  					// Reuse the same assistant bubble across rounds — text just
  					// keeps streaming into it (accumulating markdown). Weaker
  					// models sometimes emit tool_calls in >1 round instead of
  					// synthesizing right away; keeping one bubble makes the
  					// resulting conversation read as ONE reply rather than a
  					// debug trace with round separators.
  					collapseThinkingBlock();
  				},
  				onThinkingDelta: function(delta) {
  					var body = ensureThinkingBlock();
  					body.appendChild(document.createTextNode(delta));
  					body.scrollTop = body.scrollHeight;
  					historyEl.scrollTop = historyEl.scrollHeight;
  				},
  				onTextDelta: function(delta) {
  					markDone(assistantBody.roleLabel);
  					collapseThinkingBlock();
  					assistantMarkdown += delta;
  					renderMarkdownInto(assistantBody, assistantMarkdown);
  					historyEl.scrollTop = historyEl.scrollHeight;
  				}
  			});
  			conversation.push({ role: "user", content: userText });
  			conversation.push({
  				role:    "assistant",
  				content: result.content,
  				// Kept so a restored transcript still shows what ran — losing
  				// that record is what made a navigating action unbearable.
  				tools:   result.dispatched.map(function(d) {
  					return d.error ? { name: d.toolCall.name, error: true } : { name: d.toolCall.name };
  				})
  			});
  			persistConversation();

  			// Anything still pending never reported an outcome (a class that
  			// does not round-trip, or a dispatch that vanished). Reconcile
  			// from the loop's own record so no chip is left spinning.
  			result.dispatched.forEach(function(d) { resolveToolCall(d); });
  			pendingChips.forEach(function(chip) {
  				chip.className = "lmw-tool-chip";
  				chip.textContent = "🔧 " + chip.dataset.tool;
  			});
  			pendingChips = [];

  			// Skipped = LLM tried a tool that doesn't exist. Real signal.
  			if (result.skipped.length > 0) {
  				appendTurn("system", "Not available on this page: " +
  					result.skipped.map(function(t) { return t.name; }).join(", "));
  			}
  			// Loop termination reasons:
  			//   "duplicate_tool_calls" — LLM re-called an already-invoked
  			//     tool; the earlier round's dispatch already produced the
  			//     answer/effect, so we silently absorb this (no user warning).
  			//   otherwise (e.g. max_rounds) — the loop hit a real hard cap
  			//     that likely truncated the response; user should know.
  			if (result.stopped_reason && result.stopped_reason !== "duplicate_tool_calls") {
  				appendTurn("system",
  					"The assistant reached its tool-use limit before finishing. " +
  					"The reply above may be incomplete — try asking again or rephrasing.");
  			}
  		} catch (err) {
  			if (err.name === "AbortError" || /aborted/i.test(err.message || "")) {
  				appendTurn("system", "⏹ stopped");
  			} else {
  				appendTurn("error", err.message);
  			}
  		} finally {
  			// Whatever happened — answered, aborted, threw, or returned
  			// nothing at all — the turn is over and the label must stop
  			// claiming otherwise. A spinner left running is a worse lie than
  			// no spinner: it says "still working" about a turn that ended.
  			markDone(assistantBody.roleLabel);
  			collapseThinkingBlock();
  			activeAssistantBody = null;
  			currentAbort = null;
  		}
  	});
}

