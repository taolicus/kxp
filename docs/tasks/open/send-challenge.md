---
priority: 15
phase: 4
depends-on: []
gated-on: [player-identity]
---

# Send challenge

A player creates a match and gets a shareable link (`/play?challenge=...` or
similar) that any guest can open to join that specific match directly, bypassing
the global queue. The host side shows a waiting + cancel state until the
challenger joins.

## Blocked on

[player-identity](../../issues/player-identity.md) — the link has to identify
whose match it is pointing at.
