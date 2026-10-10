# Arcade run lifecycle

What ends a saved arcade run: a decided loss, and a change of the lobby's mode.
Both discard the ladder rather than carrying it forward, and the length a floor is
fought at is the run's own, captured when the mode was entered. The lobby no longer
displays the run at all.

## The bug

The tower's Fight button posted `roundsTarget: lastTarget || cpuTarget`, and
`lastTarget` is set by the result frame of the last match that ended — any match,
not just this run's. So a player who fought a one-round CPU match and then entered
the arcade with the lobby on First to 3 fought their floors at one round. The same
`lastTarget` fallback predated the run: it made a floor repeat "the match that just
finished" rather than the run's own length.

## The lobby's summary

The lobby carried an arcade summary line and the run carried `best`, a high-water
mark of floors cleared, which only that line read. Both are gone: the lobby's entry
is a single button, lit for a resumable run and reading "New Arcade Mode" once one
is cleared, and `kxp-arcade` stores only the order, the floor and the `cleared`
state. A summary that could not be acted on was the control describing the run
rather than the run being entered.

## The decisions

- **A loss ends the run.** The run is discarded and the next entry draws a fresh
  ladder. The arcade original climbs the same ladder again, but a ladder the
  player has been beaten out of is one they are no longer on, and keeping it only
  leaves stale progress to resume. The result button after a loss reads "New Arcade
  Mode" and opens a new run at the bottom.
- **Changing the lobby's mode ends the run.** The run is fought at the length it
  was started at, so choosing a different mode discards it instead of carrying a
  floor into a control that no longer matches. A re-tap of the mode already showing
  is not a change of mind and leaves the run alone.
- **The floor's length is captured once, at entry.** `ladder-fight` fights the
  run's captured length, not the last match's and not the lobby's current
  selection. The run's length cannot drift because a real mode change discards the
  run.

## What it cost the server

Nothing. Every change is client-side: discarding a `localStorage` run and reading
the length to post. No event, no field, no ladder state on the wire.

## Where the reasoning lives

[architecture](../../features/architecture.md#the-arcade-ladder) — the two discards,
the repair-versus-discard distinction, and that a floor is always the length its
run was started at.

## Pinned in

`web/app.arcade.test.cjs`: a new run takes the lobby's length rather than the last
match's, a change of the lobby's mode discards the run, a loss discards it and the
result offers a new one, and the tower after a loss opens on a fresh run at the
bottom rather than animating a drop.