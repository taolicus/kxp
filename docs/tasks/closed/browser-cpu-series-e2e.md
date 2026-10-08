# Browser e2e: a CPU first-to-3 series runs its rounds and rematches

The second browser slice. A real tab plays a first-to-3 CPU series to
completion: non-final results continue into the next countdown, the final result
ends the match, and Play Again starts a fresh match.

## Required context

- [protocol.md](../../features/protocol.md) § result and series: `seriesOver`,
  `roundsTarget`, `drawEnds`, and why a round result and a match result are
  different frames.
- `web/app.js` `result()` and `renderResult()` (`:788-830`): a mid-series round
  hides Play Again (`seriesOver !== false`), the pips row
  (`#you-pips`/`#opp-pips`, `roundsTarget` wide) persists across the reset when
  the next countdown repaints.
- Land after [browser-cpu-match-e2e](../closed/browser-cpu-match-e2e.md) so the shared
  helpers (start-CPU-match, wait-for-result, the error watcher) are extracted at
  their third use rather than duplicated a second time.

## Scope

`e2e/cpu-series.spec.js`, one test: start a First to 3 CPU match; for each
round, assert `#count` beats + PUN and click a move; after each non-final round
assert the result panel rendered with `#btn-again` hidden and the pips row still
queued; loop to the final `seriesOver: true` result; assert `#btn-again`
visible; click it and assert a fresh `POST /cpu` leaves the tab (same mode) and
a new `matched` paints `#count` "MATCH FOUND". Deterministic in the sense that a
first-to-3 always plays ≥ 3 rounds; the loop runs until seriesOver.

Assertions must not depend on who wins: the pips count wins the client is owed,
not who holds them.

## Verify

`npm run e2e -- -g "series"` on the laptop against the deployed origin; a
deliberately wrong expectation must fail; `/health` → `activeMatches: 0` after
the run. Device: laptop only.

## Landed

Landed as `e2e/cpu-series.spec.js`. With [browser-cpu-match-e2e](browser-cpu-match-e2e.md)
the suite is now five specs, and the helpers the three specs share — the error
watcher, the lobby gate, the POST waiter, the length control — moved into
`e2e/support.cjs` at their third use (the extraction rule), with the two older
specs refactored onto it.

The non-final reading came out of the run, not out of the rulebook. The
original scope said the new match paints "MATCH FOUND"; on this link the hold
is too brief to read, exactly as cpu-match proved for the first round. So the
rematch is asserted the way the game actually proves it: `POST /cpu` carries
back the same rule pair read off the result that just landed, and the count
re-arms from READY through PUN! against a stub opponent — a fresh, playable
match, not a bounce to the lobby. The pips assertion counts slots, never who
holds them, so a win, a loss, or a draw all read the same way.

A first-to-3 cannot end in round one, so the first result must leave `#btn-again`
hidden (pins the mid-series reading) before the loop reads the button for the
final one. A drawn round replays, so the round count is a heavy tail: the spec
raises the suite timeout and loops to `seriesOver` rather than assuming a round
number.

Verified on the laptop, 2026-10-09, against https://kxp.tao.cl:

- `npm run e2e -- -g "series"` → **1 passed (1.1m)**; full suite **5/5 passed
  (50.8s)**, with the series slice at 31.3s.
- Negative-bite: the pips width was deliberately flipped 3→4 and the suite
  failed at the flipped line (`assertResult`, line 64) — the assertion cannot
  silently rot.
- `/health` → `activeMatches: 0` after the run.
- `npm run links` → 0 broken; `npm run unit` → 180/180 pass.
- Not verified here: race detector (laptop-only concern, no Go changed) and
  real radio behaviour — out of scope for a DOM suite.