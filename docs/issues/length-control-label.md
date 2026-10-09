# The match-length control is labelled "Mode:" and its selected state is a hairline

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — the segmented control above the lobby buttons is labelled
`Mode:` (`index.html:36`) while a button in the stack below is labelled
"Arcade Mode" (`index.html:51`), and the control actually sets the match
length and draw rule for online, CPU *and* ladder (`app.js:1419`, `1412`). The
selected option is marked by an accent border and a marginally lighter
background (`style.css:260-265`) — faint at small sizes.

**Where it shows** — the lobby, every visit; the choice is persisted
(`app.js:1457-1460`) and restored without the player watching it happen
(`app.js:1481-1497`).

**Working hypothesis** — "Mode" was shorthand for "the mode of the match";
the word now answers to two controls, and the selected state was drawn as an
inline segment rather than as a decision the eye should catch.

**Questions to resolve**

1. `Match:` / `Length:` / `Best of…` — or keep the word and disambiguate
   elsewhere?
2. Filled accent or checkmark for the selected option vs the current border?
3. Does the draw-rule difference (see
   [draw-rule-unexplained](draw-rule-unexplained.md)) belong under this
   control?

**Proves the cause** — a decision on label and affordance; grep the lobby
unit/e2e specs for the label text before renaming anything.

**Prospective fix (not scheduled)** — markup label change plus a stronger
`.seg-btn.selected`; no behaviour change.
