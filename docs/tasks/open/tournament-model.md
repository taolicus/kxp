---
phase: 4
depends-on: [game-mode-architecture, identity-registry]
gated-on: []
---

# Tournament model

Bracket/round structure for multi-match competition. If the name "Tournament" is
meant literally, define how individual matches combine into rounds and
tournaments.

## Blocked on

- [game-mode-architecture](../closed/game-mode-architecture.md) — a bracket is a tree of
  series, so it cannot exist before series mode does.
- [identity-registry](../closed/identity-registry.md) — entrants have to persist
  across matches, which the player registry provides.
