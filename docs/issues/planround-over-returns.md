# Does `planRound` need the five fields only its tests read?

**Provenance** — read from the code in a cleanup survey, not from an observed
symptom.

**Observation** — `planRound` in `web/kxp.js` computes `msUntilReady`,
`msUntilKa`, `msUntilChi`, `dueSlot`, and `msUntilNextSlot` alongside the three
values `app.js` actually consumes (`actionable`, `msUntilPun`, `remainingMs`).
The only readers of the five are `web/kxp.test.cjs`.

**Question** — are those five part of the helper's public contract (a schedule
description worth returning whole, with the app taking the part it needs), or
are they an accident of how the pure tests were written? If the latter, the
tests should assert against the derived values they care about and the return
should shrink to what the client uses.

**Why it is not a task yet** — the answer is a judgement about the helper's API
surface, not a build: nobody has had to ask the question because the extra
fields cost nothing. It graduates only if the pure schedule is being reworked
for another reason, at which point trimming is decided with it.

**What would settle it** — naming what the five are *for*, or confirming they
exist only because `kxp.test.cjs` reaches for the internals. The trim, if
chosen, is a small follow-up to whatever touches `kxp.js` next.
