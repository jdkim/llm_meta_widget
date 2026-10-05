// The element's markup is a plain template literal, and that is exactly what
// makes it fragile: it was lifted verbatim out of an ERB partial, so it arrived
// carrying `<% if enable_model_picker %>` and friends. In ERB those were real
// conditionals; in a JS template string they are just characters, so they
// rendered as visible text in the panel and the flags they implemented silently
// stopped working. It shipped in 0.7.0 and 0.7.1 and was found by eye, not by a
// test — element.js cannot be imported headlessly (its CSS imports need
// esbuild's loader), so these read the source and the built bundle as text.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const DIR = fileURLToPath(new URL(".", import.meta.url))
const source = readFileSync(DIR + "element.js", "utf8")
const bundle = readFileSync(DIR + "llm-meta-widget.js", "utf8")

// `<%` and `%>` have no legitimate use in this file: it is JavaScript, and the
// markup it holds is HTML. Either delimiter means template syntax leaked in.
//
// element.dom.test.mjs now asserts the same thing behaviourally, on the rendered
// panel. These stay because they reach further: they catch a delimiter anywhere
// in the source or the shipped bundle, including a branch the default render
// never reaches. The two structural tests that merely restated the fix's shape
// were deleted when the DOM harness replaced them.
for (const [name, text] of [["element.js", source], ["the built bundle", bundle]]) {
  test(`${name} contains no ERB delimiters`, () => {
    const found = [...text.matchAll(/<%|%>/g)].map((m) => {
      const line = text.slice(0, m.index).split("\n").length
      return `${name}:${line} ${text.split("\n")[line - 1].trim()}`
    })
    assert.deepEqual(found, [], `template syntax leaked into ${name}:\n${found.join("\n")}`)
  })
}
