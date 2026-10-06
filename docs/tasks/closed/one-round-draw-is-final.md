# A one-round match ends on a draw

At a series length of one, a drawn round is the last round: `judge()` sets
`seriesOver` and the client offers the rematch. That is the mode the lobby calls
**1-off**, and it is still what an unqualified one-round match does; a
**first-to-1** beside it at the same length, added by
[game-modes](game-modes.md), replays the draw instead — "Scoped so the ladder can
opt out" below records how the two are told apart.

## Why

The lobby offers one round as the quick option, and the offer is *one round*.
A draw is worth nothing to either side and replays, which is right for a series —
two sides that cannot finish each other off should get another chance at a
decisive round. Replaying it in a one-round match is not another chance at
anything: it is a second round, which is precisely the series the player declined
when they chose this mode. What they asked for is the round they played,
including the outcome it happened to be.

It is also the behaviour this mode had before there was a series. A single-round
match ended with its only round whatever that round produced, and the result
screen offered "Play Again" from a draw as readily as from a win. Choosing one
round should not have been a way to lose that.

## Scoped so the ladder can opt out

The rule landed as `m.roundsTarget <= 1 && res[0] == ResultDraw`, with no mode
test: it is a statement about how many rounds the match has, not about who is
playing, and at the time every PvP match was already ended by `!m.seriesMatch()`
on the line above, so only a CPU one-round match could reach it. Gating the
original on the CPU would have been a second thing to get wrong when the PvP half
of [game-mode-architecture](game-mode-architecture.md) landed — and it has
landed, without the gating ever being needed: `seriesMatch()` now means "a bot
opponent or a multi-round match", and the line above this rule has since been
replaced by the `drawEnds` field described next.

It became a field when the arcade ladder needed the opposite reading at the same
length. `judge()` now ends the match on a draw when `m.drawEnds` is true;
`newMatch` defaults that field to `roundsTarget <= 1`, so a match built without a
thought for it keeps the rule above; and the ladder — the one caller with a
different answer — posts `drawEnds: false` on every floor, because a drawn round
must not decide a floor. "Scoped to the length" is still true of the default; the
field exists so a caller can pick the other reading, and the ladder is that caller.

[game-modes](game-modes.md) then added the second caller *inside* the lobby, and
with it the length-only reading stopped being enough at a target of one. The
lobby now offers a 1-off and a first-to-1 side by side — same length, opposite
rule — so the client asks for the mode explicitly rather than letting the server
infer it from the count, and the wire carries `drawEnds` on every lobby request.
The default above still stands — a match built without a thought for the field is
1-off at one round — so "scoped to the length" now describes the default alone,
not the only reachable reading.

A `void` needed no change: it is a round win for the opponent, so a one-round
match already ended on one through the ordinary tally. The draw was the only
outcome that reached the tally with nobody on the score.

## What the client needed

Nothing for the rule itself. `renderResult` gates the rematch on
`d.seriesOver !== false`, so a final result of any outcome offers it — the server
saying the match is over is the whole condition. The original change was
engine-only because the decision was already authoritative in the right place;
the bug it fixed was the server not ending a one-round match on its draw.

The ladder is the exception, and it speaks for itself on the wire: `postCPU`
sends `drawEnds: false` on every floor, and `advanceLadder` treats a drawn floor
as deciding nothing — the run stays where it was and the result button says
"Retry This Floor" rather than "Back to Floor 1". Against an honouring server the
draw is replayed and never reaches a result, so the branch is the client-side
half of the same invariant, pinned by the "a drawn floor leaves the run where it
was" test in `web/app.arcade.test.cjs`.

## Verified

`TestADrawEndsAOneRoundMatch` drives `judge` over a drawn round at a target of
one: the series ends, the tally stays 0–0 (the round is not retroactively a win
for anyone), and the announced `result` frame carries `seriesOver: true` and
`outcome: "draw"` — the wire fact the rematch button is built on. Checked to
fail against the pre-change `judge`.

`TestADrawStillReplaysInALongerSeries` is the negative direction at the default
length, so the exception cannot widen: a drawn round at first-to-three still
replays (`round` advances, `seriesOver` unset). `TestSeriesTallyCountsWinsAndIgnoresDraws`
already pinned that; this states it next to the exception.

The ladder's opt-out is pinned by `TestADrawReplaysInAOneRoundLadderFloor`, the
exception's other neighbour: the same one-round length with `drawEnds: false`
replays the draw (`seriesOver` unset, `round` advances), and it fails to build
against the pre-field `judge`.

Driven through `judge` rather than end to end on purpose — the CPU picks at
random, so an end-to-end draw would be a coin flip. The teardown path is pinned
separately by `TestASeriesOfOneRoundEndsImmediately`.

Full Go suite PASS, vet and gofmt clean, npm run unit 119/119, links 233 / 0
broken. Not verified on this host: rendering, and `t1`–`t8` (no origin; `t5`
plays the default length, which this does not touch).

Where it is described: [docs/features/architecture.md](../../features/architecture.md#a-match-is-a-series-of-rounds).
