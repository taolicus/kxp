# A one-round match ends on a draw

At a series length of one, a drawn round is the last round: `judge()` sets
`seriesOver` and the client offers the rematch.

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

## Scoped to the length, not the mode

The rule is `m.roundsTarget <= 1 && res[0] == ResultDraw`, with no mode test. It
is a statement about how many rounds the match has, not about who is playing, and
a PvP match is already ended by `!m.seriesMatch()` on the line above. Gating it
on the CPU would have been a second thing to get wrong when the PvP half of
[game-mode-architecture](../open/game-mode-architecture.md) lands.

A `void` needed no change: it is a round win for the opponent, so a one-round
match already ended on one through the ordinary tally. The draw was the only
outcome that reached the tally with nobody on the score.

## What the client needed

Nothing. `renderResult` gates the rematch on `d.seriesOver !== false`, so a
final result of any outcome offers it — the server saying the match is over is
the whole condition. The change is engine-only because the decision was already
authoritative in the right place; the bug was the server reporting a match as
still running.

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

Driven through `judge` rather than end to end on purpose — the CPU picks at
random, so an end-to-end draw would be a coin flip. The teardown path is pinned
separately by `TestASeriesOfOneRoundEndsImmediately`.

Full Go suite PASS, vet and gofmt clean, npm run unit 119/119, links 233 / 0
broken. Not verified on this host: rendering, and `t1`–`t8` (no origin; `t5`
plays the default length, which this does not touch).

Where it is described: [docs/features/architecture.md](../../features/architecture.md#a-match-is-a-series-of-rounds).
