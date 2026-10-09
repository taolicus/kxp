---
phase: 4
depends-on: [identity-registry]
gated-on: []
---

# Leaderboard

Server-authoritative with anti-cheat: ignore client-submitted timestamps for
ranking, cap CPU streaks.

A `void` connectivity timeout scores like a draw — never a loss. See
[connectivity-safe-scoring](connectivity-safe-scoring.md).

## Blocked on

[identity-registry](../closed/identity-registry.md) — a leaderboard needs a player to key
a score to. The anti-cheat rules above are independent of it.
