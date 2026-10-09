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

## Landed

**What changed.** Runs now live in one object under `kxp-arcade-runs`, keyed by
the `(rounds, drawEnds)` pair (e.g. `3:0`), with `readArcade(pair)`,
`saveArcade(pair, run)` and `discardArcade(pair)` taking the pair. `ladderTarget`
is replaced by `ladderPair`, captured from the lobby at `climb` entry; `postCPU`
reads the run's own pair rather than the lobby, so a floor is always the length
its run started at. The length-control click no longer calls `discardArcade` —
it only calls `setLadderEntry`, which now reads the entry for whichever pair the
control shows. `setLadderEntry` also moved after the saved-selection restore in
`DOMContentLoaded`, so the label reflects the pair the restore settled on rather
than the markup default.

The five questions, resolved:

1. **Storage shape** — one object keyed by the pair, not one key per pair: a
   single read/write keeps the whole map consistent, and a pair is a value, not a
   naming scheme. Migration folds the old single run into the pair the saved
   selection names, taking the pre-rule meaning where the rule key is absent
   (length 1 → the 1-off), then removes the legacy key. The pair is the only one
   the run could have been fought at, since the old store had no length of its
   own.
2. **Lobby surface** — one Arcade button, reading the selected pair's run. Per-
   mode entries were rejected: the pair is a buried control, and a flat lobby
   with one arcade entry is the shape the record view already keeps.
3. **Per-track state** — the order, floor and `cleared` all live inside the pair's
   entry, so a fresh draw on one pair cannot touch the other.
4. **Length capture** — `postCPU` reads `ladderPair.rounds`; the lobby is no
   longer consulted at fight time. This is the decoupling that made the reset
   unnecessary.
5. **Orphans** — a stored run for a pair no button offers is left in the map
   untouched, consistent with the untrusted-store posture: it is unreachable
   until a matching button returns, and it is not the client's place to reap it.

**How it was verified.** `web/app.arcade.test.cjs`: the old "changing the lobby
mode discards the run" test was replaced by "switching the lobby mode keeps both
runs, each resumable on its own" (climb pair `3:0` to floor 1, switch to `1:1`,
fight a fresh floor 0 there, assert `runs['3:0']` still holds the first order at
floor 1, switch back and resume it), and a migration test pins the adopt-and-
remove. `npm run unit` 206/206; `npm run links` 0 broken.

**Negative proof.** The replacement test asserts the run just left survives the
switch (`runs['3:0'].order` deep-equal, floor unchanged), so a reintroduced
discard fails it. The migration test asserts the legacy key is gone, so a
migration that read without removing would fail. Against the pre-change `app.js`
the two new tests cannot even load — `readArcade`/`saveArcade` took no pair — so
they pin the new surface by construction.

**Not verified here.** No behaviour reaches the server differently: the wire
already carried `roundsTarget`/`drawEnds` per request, and a floor still posts
`drawEnds: false`. The host is the phone (arm64 Android); no Go and no shared
server state is touched. `npm run e2e` (Chromium) does not run here, so the
lobby's re-labelling on a switch is hand-read, not exercised in a browser.
