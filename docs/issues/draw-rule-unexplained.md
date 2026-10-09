# The match rules are never stated to a first-time player

**Provenance** — read from the code in a UX review of the web client, not from
an observed session.

**Symptom** — nothing in the lobby explains what "1 round" vs "First to 3"
does to a *drawn* round — the entire difference between the two buttons is
`drawEnds` (`index.html:44-45`), a rule the player chooses blindly. Nor does
anything say what the countdown chant means: READY → KA → CHI → PUN
(`kxp.js:30`) is the game's identity, charming once decoded and opaque before.

**Where it shows** — the lobby, the first visit; the draw rule resurfaces as
confusion the first time a drawn round replays (or ends a match) contrary to
expectation.

**Working hypothesis** — the labels were taken as self-evident ("First to 3"
is; what a draw does at "1 round" is not — the button could equally read
" sudden death"), and the chant was kept as flavour rather than taught.

**Questions to resolve**

1. One muted line under the control ("a draw ends a 1-round match; in First
   to 3, draws replay") — or fold the rule into the button labels themselves?
2. Is the chant deliberately unexplained flavour, or worth a first-run tip?
3. Does the line belong with the control's label question
   ([length-control-label](length-control-label.md)) — the same few lines of
   lobby copy, decided together?

**Proves the cause** — a decision on what the lobby must teach on first
visit; any copy lands with the lobby unit/e2e specs checked for text
assertions.

**Prospective fix (not scheduled)** — one line under `#cpu-length` in
`index.html`; no behaviour change.
