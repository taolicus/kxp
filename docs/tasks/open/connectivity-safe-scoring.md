---
priority: 3
phase: 1
depends-on: []
gated-on: []
---

# Connectivity-safe scoring

A no-valid-move timeout resolves as `void` (like a draw): no win, no streak
break, "No contest" reported, while the opponent keeps the round win. Engine +
client + leaderboard adopt it.

**Decided and scheduled.**

## Why

Not a workaround for a lost round — the round genuinely had only one valid move,
and scoring the absent side as a loss makes a connectivity fault
indistinguishable from a skill result.

Win/loss stays arrival-time-authoritative (see the anti-cheat constraints in
[leaderboard](leaderboard.md)); this changes how an *absent* side scores, not how
a present one is timed. Series mode counts a `void` round as a round win for the
opposing side — see [game-mode-architecture](game-mode-architecture.md).

## The rule in full

A round that resolves with a valid move on only one side scores `void` for the
no-move side when its note is `timeout`: it never counts as a loss against that
side's record — no win, no streak break — and the UI reports "No contest", while
the opponent still takes the round win.

Three cases must stay `loss`, and the distinction between the last two is the
point of the whole slice:

- `early` — a deliberate, invalid pick. A full `loss`.
- `late` — arrival after the window closed, reported with note `late`.
  Deliberately *not* folded into `timeout`, so it can never be scored as a
  no-contest.
- neither side producing a valid move — a `draw`, not two voids.

`yourNote`/`opponentNote` keep reporting `timeout`/`early`/`late` unchanged; the
`void` outcome does not overwrite the note.

## Where it lands

The engine emits `void` on timeouts from `resolve()`, the client scorebook treats
it like a draw, and the leaderboard applies the same rule server-side so a
connection drop never reads as a streak-breaking loss.

## Notes

- An accepted `void`/late-grace rate profile is one of the two ways
  [window-shrink](../../issues/window-shrink.md) would be proved or disproved.
