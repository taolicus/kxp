---
phase: 3
depends-on: []
gated-on: []
---

# Game-mode architecture

A match can be a sequence of rounds — first to `N` decisive wins, a drawn round
replayed, a `void` round counting as a round win for the opposing side (the
[connectivity-safe-scoring](connectivity-safe-scoring.md) rule) — and for CPU
matches it already is: `run()` loops `playRound()` until `judge()` says the
series is over, and `result` carries `round`, `youRoundWins`, `oppRoundWins`,
`roundsTarget`, `seriesOver`, which is what lets the client scoreboard re-enter
the next countdown instead of ending.

The online half is what does not exist. `POST /queue` carries only an ID, so
every PvP match is one round whatever the lobby's control says; and the ready
handshake runs once per match, which is why a PvP series cannot start yet — two
players in a series with no gate between rounds are two players in a match
neither can leave, the reason recorded on `TestPVPMatchEndsOnItsFirstRound`.
CPU first, online second — the order this task always had, and why its two
halves are one entry rather than two.

Builds on the Protocol rework Task A schedule, which shipped first.

## Why

- The length control posts to `/cpu` and nowhere else. A player who chose
  "First to 3" and pressed Find Match silently got one round: the selector's
  promise stops at the queue.
- [architecture.md](../../features/architecture.md) defers re-opening the
  handshake between rounds as "a wire-visible decision that belongs with the
  series loop, not beside it". This is that decision, and the reason the loop
  stops after one round for PvP.
- The moment two queued players can disagree about length, pairing is a
  decision. It belongs to this task because this task is what makes the
  disagreement possible.

## Decided

- **The queue honors the same length the control offers, and absent means one
  round.** `POST /queue` gains optional `roundsTarget`, validated against the
  same closed set `/cpu` uses (`seriesOffer`, today `{1, 3}`), and optional
  `drawEnds`, decoded exactly as `handleCPU` decodes it (absent → `target <= 1`
  inference; present → honoured). Absent `roundsTarget` means 1 — an older tab
  posting a bare `{ID}`, and every probe, play the match they play today.
  Rejected: a new endpoint or event for queueing with a length (the wire is
  additive or it is wrong); `roundsTarget: 0` as "one round" (collides with
  absent-means-default, already rejected in
  [game-modes](game-modes.md)).

- **Pairing is equal-mode only: `tryMatch` scans the FIFO for the first entry
  whose (target, `drawEnds`) matches, so no player's selection is ever
  overridden.** A mismatch waits; nobody is paired into a length they did not
  ask for. Queue entries carry the mode, and a requeued side re-enters with the
  mode of the match it was already playing — both sides had agreed to it, and
  dropping it would re-pair a first-to-3 survivor into a one-round game. The
  scan is bounded by `maxQueue` (128). Rejected: pair the first two entries and
  let the earlier player's choice win (the second player's control lied — the
  same lie the lobby's persistence slice removed from the CPU control);
  per-length sub-queues (three FIFOs kept consistent through enqueue, dequeue,
  cancel and requeue for no gain at n ≤ 128).

- **Between rounds the ready gate re-opens, and the client re-acks
  automatically — there is no player step.** The server will not start the next
  countdown until every side holds an ack fresher than `readyLease`, which for
  a live client costs one re-post after it presents the round's result; the
  8s `readyTimeout` catches a side that stopped. The client re-arms the same
  two-condition ack (background decoded, frame presented) when it presents a
  *non-final* online result — the presented frame is the result screen, and
  `mode` on the result frame is what distinguishes this from a CPU series,
  whose gate stays once per match. The 3s `seriesBreak` read-pause keeps its
  meaning; the next round needs both, and the two may run concurrently. The
  gate is also the only clean exit from a series: a player who walks away
  stops feeding the lease, and the match ends within 8s with the opponent
  awarded instead of a loop dealing rounds to whoever remains.
  Rejected: a visible inter-round `Ready?` step (the fixed 2s step ahead of KA
  was already rejected for the same reasons — a client has nothing incremental
  to set up, and widening the pre-PUN phase buys a hypothetical at real
  drop exposure; the lease gives the same buffer *verified*); no gate at all
  (it is the recorded decision, and without it a frozen tab is served rounds
  it cannot see while its opponent sits through dead countdown windows);
  re-arming only in `matched` (between rounds the client is on `result`, which
  is exactly where the current loop stops).

