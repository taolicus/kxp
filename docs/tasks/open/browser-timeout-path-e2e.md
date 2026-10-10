---
phase: 2
depends-on: []
gated-on: []
---

# Browser e2e: a match with no pick still renders its timeout result

The fifth browser slice: the no-move path. A player who never clicks must still
get a resolvable screen — the timeout result renders (`yourNote: 'timeout'`,
"Timed out — no pick." in `#timing`, a banner, and Play Again offered) — and
must be able to rematch. The point is the absence of a stuck screen: probes `t7`
cover the `too late` rejection on the wire, and this slice covers the client's
half of the same event, which is the "Waiting for result…" dead-end class.

## Required context

- [protocol.md](../../features/protocol.md) § result and the PUN window
  deadline: the server closes the window at `shootAt + windowMs` and judges the
  round with a void instead of waiting.
- `web/app.js` `shoot()` (`:1054-1077`): a window already past paints "Waiting
  for result…" briefly and transitions to `locked`; `KXP.resultLines`
  (`web/kxp.js:147-160`) renders `yourNote: 'timeout'`.
- This is the optional slice of the plan: land last, and only if the first four
  are green — it shares their helpers and adds the least new protocol surface.

## Scope

`e2e/timeout-path.spec.js`, one test: start a 1-off CPU match, wait for PUN,
touch nothing, wait out the window, and assert the result panel renders with the
timeout note and `#btn-again` visible, that Play Again starts a fresh `matched`,
and that the whole run produced zero console errors. Roughly 6 s longer than the
happy-path slice.

## Verify

`npm run e2e -- -g "timeout"` on the laptop against the deployed origin with the
usual deliberately-wrong negative run, and `/health` → `activeMatches: 0` after.
Device: laptop only.