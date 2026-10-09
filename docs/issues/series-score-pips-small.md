# A series score is carried by 0.55rem dots

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — in "First to 3", the state of the series is shown as pip rows
under each fighter (`style.css:378-394`): 0.55rem circles below 0.8rem slot
text. The tally appears numerically nowhere until the match is filed into
history (`app.js:604`), so mid-match the score is a glance at two rows of
small dots on a dark panel.

**Where it shows** — the game view, from `matched` through every round of a
series (`app.js:1060`, `833`).

**Working hypothesis** — the pips read as "filling up", which was the point
(`app.js:870-871`); at phone sizes they are easy to miss, and the tally is the
thing the series is being played for.

**Questions to resolve**

1. A numeric `2–1` beside, between, or instead of the pips?
2. Larger pips vs keeping the metaphor and adding numbers beside it?
3. Does a mid-series result screen (round not final) need the score more
   prominently than the live view does?

**Proves the cause** — a decision on how a series state is displayed at a
glance. `renderPips`/`paintPips` are exercised by the client tests
(`web/app.*.test.cjs`), so a DOM change lands with an extended assertion.

**Prospective fix (not scheduled)** — numeric tally rendered from the same
server-supplied `roundsTarget`/wins the pips already use (`app.js:849-876`).
