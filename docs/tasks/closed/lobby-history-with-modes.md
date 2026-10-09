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

## Landed

The stack read as five modes; the fix takes the record out of it.

**What changed.** `#btn-history` moved out of the lobby's `.buttons` column
into its own `p.lobby-foot` entry below it (`web/index.html`), and a `.quiet`
style (`web/style.css`) takes the base button chrome off it — no panel, no
border, muted and underlined, brighter on hover — so the column above reads as
the four ways to play. The id is unchanged, so the `transition('history')`
wiring (`app.js:1517`) needed no edit; only the container and the clothes
changed.

**How it was verified.** `web/lobby-markup.test.cjs` was added, because no
existing gate could see the change: the client harness does not read
`index.html` (controls are seeded by selector), and the browser suite asserts
flow rather than structure. The new file parses the lobby section itself and
pins both directions — the stack holds exactly the four mode buttons, and
`#btn-history` is present and after the stack ends. `npm run unit` 204/204
(including the two new tests); `npm run links` 0 broken. No Go is touched by
this slice, so the Go gates cannot be affected by it.

**Negative proof.** Both new tests fail against the pre-change markup: the
stack test on "Match History is not in the mode stack", the placement test on
"sits after the stack ends". The file cannot silently rot into one that
passes either way.

**Not verified here.** Rendering and styling have no coverage on either host;
the `.quiet` rules and the spacing are hand-read, not observed. `npm run e2e`
was not run — this host is the phone, which has no Chromium. The browser lobby
spec was *read* for text and order assertions before the move (it uses
`#btn-cpu` and `#btn-start` only, so nothing there breaks), which is a read of
the spec, not a run of it.
