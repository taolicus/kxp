---
phase: 4
depends-on: []
gated-on: []
---

# Tournament model

Bracket/round structure for multi-match competition. If the name "Tournament" is
meant literally, define how individual matches combine into rounds and
tournaments.

## No longer blocked

- [game-mode-architecture](../closed/game-mode-architecture.md) has landed — a bracket
  is a tree of series, and series mode now exists.
- [identity-registry](../closed/identity-registry.md) has landed — entrants have the
  server-issued `pid` to persist across matches.
