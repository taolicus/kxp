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

It is not a leaderboard and must not be shaped like one: ranking needs something
a `localStorage` array cannot give, which is why
[leaderboard](leaderboard.md) stays gated on
[player-identity](../../issues/player-identity.md) and this does not.

## Shape

- **`matchCtx`, set on `matched`**: `opponentName`, `opponentCharacter`,
  `roundsTarget`, `background`. It exists because `opponent-left` carries only
  `{outcome, mode}` — by the time that frame arrives the opponent's fighter is
  no longer in it, and the VS slot never retains it.
- **On every `result`**, append a round record to a pending list: `round`,
  `you`, `opponent`, both notes, both timings, `outcome`, `ts`.
- **Commit when `d.seriesOver !== false`** — the same rule the arcade ladder
  advances on, so history and the ladder agree on what "decided" means, and a
  server predating the field commits rather than hangs. `opponent-left` routes
  into the result handler and commits as a one-round entry, with its opponent
  read from `matchCtx`.
- **A tab closed mid-series** leaves an uncommitted pending list: an unfinished
  match is not recorded. That is the correct reading of a record, not a loss.
- **Storage** is `kxp-history`: an array capped at 50, shape-checked on read the
  way `readArcade` checks a ladder. What is in `localStorage` is writable by
  hand and outlives the code that wrote it, so an entry that is not an object,
  or that is missing a field it is read for, is dropped rather than rendered.
- **Timestamps** prefer the frame's `ts` (server epoch-ms) and fall back to
  receipt time. Either way it is display only; nothing is judged from it.

## UI

A `#history` view off the lobby: one `<details>` per match — a summary line
(outcome, mode, both fighters, series score, when) with the rounds inside it.
The machine change is two edges and no wire change: `lobby + history →
history`, `history + mode → lobby`.

## Build order

1. `matchCtx`, the pending/commit rule, and the storage, with
   `web/app.history.test.cjs` driving the real `app.js` against a stubbed
   context: commits on a final result, does **not** commit mid-series, commits
   on `opponent-left` with the opponent from `matchCtx`, repairs and caps
   malformed storage, records a `void` round. The two mutations to check against
   are dropping the `seriesOver` guard (a mid-series commit) and dropping the
   shape check (garbage rendered as a row).
2. The view, its lobby entry, the two edges, and the styling.
3. Docs with the code: `architecture.md` gains a `## Match history` section
   beside `## The arcade ladder` citing its untrusted-storage paragraph,
   `protocol.md` gains the state-table row, `README.md` the feature, and this
   file moves to `tasks/closed/`.

## Not covered

Rendering and the round expansion have no coverage on this host, and the probe
suite does not observe client storage — so `t1`–`t8` see none of this either.
