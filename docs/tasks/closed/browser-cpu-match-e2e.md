# Browser e2e: a CPU match plays end to end in one real tab

The first browser slice over the core game protocol. A real tab starts a 1-off
CPU match and plays it to a rendered result, with every phase painted and zero
console errors.

## Required context

- [protocol.md](../../features/protocol.md) — the match lifecycle
  (`idle → preparing → countdown → shoot → done`), the ready handshake, the 2 s
  PUN window.
- [architecture.md](../../features/architecture.md) § Game state machine and
  § Matchmaking — the `matched` frame, the rAF-gated ready ack
  (`web/app.js:182-201`), `planFromCountdown` owning the count paint.
- The wire-level version this ports: `tools/t5-cpu-match.mjs` asserts the same
  loop on the wire; `web/app.countdown.test.cjs` and
  `web/app.ready.test.cjs` pin the paint and the ack against a stubbed clock and
  context. What this slice adds is the actual browser: real SSE frames driving
  the real DOM, the auto-ack actually firing, and a move click landing inside a
  real PUN window.
- Spec conventions to follow: `e2e/lobby.spec.js` (`watchErrors`, `gotoLobby`,
  `nextPost`).

## Scope

`e2e/cpu-match.spec.js`, one test: lobby → `#btn-cpu` → `#btn-start` → the
`matched` frame paints `#count` "MATCH FOUND" and the opponent slot → **without
any test input**, the countdown begins (the proof the rAF gate acked and POSTed
`/ready`) → `#count` shows READY/KA/CHI → PUN unlocks `.move` buttons → a click
locks them (`picked`) and a `POST /move` leaves the tab → the result panel
renders (banner + `#game-stats` + `#btn-again`) → the `state idle` teardown does
**not** bounce the client off the result screen. Every phase asserted as painted,
and any console/page error fails the test.

Beat *spacing* (~1 s) is deliberately not re-asserted here: it is pinned
deterministically by `web/app.countdown.test.cjs` and `t5`, and a wall-clock
assertion in a browser test against a production link can only flake.

## What is not known (resolve first, on the laptop)

Whether Playwright's headless Chromium fires `requestAnimationFrame`. The ready
ack waits for a painted frame (`web/app.js:195`), so if rAF never runs the match
sits in "MATCH FOUND" and dies at the server's 8 s handshake timeout. That is a
real finding, not a test failure to paper over; the fallback being considered is
a headed run (`npx playwright test --headed`). Record which was needed in the
closed task file.

## Verify

`npm run e2e -- -g "CPU"` on the laptop, against the deployed origin. Then prove
the test bites: run once with one expectation deliberately wrong (e.g. assert
the result never renders) and require it to fail loudly. Confirmed negative must
be recorded where the slice's detail lives.

Also confirm the server let the match go after the run: `/health` →
`activeMatches: 0`.

Device: laptop only — the phone has no Chromium
([device-aware-workflow.md](../../development/device-aware-workflow.md)).

## Landed

Landed as `e2e/cpu-match.spec.js`; with
[browser-lobby-e2e](browser-lobby-e2e.md) the suite is now four specs.

The open unknown is resolved: Playwright's headless Chromium **does** fire
`requestAnimationFrame`. The ready ack opened the countdown without any test
input and without the considered headed fallback (`--headed`), so the
rAF-gated handshake runs in the browser the suite uses.

Verified on the laptop, 2026-10-08, against https://kxp.tao.cl:

- `npm run e2e -- -g "1-off"` → **1 passed (8.8s)**, repeated after the
  teardown-settle re-assert (9.5s). `npm run e2e` full suite → **4/4 passed
  (16.7s)**.
- Negative runs failed loudly on two first drafts, which is how the spec earned
  its shape rather than masking flake: the "MATCH FOUND" hold was too brief for
  a locator on a fast link (the count was already READY), so it became the
  beat-poll through PUN!; and the opponent slot paints the CPU's name + `(cpu)`
  role tag, not "Opponent". A deliberately flipped `#btn-again` expectation
  then failed loudly at the flipped line, so the teardown-persist assert reads
  the real screen rather than passing vacuously.
- `/health` → `{"activeMatches":0,...}` after the runs: the matches the tests
  started were let go by the server, not stranded.

Not covered: beat spacing (pinned instead by `web/app.countdown.test.cjs` and
`tools/t5`), styling and layout (asserted nowhere on either host), and the
phone (this suite needs Chromium, so it is laptop-only). The series, PvP,
reload, and timeout-path slices that follow this one are scheduled in
[docs/tasks/open/](../open/).