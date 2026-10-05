# Choose the CPU series length

The lobby offers a CPU match in two lengths — one round, or first to three — and
`POST /cpu` carries the choice in `roundsTarget`.

## Why a request field rather than a client default

The pip rows are `roundsTarget` pips wide, so the server already owns the length
of the series and the client already reads it. The choice therefore goes in the
request rather than into a lobby-only setting: the same number that decides the
length is the number the scoreboard is drawn from, so there is nothing to keep in
step. The control reads its own `data-rounds`, and `newMatch` takes the target as
a constructor argument rather than having it overwritten afterwards — `roundsTarget`
is documented as belonging to `run`'s goroutine, and a post-construction write
would have quietly broken that.

## Why the offer is closed

`cpuSeriesOffer` is `{1, 3}` — the two lengths the lobby shows — and anything else
is `400 unsupported roundsTarget`. A range would accept `2`, which no UI
describes: the client would owe the player a two-pip row for a mode that does not
exist, and the server would carry series behaviour for a request no player can
make. A hand-written request inventing a game the game does not have is not a
feature.

Absent is not an error. No `roundsTarget` means the client predates the field —
an older tab, or a probe — and it gets `defaultSeriesTarget`, because a deploy
must not be able to stop a returning player starting a match.

## CPU only

The lobby control sits under "Play vs CPU" and `/queue` takes no length, because
a PvP match is still one round: the ready-per-round half of
[game-mode-architecture](../open/game-mode-architecture.md) has not landed, and
honouring a series there would park two players in a match neither can leave.
The online path passes `defaultSeriesTarget` into `makeMatch` unused rather than
zero, so the day that half lands the default is a series and not a match that
ends before its first round is judged.

## A rematch repeats the match, not the lobby

"Play Again" posts the target the finished match reported (`lastTarget`), not the
lobby's current selection. Reading the selection instead would switch a player
who changed it mid-series onto a different kind of game, and the pips — drawn
from the server's target — would say one thing while the rules said another.
`web/app.lobby.test.cjs` pins exactly that: a one-round match finished with the
lobby showing three still posts one.

## Verified

Go: `TestCPUSeriesLengthIsTheOneRequested` (the requested length reaches `matched`
and `result`, and the default still applies when none is named),
`TestCPURejectsASeriesLengthItDoesNotOffer` (400, no match created, and the client
can still start an offered one), `TestASeriesOfOneRoundEndsImmediately` (judge
stops the loop and the match goes idle). All three were checked to fail against a
server that ignores the requested target and against one that skips validation.

Client: `web/app.lobby.test.cjs` (4/4) drives the real `app.js` through the real
control; the length tests fail against a client that posts no target, and the
rematch test fails against one that reads the lobby instead of the match. The
harness gained `seed()` and a seeded `querySelectorAll`, because a control wired
from a NodeList has to exist in a test or its handler is simply never wired.

Not verified on this host: rendering (no CSS coverage here). `t1`–`t8` were not
re-run — no origin is configured, and `t5` posts `/cpu` with no body, which is
the default-length path this keeps working.

Where it is described: [docs/features/protocol.md](../../features/protocol.md#why-the-series-length-is-a-closed-set) and [architecture.md](../../features/architecture.md#a-match-is-a-series-of-rounds).
