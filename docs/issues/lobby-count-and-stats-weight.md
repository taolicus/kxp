# The online count and the stats line have equal weight and different importance

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `#online` and `#stats` are both 0.9rem `--muted`, stacked under
the title (`style.css:214-235`). The count gates Play Online (`app.js:243`);
the stats line (Wins · Streak · Last · Best) is local vanity — the same text
is shown again on the result screen (`app.js:650-657`).

**Where it shows** — the lobby, above the fold, on every visit.

**Working hypothesis** — both were added as small informational lines and never
re-ranked; presence affects what the player can do next, stats do not, but
they read as a pair.

**Questions to resolve**

1. Mute the stats line further, move it (history header?), or drop it from the
   lobby entirely?
2. If the lobby copy goes, what happens to `#game-stats` — the result screen's
   copy is driven by the same `setStats()` call?
3. Does the online count *deserve* more emphasis (it is the reason a button is
   dead), and is that a different issue from demoting the stats?

**Proves the cause** — a decision on what the lobby above the fold is for.

**Prospective fix (not scheduled)** — one of: stats out of the lobby view,
weight split between the two lines, or nothing (if evaluation says the pair
reads fine).
