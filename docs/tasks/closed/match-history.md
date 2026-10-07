---
phase: 4
depends-on: []
gated-on: []
---

# Match history

A player opens a list of the matches this browser has finished: one row per
match, expandable to the rounds inside it.

## Why this is not gated

There is nothing to gate on. The server keeps no history and has no key to keep
one under — no persistence surface in this repo, and no identity to key one to —
so the record is the client's own, in `localStorage`, beside `kxp-stats` and
`kxp-arcade`. It is this browser's account of what it saw, display-only, cleared
by clearing the site, and no better than the frames that produced it.

It is not a leaderboard and is not shaped like one: ranking needs something a
`localStorage` array cannot give, which is why
[leaderboard](../open/leaderboard.md) stays gated on
[player-identity](../../issues/player-identity.md) and this does not.

## When a match is recorded

- **On every `result`**, a round is appended to a pending list: the round number,
  both moves, both notes, both timings, the outcome and the frame's `ts`.
- **The match is committed by the frame that ends the series** — `seriesOver !==
  false`, the same rule the [arcade ladder](../../features/architecture.md#the-arcade-ladder)
  advances on and the result screen draws its button from, so history, the ladder
  and the button agree on what "decided" means, and a server predating the field
  records rather than leaving the match unrecorded.
- **A tab closed mid-series** leaves an uncommitted pending list: an unfinished
  match is not recorded. That is the correct reading of a record, not a loss.
- **`round` one starts a new pending list**, because it is the one thing on a
  frame that says *which* match it belongs to — all a client has if its server
  was restarted under it. A frame that names no round (the two departure forms)
  becomes a row only when nothing else is recorded: a match that opened and
  closed on a departure is still worth showing, while a forfeited series must not
  grow a round nobody won.

## What `matchCtx` is for

Captured on `matched`: `opponentName`, `opponentCharacter`, `roundsTarget`,
`background`.

The premise this was specified on was wrong, and corrected as it was built:
`opponent-left` no longer carries only `{outcome, mode}` — commit `f4bedb0` put the
identity pair on every form of it, so the opponent's fighter and name arrive on
the frame today. What does not arrive on any form is the **stage**, and the plain
form of a departure — one before anything was scored — carries no series fields
either (`round.go` sends `{outcome, mode, opponentName, opponentCharacter}`),
while the forfeited form carries the tally but deliberately no `round` and no
`ts`. The context therefore fills the stage and the plain departure's length, and
makes the record independent of which of the two shapes arrived; wherever a frame
does carry a field, the frame wins.

## Storage is untrusted, and capped on the way in

`kxp-history` is an array capped at 50, shape-checked on read the way
`readArcade` checks a ladder. What is in `localStorage` is writable by hand and
outlives the code that wrote it, so an entry that is not an object, that has an
outcome or mode outside the wire's closed sets, or that is missing a timestamp
or rounds array the summary and rounds cannot read without, is dropped rather
than rendered. The cap runs on read as well as write for the same reason: what
is stored cannot be trusted to have been capped when it was written.

Timestamps prefer the frame's `ts` (server epoch-ms) and fall back to receipt
time. Either way it is display only; nothing is judged from it.

## The machine, and what it cost the server

The change is one state, one event and four edges: `lobby + history → history`,
`history + mode → lobby` (the same shape as the tower's pair, so leaving runs
the lobby's entry), plus `waiting` and `matched`, because a frame saying this
client is queued or paired is a live match and wins over the screen it
interrupts, exactly as it does from the lobby. There is no `stateIdle` for the
reason `result` and `ladder` have none: nothing of a match is live behind the
record, and routing the frame to the lobby would walk the player out of the
screen they opened. A reconnect snapshot crosses it for the same reason
`waiting` and `matched` do.

Nothing else moved server-side: no event, no field, no server-side state, so a
tab open across the deploy that has never seen the button is unaffected.

## Where the reasoning lives

[architecture](../../features/architecture.md#match-history) — the record's
limits, the commit rule, what `matchCtx` earns, the untrusted-storage reading and
the two edges, all written as the feature now stands.

The wire-visible half is in
[protocol](../../features/protocol.md#client-state-machine), which mirrors the
client machine: the `lobby` row's `history*`, the `history` row itself, and the
notes on why it yields and why it has no `stateIdle`.

## How it was verified

`web/app.history.test.cjs` drives the real `app.js` against a stubbed context:
11 tests covering a final result filing a match, a mid-series round not filing
one, a departure filing the match it was made with, a forfeit adding no round,
a `void` round, the drawn summary and rounds, malformed storage dropped rather
than rendered, the cap at fifty, a fighter that has left the roster still reading
as the fighter that was fought, and the teardown/requeue guard. Both mutations
the build order named were checked against it: dropping the `seriesOver !== false`
guard fails four tests, and dropping the shape check makes the render throw on
garbage. `web/machine.test.cjs` pins the four edges and the absent `stateIdle`;
`web/kxp.test.cjs` pins `whenLabel`. `npm run unit` 180/180.

What this host cannot check is what it cannot check for any client change:
rendering, CSS and console errors have no coverage here, and the probe suite
observes frames rather than client storage, so `t1`–`t8` see none of this.

## Not in this build

- **Server-side history**, and with it anything across devices or browsers. That
  is a persistence and identity question, and is recorded where it belongs — the
  blast radius of [player-identity](../../issues/player-identity.md).
- **Ranking, and any aggregate over the record.** Deliberate, above.
- **Clearing or editing the record from the UI.** The site's own storage controls
  are the only ones it has; a control that rewrites history would be a second
  writer to the same array.
