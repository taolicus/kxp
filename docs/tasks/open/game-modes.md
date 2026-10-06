---
phase: 3
depends-on: []
gated-on: []
---

# Game modes: 1-off, first-to-1, first-to-3, arcade

Three match lengths and one ladder, and the difference between the first two is
a rule the server currently infers instead of being told:

- **1-off** — one round, whatever it came to. No pips. A drawn round ends the
  match and the result offers Play Again. This is today's "one round", and it is
  every online match.
- **first-to-1** — one *decisive* round win; drawn rounds replay until there is
  one. One pip per side.
- **first-to-3** — first to three decisive rounds, pips, drawn rounds replay.
- **arcade ladder** — a progression rather than a length: every floor is a
  first-to-1 or first-to-3 CPU match, and a drawn round never decides a floor.

## Why: the draw that costs a run

Traced, so this is a fix and not an issue:

1. A ladder floor is an ordinary CPU match at whatever length the lobby's
   "Vs CPU" control is showing — `postCPU('ladder', {roundsTarget: lastTarget ||
   cpuTarget})`.
2. At a length of one, `judge()` ends the match on the draw: the rule landed by
   [one-round-draw-is-final](../closed/one-round-draw-is-final.md).
3. `advanceLadder` sends every non-win back to floor 1.

So at first-to-3 a drawn floor cannot happen (it replays), and at one round a
drawn floor costs the run. The ladder has never had its own rule about draws —
it borrowed the lobby's, and the lobby's rule is right for one round and wrong
for a floor.

## Decided

- **A floor is never 1-off.** The request a ladder floor makes always says a
  drawn round replays, whatever the lobby's control is showing; only the *length*
  comes from that control (one → first-to-1 floors, three → first-to-3 floors).
  The length control doing double duty is the "same mode selection for now"
  compromise, to be replaced with the arcade's own control in the UI pass.
- **A loss still sends the player back to floor 1.** That is the arcade
  original's rule and only the draw was wrong; nothing here changes it.
- **A drawn floor leaves the run where it was** — floor and high-water mark
  untouched, and the button says "Retry This Floor" rather than "Back to Floor
  1". Unreachable against a server that honours the floor's request, so this is
  the client-side half of the same invariant rather than a second feature: the
  ladder must not be resettable by an outcome that no longer decides a floor.
- **Online stays 1-off.** This changes only how the one-round draw rule is
  chosen; the `!seriesMatch()` term that ends every PvP match after its first
  round is [game-mode-architecture](game-mode-architecture.md)'s to remove, and
  neither task waits on the other. That one re-opens the ready handshake per
  round; this one splits the modes.
- **first-to-1 shows its pip.** `renderPips`' cutoff is currently `target > 1`,
  and its reason is specific: a one-round match was over before a row could say
  anything. first-to-1 can span rounds now, so an empty pip row is exactly what a
  drawn round leaves behind — the thing the player needs to see. 1-off and PvP
  still draw no row, for their own reasons (`drawEnds` says so; `roundsTarget` is
  absent).
- **The landed rule of one-round-draw-is-final is narrowed, not reversed.** Its
  argument — one round means one round, and replaying a draw is the series the
  player declined — is what 1-off *is*. What this changes is its scoping
  sentence, "a statement about how many rounds the match has, not about who is
  playing": at a length of one there are now two modes, so the number can no
  longer name the rule.

## Shape

- **`POST /cpu` gains `drawEnds` (bool).** Absent means the client predates the
  split and gets today's inference (`roundsTarget <= 1`), which is what keeps a
  tab open across the deploy reading the same match it always did. At a larger
  target it restates what first-to-n already implies and is ignored — there is
  nothing to validate, because a first-to-3 that ends on a draw is not a mode any
  control can select.
- **The match carries it, and `judge()` reads it.** The `m.roundsTarget <= 1 &&
  res[0] == ResultDraw` term becomes the field. `!m.seriesMatch()` and the tally
  terms are untouched.
- **`seriesFields()` sends it beside `roundsTarget`**, for the same matches it
  sends the target to. A rematch has to repeat the mode and not the lobby's
  current selection — the same argument that already keeps `lastTarget` on the
  wire ([cpu-series-length-choice](../closed/cpu-series-length-choice.md)) — so
  the client remembers `lastDrawEnds` from the result the way it remembers
  `lastTarget`.
- **Client sends its own rule**: one round → `true`; first-to-1 and first-to-3 →
  `false`; a ladder floor → `false` always.
- **Named `drawEnds`** because it is exactly the difference between the two
  modes; everything else about them follows from the target. Considered and
  rejected: `style: off|series` (vague on the wire, and "series" already means
  bot opponent in `seriesMatch()`), a `mode` field (collides with the
  `mode: online|cpu` frames already carry), and `roundsTarget: 0` for one round
  (collides with absent-means-default).

## Build order

1. **Engine and handler** — the field, `judge()`, `seriesFields()`, the decode
   and its absent-inference. Tests: a first-to-1 draw replaying is the one that
   must fail against today's `judge` (it ends any target of one on a draw);
   `TestADrawEndsAOneRoundMatch` stays as the 1-off direction and, driven without
   the field, pins the old-client reading; `TestADrawStillReplaysInALongerSeries`
   stays as the negative direction. An integration test asserts the field on
   `matched` and `result`.
2. **Client** — the third segment button, `postCPU`'s argument, `lastDrawEnds`
   on rematch, the ladder's always-`false`, the `advanceLadder` draw branch and
   its label, the `renderPips` rule. Tests: `web/app.lobby.test.cjs` beside its
   existing length tests (one round asks for `drawEnds`, first-to-1 does not, a
   rematch repeats the finished match's and not the selection's);
   `web/app.arcade.test.cjs` **flips "a draw counts as not clearing the floor"**
   — the floor stays — and "the next floor repeats the length just fought" gains
   the always-`false` rule.
3. **Docs with the code**: `architecture.md` — the "A match one round long is
   over whatever that round was" paragraph becomes a rule the client asks for,
   the pip cutoff paragraph, and the arcade ladder's "a loss or a draw puts the
   player back on the first"; `protocol.md` — the `POST /cpu` row, the closed-set
   paragraph, the field table, and the pip paragraph; `README.md`'s mode list;
   and the scoping section of
   [one-round-draw-is-final](../closed/one-round-draw-is-final.md), which must
   stop stating a rule as it stands while recording the decision it took. Then
   `git mv` this file to `tasks/closed/`.
4. **Probes**: `t5` posts `/cpu` with no body, so it takes the default-length
   path and is unaffected by design; re-run it when an origin exists.

## Not covered

The UI pass: the label collision between "1 round" and "First to 1" (they differ
only in what a draw does), the "Vs CPU:" caption that already misdescribes the
ladder, and the arcade getting its own length control. Online first-to-n waits on
[game-mode-architecture](game-mode-architecture.md).
