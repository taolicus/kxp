# Invite pairs at the creator's chosen length

An invite-first *Play Online* advertises the length the creator picked, so a
reservation has to carry that length and a claim has to pair at it. Today a
challenge is hardwired to one round with `drawEnds=true` regardless of what the
lobby shows.

## Required context

- `handleJoin` builds the match itself: `makeMatch(newID(4), 1, ...)` and
  `m.drawEnds = true` (`server.go:1418`). The `1` and the `true` are the two
  hardwired values.
- `/queue` already decodes and validates the length against a closed set
  (`server.go:880-913`): `RoundsTarget int` (0 means 1), `DrawEnds *bool`
  (default `target <= 1`), rejected by `validSeriesTarget`. `/challenge`
  (`server.go:1316`) decodes only `{ID}`.
- The reservation is player-keyed and carries `creatorPid` and the paired
  `match` (`challengeEntry`, `server.go:196`); `requeue` is already `false` for a
  challenge survivor (`server.go:1435`).
- `POST /queue` and `POST /cpu` are the precedent for the request shape and the
  docs entry (`docs/features/protocol.md`).

## Constraints

- **Additive.** A client that sends no length still gets today's one-round
  `drawEnds=true` match.
- The engine (`round.go`) is untouched; the match is still built through
  `makeMatch`/`startMatchLocked`.
- The closed set is `/queue`'s (`validSeriesTarget`); a length nobody could ask
  the queue for is `400 unsupported roundsTarget`.

## Acceptance criteria

- `/challenge` accepts `roundsTarget` and `drawEnds`, validated exactly as
  `/queue` validates them; absent means one round with `drawEnds=true`.
- The reservation stores the pair, and `/join` builds the match with it — a
  three-round invite produces a `matched` frame with `roundsTarget: 3`.
- A request naming an unsupported length is `400`; the invalid case leaves no
  reservation behind (same negative direction `/queue` pins).
- A one-round invite is byte-for-byte the old behaviour (the no-change
  direction).
- Tests: length reaches the match; absent defaults to one round; invalid is
  refused.

## Notes

- Device: hub-only, no new shared state beyond the fields on `challengeEntry`
  (read under `h.mu`); the phone can carry it.
- Not in this slice: the invite screen and the paste field
  ([invite-first-entry](../open/invite-first-entry.md)).

## Landed

`POST /challenge` now decodes `roundsTarget`/`drawEnds` exactly as `/queue` does
(`server.go`), refuses an off-offer target with `400 unsupported roundsTarget`
before touching any state, and stores the pair on `challengeEntry`. Re-minting a
reservation keeps the token but rewrites the length, so a choice made after the
code is shared still reaches the match — the same "re-posting updates the seat"
rule `/queue` uses. `handleJoin` builds the match with `ch.roundsTarget` and
`ch.drawEnds` instead of the hardwired `1`/`true`.

Verified to *fail* against the pre-change hub first (server.go from HEAD):
`TestChallengePairsAtCreatorLength` ("matched roundsTarget = <nil>, want 3"),
`TestChallengeRejectsUnsupportedLength` ("200, want 400"), and
`TestChallengeReMintUpdatesLength` ("matched roundsTarget = <nil>, want 3"). The
no-change direction, `TestChallengeAbsentLengthIsOneRoundOff`, passes both before
and after: a reservation with no length is still the one-round draw-ends match,
whose `matched` frame carries no `roundsTarget`. Requests that name an invalid
length leave no reservation behind (the negative direction).
`go test ./...` ok on the phone; the rest of the gates as for the identity
slices. `-race` and `npm run e2e` remain laptop-only.

