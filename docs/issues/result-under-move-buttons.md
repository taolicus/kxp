# The result panel is stacked under the move buttons

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — on `result`, the banner, timing lines, stats and the Play Again /
Change mode actions render below `.moves` (`index.html:94-105`). The three
move buttons stay on screen, disabled at `opacity: 0.35` (`style.css:165`).
The outcome — the thing to read and act on — sits under a row of dead buttons,
and on a short phone viewport the result actions can fall below the fold even
in the compact layout (`style.css:685-697`), which shrinks the stage but keeps
`.moves`.

**Where it shows** — the game view, at the end of every round; the between-round
pause of a series shows the same dead row.

**Working hypothesis** — `resetGame()` hides the result panel at the next
round's countdown (`app.js:724`), but nothing collapses the moves when a result
arrives: the screen was grown around the round, and the result path was added
onto it.

**Questions to resolve**

1. Hide `.moves` on a non-final result too, or only on a match-deciding one?
2. Reorder (banner above moves), hide, or shrink — and what should happen to
   the stage's rejected-pick text, which lives in the same column?
3. Does hiding the moves affect the between-rounds ready gate's visual rhythm?

**Proves the cause** — a layout decision; if behaviour (hiding) is chosen it
lands with a client test asserting the class state — `web/app.*.test.cjs` can
see the DOM, while the styling itself is unasserted on either host.

**Prospective fix (not scheduled)** — toggle `.moves` visibility from
`renderResult` alongside the existing banner/actions reveals (`app.js:819-832`).
