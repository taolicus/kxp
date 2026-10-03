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

## Notes

- The residual no-move path is recorded by the "Connectivity-safe scoring
  (planned)" section in [docs/features/protocol.md](../../features/protocol.md).
- An accepted `void`/late-grace rate profile is one of the two ways
  [window-shrink](../../issues/window-shrink.md) would be proved or disproved.
