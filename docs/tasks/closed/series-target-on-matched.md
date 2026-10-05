# Series target on `matched`

`roundsTarget` rides on `matched` as well as on every `result`, and only for a
match that is a series.

## Why the pips waited for round one

The pip rows are `roundsTarget` pips wide, and until this landed the only frame
carrying a target was `result` — so the first round of a series played with no
scoreboard at all, and the row appeared a beat after the number it counts had
already moved. A target on `matched` lets the client put the row up empty the
moment the match is found, which is what a scoreboard for a series of rounds
should do: it is there for round one too.

`matched` is additive here, not a new event, so a tab open across the deploy
keeps working: it reads the same events and ignores the extra field. An older
client simply keeps drawing the row when the first `result` arrives.

## Why absent, not zero

`seriesFields()` omits `roundsTarget` on a PvP match instead of sending a
number. Two reasons, and the second is the one that would have bitten:

1. There is no series to describe. A PvP match is one round, so any target is a
   promise the match cannot keep.
2. The client reads the target as the *width of the row it draws*. A `3` on a
   PvP match puts a three-pip scoreboard over a one-round game, lit once, with
   two pips that can never fill — a series the match does not have. Absence is
   the reading every client already had for a pre-series server, so the same
   branch covers both.

## Verified

`series_test.go` pins both directions: a CPU `matched` carries
`roundsTarget == seriesTarget`, and a PvP `matched` and `result` carry no
`roundsTarget` at all. Both were checked to fail against a `seriesFields()` that
sets the field unconditionally — the negative half was a live bug in the previous
slice, not a hypothetical: the field *was* on every result, so a PvP player was
being shown a three-pip scoreboard over a single round.

Not verified on this host: rendering (no CSS coverage here). `t1`–`t8` were not
re-run — no origin is available, and no probe reads `matched`.

Where it is described: [docs/features/protocol.md](../../features/protocol.md#server-sent-events) and [architecture.md](../../features/architecture.md#a-match-is-a-series-of-rounds).
