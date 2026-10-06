---
phase: 3
depends-on: []
gated-on: []
---

# The lobby's mode control: the UI pass

The control that picks a match mode is a "Mode:" selector above the action
buttons, offering two modes — one round (a 1-off) and first to 3 — and it drives
both the queue and a CPU match ([game-modes](../closed/game-modes.md)). What it
does not yet do is stop doing double duty for the ladder, or say the mode
anywhere before the match starts.

## What is left

- **The arcade's own length control.** A ladder floor still borrows the length
  from this control and always overrides the rule to "a draw replays" — one
  control answering two questions, which is why a one-round lobby choice is a
  1-off online but a first-to-1 on a floor. The arcade belongs in its own view
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
  `kxp-cpu-draw-ends` new) so an old store still restores on length alone and a
  first-to-1 store from the old three-segment control falls back cleanly.
- Rendering, CSS, and the visual result have **no automated coverage on this
  host** ([verification](../../development/verification.md)); the testable half
  is which rule a segment wires and posts.

## Acceptance

The arcade picks its own length, and the waiting screen names the mode in the
fields the server sent.

## Landed

- The caption and the move: "Vs CPU:" → **"Mode:"**, and the selector placed
  before the action buttons it qualifies, so it reads as configuring the match
  rather than the CPU button alone.
- The label collision: the third segment (first-to-1) was cut, leaving one round
  and first to 3, so no two segments share a length. A one-round lobby choice is
  a 1-off online and a CPU match, and the arcade still asks its floor for a
  first-to-1 in the field, not the control. The two items above remain.