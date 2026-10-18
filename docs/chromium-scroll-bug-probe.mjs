// Trusted-input probe for chromium-scroll-bug-minimal.html. No dependencies:
// Node 22+ has a global WebSocket, and the DevTools Protocol is enough.
//
//   node chromium-scroll-bug-probe.mjs <path-to-minimal.html> [--headful]
//
// A dispatched WheelEvent cannot scroll — synthetic events never reach the
// compositor — so the wheel here goes through CDP Input.dispatchMouseEvent,
// which is injected at browser level and IS trusted.
//
// Healthy: after scrollTop = 600, one notch moves further down.
// The bug:  it snaps back to a value far below `max`.
import { spawn } from "node:child_process"
import { mkdtempSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const file = process.argv[2]
if (!file) {
  console.error("usage: node chromium-scroll-bug-probe.mjs <minimal.html> [--headful]")
  process.exit(1)
}
const url = file.startsWith("file://") ? file : "file://" + resolve(file)
const headful = process.argv.includes("--headful")

const binary = [ "/usr/bin/google-chrome", "/usr/bin/chromium-browser",
                 "/usr/bin/chromium", "/snap/bin/chromium" ].find((p) => existsSync(p))
if (!binary) { console.error("no chrome or chromium found"); process.exit(1) }

const profile = mkdtempSync(join(tmpdir(), "scrollbug-"))
const args = [ "--remote-debugging-port=9222", "--no-sandbox", "--disable-gpu",
               "--user-data-dir=" + profile, "--window-size=1200,900", url ]
if (!headful) args.unshift("--headless=new")
const chrome = spawn(binary, args, { stdio: "ignore" })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json()
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error("the browser never exposed a page target")
}

let ws, seq = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  return r.result ? r.result.value : undefined
}

async function wheel(x, y, deltaY) {
  // A move first: the compositor decides which scroller a gesture targets.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" })
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, button: "none",
                                           deltaX: 0, deltaY })
  await sleep(400)
}

try {
  ws = new WebSocket(await pageSocket())
  await new Promise((r) => { ws.onopen = r })
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }

  await sleep(800)
  const version = await (await fetch("http://127.0.0.1:9222/json/version")).json()
  console.log("browser:", version.Browser, headful ? "(headful)" : "(headless)")

  // The per-cycle overflow numbers matter as much as the verdict: the fault
  // needs the list to go scrollable -> NOT scrollable -> scrollable, so a run
  // where that never happened proves nothing either way.
  const cycles = await evaluate("(async () => { document.getElementById('run').click();" +
                                " await new Promise(r => setTimeout(r, 2500));" +
                                " return { probe: window.__probe(), text: document.getElementById('out').textContent } })()")
  console.log("cycles:", (cycles.text || "").split("\n")[0])
  const triggered = /"overflowWhileOpen":[1-9]/.test(cycles.text || "") &&
                    /"overflowAfterClose":0/.test(cycles.text || "")
  console.log("trigger present (scrollable while open, not scrollable after close):", triggered)

  const box = await evaluate("(() => { const r = document.getElementById('list').getBoundingClientRect();" +
                             " return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()")

  // 1. a scripted position the wheel could not reach by itself
  await evaluate("document.getElementById('list').scrollTop = 600")
  const seeded = await evaluate("window.__probe()")

  // 2. one trusted notch downward
  await wheel(box.x, box.y, 100)
  const after = await evaluate("window.__probe()")

  console.log("seeded scrollTop:", seeded.scrollTop, "| after one notch:", after.scrollTop,
              "| max:", after.max)

  // 3. from the top, enough notches to cover the whole range. Healthy input
  //    reaches the end; the bug plateaus far below it.
  await evaluate("document.getElementById('list').scrollTop = 0")
  const notches = Math.ceil(after.max / 100) + 3
  for (let i = 0; i < notches; i++) await wheel(box.x, box.y, 100)
  const climbed = await evaluate("window.__probe()")
  const reached = after.max ? climbed.scrollTop / after.max : 1
  console.log(notches + " notches from 0 reached:", climbed.scrollTop, "of", after.max,
              "(" + Math.round(reached * 100) + "% of the range)")

  // A range under a few hundred pixels cannot show the fault: input would
  // reach the end in one or two notches either way. Say so rather than
  // reporting a result the fixture cannot support.
  if (after.max < 400) {
    console.log("INCONCLUSIVE: only " + after.max + "px of range — the page needs more content")
  } else if (reached < 0.5) {
    console.log("REPRODUCED: input stopped at " + Math.round(reached * 100) +
                "% of the range while a scripted scroll reached the end")
  } else {
    console.log("healthy on this build")
  }
} catch (e) {
  console.error("probe failed:", e.message)
} finally {
  try { ws && ws.close() } catch { /* already gone */ }
  chrome.kill()
}
