# Series pips

The running series score is drawn as a pip per round win still needed, one row
under each fighter, filled from the left as wins come in. It replaces the text
line (`Round 2 · 1 – 0 of 3`) that landed with the client scoreboard.

## Why

A text score is a number the player has to decode on every glance; a row of
pips reads as filling up, and it sits with the fighter it belongs to rather than
in a line above the stage. The round number went with it — the pips say where
the series stands, and mid-series the round index is not what a player is
tracking.

The rows are `roundsTarget` pips wide, because the server says how long the
series is. The client holding a hardcoded three would look correct today and
quietly lie the day the target changed, which is the same duplication of the
rules that `seriesTarget` in `round.go` exists to avoid — so
`web/app.countdown.test.cjs` drives a `roundsTarget: 5` result and asserts five
pips.

## Where it lives

`web/app.js` (`renderPips`, `paintPipRow`, `pipHTML`) and the pips themselves:
outside `#you-slot`/`#opp-slot`, because `setYouSlot`/`setOppSlot` rewrite those
slots' `innerHTML` on every result and would take the pips with them. The
remembered tally is module state for the same reason the opponent slot survives
a round: the score belongs to the series, not to the round panel.

Where it is described: [docs/features/protocol.md](../../features/protocol.md#client-state-machine).
