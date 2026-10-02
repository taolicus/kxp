---
priority: 18
phase: 4
depends-on: [game-mode-architecture]
gated-on: [player-identity]
---

# Tournament model

Bracket/round structure for multi-match competition. If the name "Tournament" is
meant literally, define how individual matches combine into rounds and
tournaments.

## Blocked on

- [game-mode-architecture](game-mode-architecture.md) — a bracket is a tree of
  series, so it cannot exist before series mode does.
- [player-identity](../../issues/player-identity.md) — entrants have to persist
  across matches, which is what the identity model decides.
