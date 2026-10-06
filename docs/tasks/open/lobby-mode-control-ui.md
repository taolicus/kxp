---
phase: 3
depends-on: []
gated-on: []
---

# The lobby's mode control: the UI pass

The control that picks a match mode is now a "Mode:" selector above the action
buttons, and it drives both the queue and a CPU match
([game-modes](../closed/game-modes.md)). What it does not yet do is say which
mode a segment is, or stop doing double duty for the ladder.

## What is left

- **The label collision.** "1 round" and "First to 1" share a length and differ
  only in what a drawn round does — a 1-off ends the match there, a first-to-1
  replays it. As two segments the control reads as a duplicate, not a rule. Give
  a segment a name a player can tell apart at a glance, in the markup the client
  reads (`data-rounds` + `data-draw-ends`) and in the words.
- **The arcade's own length control.** A ladder floor still borrows the length
  from this control and always overrides the rule to "a draw replays" — one
  control answering two questions. The arcade belongs in its own view
  ([game-mode-architecture](../closed/game-mode-architecture.md)); give it a
  length of its own and let the lobby's control mean only the lobby.
- **The mode on the waiting screen.** A player who has queued sees no statement
  of the length and rule they asked for until the match starts; the ready/found
  screen should say it, from `roundsTarget` and `drawEnds`, the way the result's
  pips now do.

## Constraints

- No client-supplied state decides a rule — the browser posts the segment's
  `data-rounds`/`data-draw-ends`, the server judges
  ([protocol](../../features/protocol.md#http-endpoints)).
- Wire changes stay additive; the mode travels as fields on `/queue` and `/cpu`,
  not a new event.
- The remembered choice keeps its two-key shape (`kxp-cpu-length` unchanged,
  `kxp-cpu-draw-ends` new) so an old store still restores on length alone.
- Rendering, CSS, and the visual collision itself have **no automated coverage on
  this host** ([verification](../../development/verification.md)); the testable
  half is which rule a segment wires and posts.

## Acceptance

The control offers each `(length, rule)` pair under a name that says the rule,
the arcade picks its own length, and the waiting screen names the mode in the
fields the server sent.

## Landed

- The caption and the move: "Vs CPU:" → **"Mode:"**, and the selector placed
  before the action buttons it qualifies, so it reads as configuring the match
  rather than the CPU button alone. Three items above remain.