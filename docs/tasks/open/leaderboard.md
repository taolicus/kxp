---
priority: 17
phase: 4
depends-on: []
gated-on: [player-identity]
---

# Leaderboard

Server-authoritative with anti-cheat: ignore client-submitted timestamps for
ranking, cap CPU streaks.

A `void` connectivity timeout scores like a draw — never a loss. See
[connectivity-safe-scoring](connectivity-safe-scoring.md).

## Blocked on

[player-identity](../../issues/player-identity.md) — a leaderboard needs
something to key a score to. The anti-cheat rules above are independent of which
identity model is chosen.
