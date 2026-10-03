// What ships, and whether it survives the CDN.
//
// Two things nothing else checks:
//
//   * The npm tarball's contents. `files`, `main` and `exports` are easy to
//     break by accident — adding a path, renaming the bundle — and the failure
//     is only visible to a consumer, after publishing.
//   * The MINIFIED bundle. jsDelivr serves a Terser-minified build from the
//     bare package URL (it says so in a banner), so the bytes a browser runs
//     are not the bytes we published. The element name, the CSS and the markup
//     all live in string and template literals, which minification should
//     preserve — "should" being what tests are for.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url))
const pkg = JSON.parse(readFileSync(ROOT + "package.json", "utf8"))
const BUNDLE = "app/assets/javascripts/llm_meta_widget/llm-meta-widget.js"

// ---- what the tarball contains -------------------------------------------

function packed() {
  const out = execFileSync("npm", [ "pack", "--dry-run", "--json" ], { cwd: ROOT, encoding: "utf8" })
  return JSON.parse(out)[0].files.map((f) => f.path)
}

test("the tarball ships the bundle and the orchestrator, and nothing unexpected", () => {
  const files = packed()
  assert.ok(files.includes(BUNDLE), `tarball is missing ${BUNDLE}`)
  assert.ok(files.includes("app/assets/javascripts/llm_meta_widget/orchestrator.js"))
  // No Ruby, no ERB, no unbundled sources: those are the gem's business.
  const leaked = files.filter((f) => /\.(rb|erb|css)$|element\.js$|config\.js$|marked\.esm\.js$/.test(f))
  assert.deepEqual(leaked, [], `these should not be published: ${leaked.join(", ")}`)
})

test("main and exports point at files that are actually packed", () => {
  const files = packed()
  assert.ok(files.includes(pkg.main.replace(/^\.\//, "")), `main (${pkg.main}) is not in the tarball`)
  for (const target of Object.values(pkg.exports)) {
    const p = target.replace(/^\.\//, "")
    assert.ok(files.includes(p), `exports entry ${target} is not in the tarball`)
  }
})

test("the bare CDN URL resolves to the bundle, not to a source file", () => {
  // jsDelivr serves `main` when no path is given, which is why the README can
  // show a path-free URL. If main pointed at element.js the CDN would serve
  // something with bare CSS imports a browser cannot resolve.
  assert.equal(pkg.main, BUNDLE)
  assert.equal(pkg.exports["."], "./" + BUNDLE)
})

test("the package is not marked side-effect-free", () => {
  // The bundle exists FOR its side effects: defining the element and injecting
  // styles. sideEffects:false would licence a bundler to drop the import.
  assert.notEqual(pkg.sideEffects, false)
})

test("scoped package is published public, so the first publish cannot fail on access", () => {
  assert.ok(pkg.name.startsWith("@"), "expected a scoped name")
  assert.equal(pkg.publishConfig?.access, "public")
})

// ---- does it survive minification ----------------------------------------

test("minified, the bundle keeps the strings the element depends on", () => {
  const min = execFileSync(
    "npx",
    [ "esbuild", BUNDLE, "--minify", "--format=esm" ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )

  // the custom element's name, which is a string literal
  assert.match(min, /customElements\.define\(/)
  assert.match(min, /"llm-meta-widget"|'llm-meta-widget'/)
  // the attribute names it reads
  for (const attr of [ "llm-url", "model", "tool-hub-url", "well-known-urls" ]) {
    assert.ok(min.includes(attr), `minified bundle lost the attribute name ${attr}`)
  }
  // the markup and CSS, which live in template literals
  assert.ok(min.includes("llm-meta-widget-chat"), "lost the panel element id")
  assert.ok(min.includes("lmw-messages"), "lost a class the panel and the CSS share")
  assert.ok(min.includes("data-llm-meta-widget"), "lost the injected style marker")
  // and it must still parse
  assert.ok(min.length > 10000)
})
