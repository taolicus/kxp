---
phase: 4
depends-on: [game-mode-architecture]
gated-on: []
---

# Solo campaign

Mortal Kombat–style tower climbing with progression. **Client-side only**: a
5-floor ladder against roster fighters, stock bot on every floor, boss on the
final floor, loss restarts the tower, best floor persisted in `localStorage`.

Fights run under the mode selector (best-of-5 default; draws replayed).

## Blocked on

[game-mode-architecture](game-mode-architecture.md) — the mode selector it runs
under is the series work.

Not blocked on the identity primitive: this persists to `localStorage` like the
[arcade ladder](arcade-ladder.md), and will need retrofitting onto whatever
[player-identity](../../issues/player-identity.md) decides.

## Relationship to the arcade ladder

The ladder is the tour; this is the tower. Both are a roster of floors climbed
against the stock bot, both restart on a loss, both persist to `localStorage` —
so the shared parts (floor order from the roster, progression on the final
result, persistence) are built once, here, by the ladder, and this is what is
left over: a boss on the final floor and an endurance match. Neither is in the
ladder build, the boss because it would have to be a character outside the
roster, and endurance because it was deferred.
