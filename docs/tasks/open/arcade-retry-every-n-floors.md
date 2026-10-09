---
phase: 4
depends-on: []
gated-on: []
---

# Arcade: one retry every N floors cleared

The arcade ladder ends a run on a decided loss (`advanceLadder`, `web/app.js`).
This grants a limited number of continues: clearing floors banks retries, and a
loss spends one to replay the same floor instead of ending the run.

**Client-side only.** The run already lives in `localStorage`
(`kxp-arcade-runs`, one entry per `(length, rule)` pair) and the server holds no
ladder, so the retry follows the run there. No server persistence, no wire
change: a floor is still an ordinary `POST /cpu` naming `opponentCharacter` and
`drawEnds: false`.

## Mechanic

- A run earns one retry per `ARCADE_RETRY_FLOORS` floors **won** (a client
  constant, initial value `2`). The bank is derived, not event-driven:
  `max(0, floor(floorsCleared / ARCADE_RETRY_FLOORS) - retriesSpent)`.
- A decided **loss** with a banked retry does not discard the run.
  `advanceLadder` marks it `lostLast` and the result screen offers **Use Retry**
  in place of **New Arcade Mode**.
- Taking the retry spends one: `postCPU('ladder')` sees `lostLast`, increments
  `retriesSpent`, clears `lostLast`, and fights the same floor. Both routes to
  the replay — the result button and resuming from the lobby after a loss — pass
  through here, so they cannot disagree about the spend.
- A loss with an empty bank discards the run exactly as today, and the next
  entry draws a fresh ladder.
- A **draw** neither earns nor spends: a floor's request replays draws
  (`drawEnds: false`), so a draw never reaches a decided result; the existing
  `retry-floor` path is unchanged.

The run gains `floorsCleared`, `retriesSpent` and `lostLast`. A run stored
before this slice has none, and defaults them to `0`/`0`/`false` — so a run in
progress across the deploy starts with an empty bank and earns from there. It is
not retroactively credited for the floors it has already cleared: those were
played before the rule existed, and crediting them would hand a mid-run player a
retry the moment the client updates.

## Why these choices

- **Spend on replay, not on the offer.** Consuming when the option is presented
  would charge a player who declines and walks away. Tying it to the next
  `postCPU` makes the result button and the lobby resume the same spend.
- **A derived bank, not a reset counter.** `floor(floorsCleared / N)` is
  order-independent and idempotent across a repair, so no "floors since last
  retry" reset event — and no migration of one — is needed.
- **One constant, not a difficulty selector.** The lobby has no difficulty
  control; `floorsPerRetry` starts as `ARCADE_RETRY_FLOORS = 2`. A value per
  difficulty is a later slice of [solo-campaign](solo-campaign.md), not this
  one. The constant is named and used in one place, so that slice changes one
  line.
- **Client-side authority.** The ladder is the client's own progression
  ([architecture](../../features/architecture.md#the-arcade-ladder)); the server
  judges every round and is told each floor's fighter. Retry eligibility is the
  same kind of client state the floor and order already are. Server-side
  authority would need identity and a server-held run, both deferred.

## Required context

- `web/app.js` — the arcade storage and progression: `readArcade` (run shape and
  defaults), `advanceLadder` (the win/loss/draw branches), `postCPU('ladder')`
  (the floor request and the redraw), and `renderResult`'s `ladderNext` labels.
- [architecture](../../features/architecture.md#the-arcade-ladder) — the run
  shape, the repair, the "a loss ends the run" decision this amends.
- [arcade-runs-per-mode](../closed/arcade-runs-per-mode.md) — the per-pair
  storage the run now lives in.

## Affected files

- `web/app.js` — constant, run fields and defaults, earn in `advanceLadder`'s win
  branch, retry/discard split in its loss branch, spend in `postCPU`, and the
  `'retry-loss'` label in `renderResult`.
- `web/app.arcade.test.cjs` — boundaries (`N-1`, exactly `N`, `N+1`), retry then
  loss again, spend on lobby-resume, the no-spend on leaving, and the negative
  case that an empty bank still discards.
- `docs/features/architecture.md` — the arcade section's "A loss ends the run"
  bullet gains the retry exception and the rejected alternatives above.

## Acceptance criteria

- Clearing `N` floors banks a retry; a decided loss with one banked keeps the
  run and offers **Use Retry**.
- The retry is spent exactly once, when the floor is re-fought; leaving to the
  lobby without re-fighting does not spend it.
- A loss with no bank discards the run and the tower opens on a fresh ladder,
  unchanged from today.
- No wire change: the floor request is still `POST /cpu` with
  `opponentCharacter` and `drawEnds: false`.
- Deterministic tests fail against the pre-change `app.js` and pass after, in
  the same commit; the negative direction (empty bank discards) is pinned too.

## Verification

`npm run unit` (the arcade suite plus the whole client) and `npm run links`. No
Go and no shared server state is touched, so the Go gates and `-race` do not
apply; the wire is unchanged, so `t1`–`t8` are not affected. Rendering is
unasserted on both hosts — the result-button label is hand-read — and
`npm run e2e` is laptop-only, as always on the phone.
