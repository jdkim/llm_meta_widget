// The panel's JavaScript lives inside an ERB template, so no linter sees it —
// and three bugs have now shipped through that gap: an undefined variable, a
// stale import, and a shadowed one. This extracts the module script to a plain
// .js file that ESLint can read.
//
// ERB tags are replaced rather than removed: `<%= x %>` becomes `null`, which
// keeps the surrounding JavaScript syntactically intact (including inside the
// string literals the template interpolates into).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

const PANEL = "app/views/llm_meta_widget/_chat_panel.html.erb"
const OUT = "tmp/panel_script.js"

const erb = readFileSync(PANEL, "utf8")
const match = erb.match(/<script type="module">([\s\S]*?)<\/script>/)
if (!match) {
  console.error(`No <script type="module"> block found in ${PANEL}`)
  process.exit(1)
}

const js = match[1]
  .replace(/<%=([\s\S]*?)%>/g, "null")
  .replace(/<%([\s\S]*?)%>/g, "")

mkdirSync("tmp", { recursive: true })
writeFileSync(OUT, `// GENERATED from ${PANEL} — edit the template, not this file.\n${js}`)
