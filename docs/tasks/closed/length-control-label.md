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
   [draw-rule-unexplained](../../issues/draw-rule-unexplained.md)) belong under this
   control?

**Proves the cause** — a decision on label and affordance; grep the lobby
unit/e2e specs for the label text before renaming anything.

**Prospective fix (not scheduled)** — markup label change plus a stronger
`.seg-btn.selected`; no behaviour change.

## Landed

**What changed.** The control is labelled `Length:` and its `aria-label` is
`Match length` (`web/index.html`), so the word no longer collides with the
"Arcade Mode" button and names the axis it really sets. The selected option is
now a filled accent chip — `background: var(--accent)` with `color: var(--bg)`
(`web/style.css:260-265`) — instead of a hairline border on a marginally
lighter panel. The `.seg-btn.selected` rule is two classes and so outranks
`button:hover` (one class), which is what keeps the fill from being washed out
the moment the cursor is over it.

Question 1 resolved as `Length:` — the codebase already speaks of the "series
length" (`app.js`), and `Match:` is breadthed into by the record view. Question
2 resolved as a filled chip: it reads as a decision at small sizes where the
border did not. Question 3 left where it was: the draw rule is still unexplained
on the control and stays parked in
[draw-rule-unexplained](../../issues/draw-rule-unexplained.md); this slice does
not change that.

**How it was verified.** `web/lobby-markup.test.cjs` gained a third case that
reads the label out of the lobby's markup and asserts it is `Length:`. `npm run
unit` 205/205 and `npm run links` 0 broken.

**Negative proof.** The new case was run before the markup edit and failed with
`'Mode:' !== 'Length:'`, so it pins the rename rather than passing either way.

**Not verified here.** Styling and layout are asserted nowhere on either host;
the filled-chip affordance is hand-read from the CSS, not observed in a browser.
`npm run e2e` (Chromium) does not run on this host (the phone), and this markup
change was not exercised in a browser session. No behaviour changed, so no probe
is relevant.
