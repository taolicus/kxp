---
phase: 2
depends-on: [browser-cpu-match-e2e]
gated-on: []
---

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
- Land after [browser-cpu-match-e2e](browser-cpu-match-e2e.md) so the shared
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