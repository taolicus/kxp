---
phase: 2
depends-on: [browser-cpu-match-e2e]
gated-on: []
---

# Browser e2e: reloading mid-match reconciles and never strands the tab

The fourth browser slice: the real reconnect path. A tab dropped mid-match
(here, by reload) must reconcile through the `connected` snapshot and land
somewhere healthy — re-armed into the round it can still win, or in the lobby
with a fresh match possible — and must never sit stuck on "Waiting for result…".

## Required context

- [protocol.md](../../features/protocol.md) § reconnect and § snapshot: the
  `connected` snapshot carries phase + match state; the stall watchdog
  (6 s) vs the server `readyTimeout` (8 s).
- `web/app.reconnect.test.cjs` pins the snapshot *destination* logic against a
  stubbed context; `tools/t6-reconnect.mjs` proves the wire-side drop/repair.
  Neither runs the actual `app.js` snapshot handler against real SSE frames on a
  real document.
- The documented failure class is the client stuck after a drop
  (docs/issues/ entries seen in
  [app.reconnect.test.cjs](../../../web/app.reconnect.test.cjs) header); the old
  withdrawn suite flow 3 was exactly this test.
- Land after [browser-cpu-match-e2e](../closed/browser-cpu-match-e2e.md).

## Scope

`e2e/reload.spec.js`, one test: start a CPU match, wait until the countdown has
begun (`#count` no longer "MATCH FOUND"), `page.reload()`, wait for the lobby's
`connected` snapshot to repaint, then assert the tab is not dead — either it is
re-armed into the surviving round, or it has a working lobby from which a fresh
CPU match starts and completes. `ERR_ABORTED` console noise from the torn-down
SSE stream is already whitelisted in `watchErrors`. Any "Waiting for result…"
that persists to the end fails the test.

## Verify

`npm run e2e -- -g "reload"` on the laptop against the deployed origin; the
deliberately-wrong expectation (assert the stale screen persists) must fail;
`/health` → `activeMatches: 0` afterwards. Device: laptop only.