# Browser e2e: a CPU match plays end to end in one real tab

The first browser slice over the core game protocol
([the slices that follow it](../open/browser-cpu-series-e2e.md) and friends): a
real tab starts a 1-off CPU match and plays it to a rendered
result. Where the harness tests prove `app.js` can paint beats against a stubbed
clock and the probes prove the server runs the wire loop, this proves the two
meet — a real SSE stream drives the real DOM, the ready ack actually fires, and
a move click lands inside a real PUN window.

Landed as `e2e/cpu-match.spec.js`; with [browser-lobby-e2e](browser-lobby-e2e.md)
the suite is now four specs.

## What each assertion is guarding

- `(cpu)` in the opponent slot and the `.move` buttons locked — the `matched`
  frame painted the game view, and moves stay disabled until PUN.
- The beats READY → PUN! painting **without any test input** — the readiness
  handshake proof. The client acks `/ready` only after a painted frame, so a
  headless Chromium that never ran `requestAnimationFrame` would hang in
  "MATCH FOUND" until the server's 8 s handshake timeout. **The open unknown in
  the task file is resolved:** Playwright's headless Chromium does fire rAF, the
  auto-ack opened the countdown, and no headed fallback was needed.
- `#banner` / `#timing` / `#btn-again` rendered by the result frame — the
  outcome panel a player actually reads, outcome-agnostic (win/loss/draw all
  pass).
- The tab **still on the game screen** 2.5 s after the result — the `state idle`
  teardown must not bounce a reader back to the lobby.
- The whole run with zero console or uncaught-page errors.

Not asserted: beat spacing (~1 s), which stays pinned deterministically by
`web/app.countdown.test.cjs` and `tools/t5` — a wall-clock assert against a
production link can only flake.

## Verified on the laptop, 2026-10-08, against https://kxp.tao.cl

- `npm run e2e -- -g "1-off"` → **1 passed (8.8s)**, then again after the
  teardown-settle re-assert (9.5s). `npm run e2e` full suite → **4/4 passed
  (16.7s)**.
- **Negative runs failed loudly** on two first drafts, which is how the slice
  earned its current shape rather than masking flake:
  - first draft asserted `#count` reached "MATCH FOUND" — a fast link already
    paints READY/KA/CHI/PUN! when the locator looks, so that assert was the
    flake and it became the beat-poll instead;
  - `#opp-slot` "Opponent" was wrong twice over — a CPU match paints the CPU's
    name and `(cpu)` role tag — and the assertion now reads the real role
    marker.
  - a deliberately flipped `#btn-again` expectation **failed loudly** at
    `e2e/cpu-match.spec.js:115`, so the teardown-persist assert reads the real
    screen rather than passing vacuously.
- `/health` → `{"activeMatches":0,...}` after the runs: the matches the tests
  started were let go by the server, not stranded.

## What it does not cover

Beat *timing* (above), the CSS the panel renders with, and the phone: this
suite still needs Chromium, so it is laptop-only
([device-aware-workflow.md](../../development/device-aware-workflow.md)). The
series, PvP, reload, and timeout-path slices are named and scheduled in
[docs/tasks/open/](../open/).