# The lobby does not say where an arcade run stands

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `setLadderEntry()` changes the Arcade Mode button's label only
when a run is cleared (`'New Arcade Mode'`, `app.js:412-421`). A player at
floor 6 of 8 sees the same plain label as a first-timer; progress is visible
only after choosing a fighter and reaching the tower — two screens later.

**Where it shows** — the lobby, for anyone with a saved run
(`kxp-arcade-runs` in localStorage, one entry per (length, rule) pair).

**Working hypothesis** — the entry was kept label-only on purpose: it is
read-only and never draws at lobby time, because the draw depends on the
fighter picked later (`app.js:410-411`, `285-288`). Floor text was treated as
the tower's job, but the tower is downstream of the resume decision.

**Questions to resolve**

1. Append progress to the label (`Arcade Mode · Floor 6`) or a muted line
   under the buttons?
2. How does it coexist with a cleared run's label, and with a run kept per
   (length, rule) pair — does it show the selected pair's floor
   ([arcade-runs-per-mode](../tasks/closed/arcade-runs-per-mode.md))?
3. Is a resume *hint* enough, or should the lobby offer "Resume" as its own
   action?

**Proves the cause** — a decision on the lobby's resume affordance.
`readArcade()` is already safe to call at lobby time — `setLadderEntry()`
calls it on every lobby entry (`app.js:998`).

**Prospective fix (not scheduled)** — floor text appended from the same
`readArcade()` result the label already reads.
