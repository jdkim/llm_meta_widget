// Layout test — the only kind that can see this fix.
//
// The table fix is CSS: the wrapper is capped and scrolls, the table inside
// keeps its natural width. jsdom lays nothing out, so every jsdom test passes
// just as happily with the broken rules (`width: auto`, or the table as its own
// scroll box) as with the working ones — verified by mutation. A real engine is
// required, so this one drives headless Chromium and measures.
//
// It skips when no browser is on the machine rather than failing: the rest of
// the suite must stay runnable anywhere.
import { test } from "node:test"
import assert from "node:assert"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { execFileSync, execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, "llm-meta-widget.js")

function findBrowser() {
  for (const name of [ "chromium-browser", "chromium", "google-chrome", "google-chrome-stable" ]) {
    try {
      execFileSync("which", [ name ], { stdio: "pipe" })
      return name
    } catch { /* try the next one */ }
  }
  return null
}

// A six-column table of genomic notation: the shape that broke, where every
// cell holds a long unbreakable token.
function pageHtml() {
  const header = "| rsID | Genomic notation (GRCh38) | Protein change | tommo allele-frequency | Clinical significance (ClinVar) | Effect on known glycosylation sites |"
  const sep = "|---|---|---|---|---|---|"
  const rows = Array.from({ length: 8 }, (_, i) =>
    `| rs${28929474 + i} | NC_000014.9:g.9437861${i}C>T(ENST00000393087.9:c.1096G>A) | p.Glu${342 + i}Lys | 0.0${i}47 | Pathogenic/likely_pathogenic | no_direct_N-glycosylation_sequon_disruption |`)
  const answer = "### SERPINA1 variants\\n\\n" + [ header, sep, ...rows ].join("\\n")

  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
localStorage.setItem("llm_meta_widget:open", "1");
sessionStorage.setItem("llm_meta_widget:" + location.pathname, JSON.stringify({
  v: 1, savedAt: Date.now(), open: true, model: "m1",
  turns: [ { role: "user", content: "list them" }, { role: "assistant", content: "${answer}" } ]
}));
</script>
<llm-meta-widget llm-url="http://127.0.0.1:1/nowhere" model="m1" well-known-urls=""></llm-meta-widget>
<script type="module" src="./llm-meta-widget.js"></script>
<pre id="out">pending</pre>
<script>
setTimeout(function () {
  var panel = document.getElementById("llm-meta-widget-chat");
  if (!panel) { document.getElementById("out").textContent = '{"error":"no panel"}'; return; }
  panel.style.width = "34em";
  var table = panel.querySelector(".message-content table");
  if (!table) { document.getElementById("out").textContent = '{"error":"no table"}'; return; }
  var wrap = table.parentNode;
  // Behavioural, not declarative: scrollLeft only moves on a real scroll
  // container, so this fails if the wrapper stops being one. Comparing
  // scrollWidth with clientWidth does NOT — content overflows either way, and
  // with overflow:visible it simply spills out and is clipped by the panel,
  // unreachable.
  var msgs = panel.querySelector(".lmw-messages");
  wrap.scrollLeft = 10000;
  document.getElementById("out").textContent = JSON.stringify({
    wrapperClass: wrap.className,
    tableNaturalWidth: table.scrollWidth,
    wrapperVisibleWidth: wrap.clientWidth,
    wrapperScrollLeftReached: wrap.scrollLeft,
    messagesVisibleWidth: msgs.clientWidth,
    messagesScrollsSideways: msgs.scrollWidth > msgs.clientWidth + 1
  });
}, 700);
</script>
</body></html>`
}

async function measure(browser) {
  const html = pageHtml()
  const bundle = readFileSync(BUNDLE, "utf8")
  const server = createServer((req, res) => {
    if (req.url.startsWith("/llm-meta-widget.js")) {
      res.writeHead(200, { "Content-Type": "text/javascript" })
      return res.end(bundle)
    }
    res.writeHead(200, { "Content-Type": "text/html" })
    res.end(html)
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  try {
    // Async on purpose: execFileSync blocks Node's event loop, so the server
    // above could never answer the browser and both sides waited for ever.
    const { stdout: dom } = await run(browser, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=6000",
      "--window-size=1200,900", "--dump-dom", `http://127.0.0.1:${port}/page.html`
    ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 90_000 })
    const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)
    assert.ok(m, "the page should have reported measurements")
    return JSON.parse(m[1])
  } finally {
    server.close()
  }
}

const browser = findBrowser()

test("a wide table keeps its natural width and the wrapper scrolls", { skip: browser ? false : "no chromium or chrome on this machine" }, async () => {
  const r = await measure(browser)

  assert.equal(r.error, undefined, `page error: ${r.error}`)
  assert.equal(r.wrapperClass, "lmw-table-scroll", "the table must sit inside the scroller")
  // The point of the fix: the table is laid out MUCH wider than the bubble and
  // the wrapper scrolls, instead of the table being squeezed to fit and its
  // words broken one character per line.
  assert.ok(r.tableNaturalWidth > r.wrapperVisibleWidth * 1.5,
    `table should be far wider than its box, got ${r.tableNaturalWidth} in ${r.wrapperVisibleWidth}`)
  assert.ok(r.wrapperScrollLeftReached > 0,
    "the wrapper must actually scroll sideways, not merely overflow")
  // The wrapper must stay inside the message area, or the table spills across
  // the panel and is clipped where nobody can reach it.
  assert.ok(r.wrapperVisibleWidth <= r.messagesVisibleWidth,
    `wrapper ${r.wrapperVisibleWidth} must fit the message area ${r.messagesVisibleWidth}`)
  assert.equal(r.messagesScrollsSideways, false,
    "the message area itself must not be pushed into sideways scrolling")
})
