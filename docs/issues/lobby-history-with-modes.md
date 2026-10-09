# Match History sits in the play-mode stack

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — the lobby's `.buttons` column mixes four ways to start a match
with one that opens a record (`index.html:47-56`). Every non-primary entry
shares one button style (`style.css:151-166`), so Match History reads as a
fifth mode rather than as a look at something that already exists — which is
exactly the distinction the markup's own comment draws (`index.html:52-54`).

**Where it shows** — the lobby, first and every visit.

**Working hypothesis** — placement was chosen for the column's uniformity: one
primary, then four equal secondaries. The actions are different kinds — start
something vs read something — and the stack flattens that.

**Questions to resolve**

1. Does separating History (text link, corner affordance, de-emphasised row)
   improve first-visit scanning enough to break the stack's uniformity?
2. If more modes or a roster screen arrive later, do Arcade Mode and Challenge
   earn grouping of their own — and is that the real reason to restructure now?

**Proves the cause** — a decision on the lobby's action hierarchy. The e2e
lobby spec (`e2e/lobby.spec.js`) may assert button presence or order; check
before moving anything.

**Prospective fix (not scheduled)** — History out of `.buttons`, styled as the
secondary link the record already is.
