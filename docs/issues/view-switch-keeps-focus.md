# Focus is not moved when the view changes

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — `show()` toggles classes and nothing else
(`app.js:223-234`). After a screen swap, keyboard focus stays on the
triggering control — which may now be inside a `display:none` view, dropping
focus to the body — or wherever it was left. A keyboard user tabbing into the
new screen starts from the top of the document each time.

**Where it shows** — every view change; the app's focusable surface is small
(buttons, the challenge input), so the cost is bounded but real.

**Working hypothesis** — at the app's size keyboard navigation was not a
design driver; the fix is a focus call per transition, and the natural target
(the new view's heading) needs `tabindex="-1"` to be focusable.

**Questions to resolve**

1. Focus the new view's `h2` on every `show()`, or per-transition targets —
   the game view might rather focus the move buttons when they unlock (a
   keyboard RPS player wants them at PUN, not the heading)?
2. Does focusing on entry fight the `showGame()` deferral behind `bgReady`
   (`app.js:146-150`), where the visible swap is not the transition call?

**Proves the cause** — a decision on focus targets. The unit harness can
assert `document.activeElement`, but the value is a keyboard pass on the
laptop — hand-checked, and stated as such in whatever task lands it.

**Prospective fix (not scheduled)** — focus the new view's heading inside
`show()`, with the game view's target decided separately.