- **A gate failure between rounds ends the match; it never requeues a side
  that has played.** With at least one round judged: a disconnect during the
  gate awards the present side a forfeit win; `readyTimeout` awards the side
  that acked; if neither side acked, the match is cancelled and both requeue
  as today, because there is no present side to award. The awarded side's
  terminal frame carries the tally, `seriesOver: true` and an outcome of
  `win`, riding the existing `opponent-left` event with the series fields
  added — the frame a mid-match disconnect already speaks — and the machine
  gains that event's edge from `result`. A reachable non-acker receives the
  same frame with `outcome: loss`. Before round one, today's semantics are
  untouched: timeout requeues both sides, an abandon requeues the survivor.
  Rejected: requeue the survivor mid-series (it discards rounds already
  decided — the pre-match requeue exists precisely because *nothing* was
  decided there, which is what `readyAbandon`'s comment means by "rather than
  awarded any result"); playing the remaining rounds out as voids (the engine
  cannot play a round against a departed side — `m.left()` aborts it — and
  phantom countdowns are worse than one terminal frame); a new `forfeit` event
  type (an event type an old tab drops silently, which the additive-wire rule
  exists to prevent).

- **`seriesMatch()` becomes `return m.sides[1].bot || !m.drawEnds`.** For PvP,
  series-ness is exactly "a drawn round replays", which is what `drawEnds`
  already carries and `judge()` already reads; the `bot` term keeps CPU frames
  announcing their round fields whatever their own `drawEnds`, which the
  existing field assertions pin. The queue must therefore trust `drawEnds`
  (decode as `handleCPU` does, so at target 1 the two modes stay apart).
  Rejected: `roundsTarget > 1` — it holds only until a first-to-1 reaches the
  queue, and a first-to-1 is a target of one that spans rounds, so the line
  would end it after round one; it also encodes "more rounds" where the real
  distinction is "draws replay", since a first-to-1 may legitimately finish in
  one. Rejected: an explicit `series` flag — a second piece of state that can
  disagree with `drawEnds` and the sides, which a derived line cannot do, and
  `seriesMatch`'s own comment already commits the change to one line.

- **Online rematch repeats the match that just finished.** The online branch of
  "Play Again" posts the finished match's `lastTarget` the way the CPU branch
  does, not the control's current position — the same argument that already
  keeps `lastTarget` on the wire for CPU rematches, and `lastTarget` is
  already updated from every result frame.

- **The queue's construction declares the length it plays.** `tryMatch` passes
  the requested target instead of `defaultSeriesTarget` behind a comment
  saying the number is never read; once `seriesMatch` can answer true for PvP,
  that comment is false. Considered as a standalone prep slice before this
  spec existed and rejected: the line is replaced by this task either way, and
  a slice that only changes a value nothing reads buys a second edit.

## Shape

- **`POST /queue`** takes `{ID, roundsTarget?, drawEnds?}`; the response and
  the `waiting` frame are unchanged; an invalid target is rejected the way
  `/cpu` rejects one. Queue entries carry `(roundsTarget, drawEnds)`;
  `tryMatch` scans for the first equal entry; `dequeueLocked`/cancel behave as
  they do today; the requeue closure appends with the match's own mode.
  `cpuSeriesOffer`/`validCPUSeriesTarget` are renamed to names both handlers
  share (`seriesOffer`/`validSeriesTarget`) — behaviour-identical, done here
  so the queue validation does not grow a CPU-prefixed twin.
