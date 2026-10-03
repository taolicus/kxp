---
priority: 2
phase: 3
depends-on: [connectivity-safe-scoring]
gated-on: []
---

# Game-mode architecture

Series-aware `run()`/`resolve()`: a match becomes a sequence of rounds, first to
3 decisive wins, draws replayed. A round that resolves `void` (no valid move, see
[connectivity-safe-scoring](connectivity-safe-scoring.md)) counts as a round win
for the opposing side.

`result` gains round/series fields — `round`, `youRoundWins`, `oppRoundWins`,
`roundsTarget`, `seriesOver`. A round result advances the client scoreboard and
re-enters countdown; a final result ends the series.

Ships for **CPU matches first** (ready stays once-per-series); PvP re-opens the
ready handshake per round afterward. The two are the two halves of this one
entry, which is why they are one task rather than two.

Builds on the Protocol rework Task A schedule, which shipped first.

## Notes

- `docs/features/architecture.md` describes the current single-round `run()`/`resolve()`
  shape this replaces.
