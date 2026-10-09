# Arcade runs should be tracked per mode, each resumable separately

**Provenance** — direction raised in the same UX review that filed
[lobby-length-change-resets-arcade](lobby-length-change-resets-arcade.md);
this answers that issue's keep-vs-warn-vs-reset question with *keep*, and
leaves the design of the keep open here.

**Symptom** — the arcade ladder is a single slot (`kxp-arcade`, `app.js:269`)
shared by every match length. The run is fought at the length captured from
the lobby when the mode was entered (`ladderTarget`, `app.js:24`, `1412`), and
changing the length control discards it (`app.js:1453`). A player who plays
arcade at more than one length cannot keep two runs: each switch ends the
other, silently.

**Where it shows** — the lobby's length control and the Arcade Mode entry, for
anyone who alternates `1 round` ↔ `First to 3` in arcade.

**Working hypothesis** — store one run per (rounds, drawEnds) pair — the same
pair the lobby control offers, and already persists for the *selection*
(`kxp-cpu-length` + `kxp-cpu-draw-ends`, `app.js:275-283`) — so each mode's
run is kept and resumed on its own. Switching the control then switches which
run the Arcade entry resumes; no switch discards anything, and the reset
symptom has nothing left to reset.

**Questions to resolve**

1. **Storage shape.** One key per pair vs one object keyed by the pair; and
   the migration: an existing single `kxp-arcade` becomes the run for which
   pair — the one its stored fields can be matched to, or the default?
2. **Lobby surface.** Still one Arcade button resuming whichever pair is
   selected (label showing that run's floor), or a per-mode entry? One button
   keeps the lobby flat; per-mode entries make the separation visible.
3. **What is per-track.** `cleared` (`app.js:310`), the floor, and the order
   all become per-pair; a fresh draw on one track must not touch the other.
4. **Length capture.** Does `ladderTarget` stop being read from the lobby at
   fight time and come from the run itself (`postCPU`, `app.js:882-903`)?
   That is what actually decouples a run from the control.
5. **Orphans.** When the control's offer set changes (a mode removed from the
   markup), what happens to a stored run for a pair no button offers?

**Proves the cause** — acceptance of the direction plus decisions on the five
points above; the behaviour is pinable in the client harness (`readArcade` /
`saveArcade` / `advanceLadder` are plain functions over localStorage), so the
task that follows can carry tests for "two tracks, independent floors" and
"switching leaves the other run intact" — and the negative case, that no
switch path calls `discardArcade` any more.

**Prospective fix (not scheduled)** — keyed run storage, `discardArcade()`
retired from the length-control path, `postCPU` reading the run's own length.
