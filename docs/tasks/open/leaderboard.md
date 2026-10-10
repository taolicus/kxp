---
phase: 4
depends-on: []
gated-on: []
---

# Leaderboard

Server-authoritative with anti-cheat: ignore client-submitted timestamps for
ranking, cap CPU streaks.

A `void` connectivity timeout scores like a draw — never a loss. See
[connectivity-safe-scoring](connectivity-safe-scoring.md).

## No longer blocked

[identity-registry](../closed/identity-registry.md) has landed — the server-issued
`pid` is what a score keys to. The anti-cheat rules above are independent of it.