- **Engine**: the one `seriesMatch` line above; `run()` opens `waitReady`
  between rounds for a non-bot series (the gate and `seriesBreak` before the
  next countdown); `handleReady` answers 200 while a round can still be
  played — including the between-rounds span — and 409 only once the match is
  over; `readyTimeout`/`readyAbandon` branch on whether a round has been
  judged (forfeit vs today's requeue); the forfeit terminal frame carries the
  tally and `seriesOver` through `seriesFields`; the `run()` comment that says
  the handshake is "deliberately not repeated per round" is rewritten to state
  the split it now has (online per round, CPU once per match) and why.
- **Client**: both `post('/queue')` call sites (lobby Find Match, online Play
  Again) send the selected length; a non-final online result re-arms the ack
  loop and a final result or lobby stops it; the state machine gains
  `opponentLeft` from `result`, which renders the forfeit through the existing
  result path (banner from `outcome`, tally and pips from the series fields,
  Play Again from `seriesOver`).

## Build order

1. **Engine and hub** — the predicate line, the queue's mode (decode,
   validation, entries, scan, requeue), the per-round gate, the forfeit
   branches. Tests: a new *first-to-3 PvP* case that must fail against today's
   judge (which forces `seriesOver` after round one for every bot-less match);
   `TestPVPMatchEndsOnItsFirstRound` and the PvP half of
   `TestOnlyASeriesAnnouncesARoundsTarget` re-scoped to construct a one-round
   PvP match (target 1, whose `drawEnds` default is true) — they stay green
   before *and* after, which is their job as the negative direction: no
   fields on a one-round PvP match, and a draw still ends it; a pairing test
   for equal-mode-only and one for the requeued mode; `ready_test.go` gains
   the mid-series forfeit in both directions (disconnect and timeout award the
   present side, no requeue) — these must fail against today's `readyAbandon`,
   which requeues — beside `TestReadyTimeoutRequeuesBoth`, unchanged, pinning
   the pre-match rule; queue-target validation beside
   `TestCPURejectsASeriesLengthItDoesNotOffer`.
2. **Client** — the queue posts, the re-arm, the machine edge. Tests: the
   lobby test that pins *"an online match is not started with a series
   length" **flips*** to assert the selected length rides `/queue` (its
   comment anticipated this — honoured in the right place, which this is);
   a countdown/result test driving the real `app.js` (a non-final online
   result re-arms the ack, a final one stops it); `web/machine.test.cjs` gains
   `opponentLeft` from `result` and keeps `countdown` from `result` as the
   negative direction.
3. **Docs with the code** — each paragraph lands with the slice of code that
   makes it true, not grouped here as a lump: step 1's commit already carries
   the rows and sections the server change turns true (the `/queue` and
   `/ready` rows, the readiness and teardown sections, architecture.md's
   series and matchmaking rewrites), because a doc committed after the claim
   has already shipped is a doc nobody can review against its code. What is
   left for the client slice is the client-owned prose: README's online line;
   game-modes' "Online stays 1-off" bullet,
   which must stop being a present-tense claim the moment the queue honors a
   length. Then `git mv` this file to `tasks/closed/`.
4. **Probes** — no probe posts a length, and absent fields preserve the
   one-round queue path, so `t1`–`t8` are unaffected by design; run `t1`
   first and then the suite when an origin exists.

## Not covered

- The **"Vs CPU:" caption and the control's `aria-label`** — this task makes
  the control drive the queue too, so both become less true; the re-caption
  belongs to game-modes' UI pass, which already owns the same fix for the
  ladder.
- **Selecting first-to-1 online** — the third segment button and its label are
  game-modes' client half; the queue's wire is ready for it via `drawEnds`.
- **Showing the chosen mode on the waiting screen** (UI pass).
- **Per-round gating for CPU matches** — deliberately unchanged: the bot never
  fails to ack, and a departed human already resolves through in-round
  timeouts to an ordinary final result. The client re-arm is mode-gated, so
  adopting it later is one server condition, not a client change.
- **Records and leaderboards** — the remaining half of
  [connectivity-safe-scoring](connectivity-safe-scoring.md), gated on identity
  in a later phase; the queue and series mechanics do not read records.
- **Pairing beyond equal-mode** — ordering or fairness policies across modes
  (priority, rotation) have no requirements yet.

## Notes

- `depends-on` was `[connectivity-safe-scoring]` and is dropped: the part of
  that task this one consumes — a void round counting as a round win — is in
  the engine and in the client's `applyResult` already, and what remains there
  is the leaderboard adoption, which is gated on identity and which no queue,
  gate or series rule reads. The prose reference to it stays above.
- `docs/features/architecture.md`'s current single-round PvP paragraphs and
  the `run()` comment describe what this replaces; they change with the code
  in build step 3, not before.
