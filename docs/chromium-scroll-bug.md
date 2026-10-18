# Chromium bug report

**Filed: https://issues.chromium.org/issues/574960594** (2026-10-18)

Keep this with the workaround in `collapseThinkingBlock` — it is what says
when the workaround can be removed. Re-run the test case below on a newer
Chrome to check whether the fault is still there.

File at <https://issues.chromium.org/issues/new>, component **Blink>Scroll**,
type **Bug**. Attach `chromium-scroll-bug-minimal.html` and
`chromium-scroll-bug-probe.mjs` from this directory, and paste the HTML inline
as well — it is short enough to read without downloading.

### Status of the attached test case

The originals, confirmed to reproduce 2 of 2 with three cycles, were lost with
the scratchpad they lived in. These were rebuilt from the recorded ingredients
and are **self-checking**: each cycle prints whether the required transition
occurred, so a run that never set up the condition cannot be mistaken for a
clean result.

Verified on **Chromium 153.0.8010.47, headless**:

    cycles: [{"cycle":1,"overflowWhileOpen":0,...},
             {"cycle":2,"overflowWhileOpen":25,"overflowAfterClose":0,...},
             {"cycle":3,"overflowWhileOpen":73,"overflowAfterClose":0,...}]
    trigger present (scrollable while open, not scrollable after close): true
    seeded scrollTop: 600 | after one notch: 700 | max: 1166
    15 notches from 0 reached: 1166 of 1166 (100% of the range)
    healthy on this build

So the test case does establish the condition, and on 153 headless the fault
does not follow. Whether that means 153 is unaffected — making this a
regression in 154 — or that the reconstruction is missing something the
original had, is **not known**: no 154 or 155 build, and no display for a
headful run, was available where it was rebuilt. The measurements in this
report all come from 154 and 155.

---

## Title

Closing a `<details>` that contains a scroller leaves the ancestor scroll
container with a stale wheel/keyboard scroll range

## Chrome version

- 154.0.8037.100 — reproduced and bisected.  OS: <FILL IN>
- 155.0.8059.40 (official build, arm64) — same symptom reported independently
  by a second person on a different machine.  OS: <FILL IN>

Firefox 158: not affected, on the same page and with the same collapse pattern.

Reduced test case rebuilt later did NOT reproduce on Chromium 153.0.8010.47
(headless, Linux) with the triggering transition confirmed present — see
"Status of the attached test case" above. That may make this a regression in
154, or may mean the rebuilt case is incomplete; it has not been run on 154 or
155.

## What happens

An element with `overflow-y: auto` stops accepting wheel, trackpad and keyboard
scrolling beyond a small offset, while `scrollTop` assigned from script still
moves it anywhere and the value holds. `scrollTop` and `scrollHeight` report
correct values throughout; only input-driven scrolling is clamped.

The clamp equals the container's scrollable overflow at an earlier moment — the
instant a `<details>` inside it was closed while that `<details>` was the only
reason the container overflowed.

## Steps to reproduce

1. A scroll container (`overflow-y: auto`) inside an ancestor with
   `overflow: hidden`.
2. Inside the container, a `<details open>` whose content is itself a scroller
   (`max-height` + `overflow-y: auto`), sized so the container overflows only
   because of it.
3. Close it from script: `details.open = false`. The container is momentarily
   not scrollable.
4. Append enough normal content to make the container scrollable again.
5. Scroll with a real wheel, trackpad or keyboard.

With three such cycles it reproduces 2 of 2 runs; with one cycle, about 1 of 2.

**Trusted input is required.** A dispatched `WheelEvent` never scrolls, so this
cannot be reproduced with synthetic events — use CDP
`Input.dispatchMouseEvent {type: "mouseWheel"}` or Puppeteer's
`page.mouse.wheel`.

## Expected

Wheel and keyboard scrolling can reach `scrollHeight - clientHeight`.

## Actual

They stop at the container's overflow from step 3, often only tens of pixels.
Measured on a real page: stuck at 9.6, 21.6 and 81.6 against maxima of 373, 469
and 932. In one case the timeline matched exactly — the overflow was 22 while
the `<details>` was open, dropped to 0 when it closed, then grew to 469, and the
wheel stuck at 21.6. A single wheel notch from a scripted `scrollTop = 600`
snapped the position straight back to 112.8.

## Ruled out

- No script writes `scrollTop` (verified by hooking the property setter with
  stack traces), and no `scrollTo`, `scrollBy` or `scrollIntoView` is called.
- No DOM mutation while the fault is present; `scrollHeight` constant.
- `overflow-anchor: none` on the container makes no difference.
- Not zoom-dependent (seen at 1.41 and at 100%).
- Not caused by a nested horizontal scroller, by `resize: both`, or by
  `position: fixed` — static positioning still fails.
- Browser extensions excluded: `Element.prototype.scrollTo` is native and no
  wheel or keydown listeners are attached.
- Toggling `overflow-y` on the container does not clear it.

## Required ingredients

Closing via `details.open = false` (a plain `div` hidden with `display: none`
behaves correctly), a scroller inside the `<details>`, and `overflow: hidden` on
the ancestor.

## Workaround, for anyone who finds this

Remove the scroller from the inner element before closing, and close two
animation frames later. One frame is not enough:

```js
body.style.overflow = "visible";
body.style.maxHeight = "none";
requestAnimationFrame(() => requestAnimationFrame(() => { details.open = false; }));
```

Verified over 6 of 6 runs on a real page that failed 3 of 4 before, with the
triggering condition confirmed present 2 to 4 times in every passing run.
