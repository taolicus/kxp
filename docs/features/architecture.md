# Architecture

How KACHIPUN TOURNAMENT works internally. The wire contract (events,
endpoints, and the client state table) is in [protocol.md](protocol.md); the
match background assets in [backgrounds.md](backgrounds.md).

The server is a single Go binary with zero external dependencies. It serves an
embedded web UI, uses SSE for server→client push and plain JSON POSTs for
player→server actions. All game rules are enforced server-side — the browser is
a renderer only.

## Game state machine

Matches progress through four phases: `idle` → `countdown` → `shoot` (PUN) →
`done`, tracked via an `atomic.Int32` on the `match` struct. Every phase change
goes through `advance(from, to)`, which rejects illegal edges (see
`allowedPhaseEdge`) and uses `CompareAndSwap` so a stale goroutine can never
clobber a newer phase. A match that is still in a series goes back from `done`
to `countdown` for the next round — the only edge out of `done`, and allowed
only from there, so a goroutine stranded in `shoot` cannot restart a round that
has already been judged. The engine never prints debug state (no
`stateDebug`-style diagnostics); observability is the structured `log` in
`server.go`.

## Timing model

The server fixes the round deadline when the countdown begins: it stores
`shootAt = now + 2·countStep` and the run loop sleeps to the announced slots
(first `countdown` frame at S−2s, `CHI` at S−1s, then `shoot` at S). `shootAt`
is an `atomic.Pointer[time.Time]` because reconnect snapshots read it during the
countdown. It is held as a `time.Time` rather than epoch-ns so it keeps its
**monotonic reading**: every judgement below compares it against a `time.Now()`
that has one, and `Sub` silently drops to wall-clock arithmetic when either
operand lacks it, which would mis-time the round by the size of any mid-round
clock step (NTP resync, network change). The wire value is derived from the same
instant via `UnixMilli`. This is not a stylistic choice: storing the deadline as
epoch-ns and rebuilding it with `time.Unix` gives an instant with no monotonic
reading, and a clock step mid-round — NTP resync, a network change — would then
mis-time arrival timing, the KA/CHI/PUN sleeps, and the `too late` cutoff by
exactly the size of the step. That defect surfaced as a flake before it was
understood: a test whose own wall time was 1.21s reported a move as 13.3s late,
and the two numbers could not both be right. A clock step cannot be injected, so
the guard is structural — the stored deadline must still render with a trailing
`m=+` — and that guard was checked to fail against the old wall-only form.
Landed in `516c03c`.

Reaction time is `arrival.Sub(shootAt)`, where
`arrival` is `time.Now()` captured at POST receipt. Picks outside the shoot window
(its
length is server-controlled — see the `windowMs` field in the `countdown`/
`shoot` frames) are rejected with `400`; failing to pick within it is a timeout
loss. `handleMove` samples the clock once, so its late-bound check and the
arrival stamp it writes cannot disagree; a move accepted there is never silently
dropped — `drainPending` counts anything buffered before the deadline fired, and
a straggler is drained at `finishMatch` (it can only lose an already-closed
round).

**Both ends of the window are authoritative.** `resolve` judges each arrival
against the whole announced window, `[shootAt, deadline]`, rather than relying on
`handleMove` having checked correctly. That check is explicitly best-effort — it
races the deadline timer — so a pick submitted in the final sliver of the window
can pass it and be stamped past the deadline, and `drainPending` counts it as an
on-time tap. Judging `>= shootAt` alone let exactly such a pick **win the round**
on a move the server would have rejected with `400 too late` a moment later. A
pick stamped at the instant the window closes is not *after* it and still counts:
the client renders the window as closing at that same instant, so rejecting it
would take the boundary away from a player who was inside it.

**`late` is deliberately not `timeout`.** Connectivity-safe scoring keys a
no-contest on the `timeout` note, and keeps `early` out of that rule because an
early pick is a deliberate act that stays a full loss. A late pick is the same
kind of act, so it gets its own note — folding it into `timeout` would let
[connectivity-safe-scoring](../tasks/open/connectivity-safe-scoring.md) convert
a full loss into a draw-scored no-contest without anyone deciding to. Landed in
`482fb72`.

Displayed reaction times use the client's own click timestamps when provided
(network-neutral); win/loss remains server-authoritative on arrival time. The
client estimates phone/server clock skew from the `now` field of the
`connected` snapshot so a skewed clock never shrinks the local PUN window. That
correction is signed, and the rejoin decision it feeds is a boundary: the window
is playable up to and including `shootAt + windowMs`, judged on server time. Both
directions are pinned in `web/app.reconnect.test.cjs`, together with the whole
snapshot routing table — a reconnected client that judged the window on its own
clock rejoins a window the server has already closed and loses a PUN it was owed,
which no probe here can observe.

The client schedules KA/CHI/PUN against the announced plan, so a stalled or
dropped `shoot` frame no longer destroys the window; every timed frame carries
a server `ts` (epoch-ms) making delivery lag vs clock skew measurable
(protocol v1.1, landed). The residual recovery and weak-link symptoms it did
not remove are recorded in [docs/issues/](../issues/) — in particular
[reconnect-loss](../issues/reconnect-loss.md) and
[window-shrink](../issues/window-shrink.md), each of which carries its own
prospective fix, with the causes still unconfirmed.

## A match is a series of rounds

A match is played as a series when it has something to play towards: first to
`defaultSeriesTarget` (3) decisive round wins — or the length the lobby asked
for, which can also be a single round — a draw replayed as a fresh round, and a
`void` round ([connectivity-safe
scoring](../tasks/open/connectivity-safe-scoring.md)) counted as a round win for
the opponent — a dropped connection costs a round, not the match.
`seriesMatch()` derives the question from the sides and the length rather than
a flag: a CPU opponent is always a series, and an online match is one whenever
`drawEnds` is false — any length above one round, or a one-round match whose
draws were switched to replay. `run()` opens the ready handshake once per
match, then loops `playRound()`; `playRound()` begins the round, plays it, and
hands it to `judge()`, which returns whether the series continues. For an
online series, `judge()` also arms `betweenRounds` before the result frame goes
out, and `run()` opens the same handshake again between rounds: that gate is
where a player who walked away between rounds is found, and it is the series'
only exit — a gate that fails there forfeits the series to whoever came back
rather than requeueing anybody
([protocol](protocol.md#cancelled-handshakes)). A bot's rounds never pass
through it, because its client is the human's own screen, already up.

**The lobby's default is one round, and its choice is remembered.** A player who
never touches the toggle gets one round, and a player who picked first-to-three
and comes back after a reload finds it still picked. The control offers two
modes — one round (a 1-off: a drawn round ends it) and first to three — and the
choice is a *(length, rule)* pair: `kxp-cpu-length` holds the number it always
did, and `kxp-cpu-draw-ends` (`"true"`/`"false"`) the rule the button carried.
The pair outlives the third segment that made it necessary: a first-to-1 shares
a length of one with a 1-off on the wire — the ladder's floor is exactly that —
so the client keeps posting the rule rather than leaving the same number to be
read two ways. Nothing is marked selected in the markup for that control: the
selection is decided once the roster that frames the lobby has arrived, so a
saved choice is the one lit from the first paint rather than arriving as a flash
of the default that swaps out. The stored pair is read back as untrusted input
the way `kxp-arcade` is: only a choice the control still offers is honoured, so
a store left by the old three-segment control — which carried first-to-1 — has
no button to light and falls back to the first option, as a hand-edited value
would. A store without the rule key predates the split, so it restores on length
alone (1 → "1 round", 3 → "First to 3"), the one reading that keeps an old
length's meaning unchanged. Changing the mode discards any saved arcade run,
because a floor is fought at the length its run started at, and a control the run
no longer matches would offer a ladder the player cannot fight at what it shows.

**A match the client asked to end on a draw is over whatever that round was.** A
draw is worth nothing to either side and replays — but replaying it means playing
a second round, which is the series a player declined by choosing one round. So
`judge()` ends the match on the draw when `drawEnds` is true, and the result
frame carries `seriesOver: true` like any other final result, which is what makes
the client offer "Play Again". The field defaults at construction to
`roundsTarget <= 1`, which is the rule one round always had: a single round,
whose result is final whatever it came to. Scoped to the field rather than the
mode, because the default is a statement about the number of rounds there are,
not about who is playing — and the arcade ladder is the one caller with a
different answer, posting `drawEnds: false` on every floor so a drawn round
replays rather than deciding one. The lobby asks per button too: "1 round" posts
`true` and "First to 3" posts `false`, so the field is what the player asked for
rather than something inferred from the count. A first-to-1 is no longer a lobby
segment, but the field remains what carries it — the arcade posts it on every
floor, so a drawn round there replays whatever the control is showing.

**The target is a constructor argument, not a constant.** `newMatch(id,
roundsTarget)` takes the length, because the lobby offers a one-round CPU match
alongside the default and a target fixed at construction would have to be
overwritten afterwards — on a field documented as belonging to `run`'s own
goroutine. The hub decides what it will accept (`seriesOffer`, a closed set
of 1 and 3, shared by `/cpu` and `/queue`); the engine takes what it is handed
and never validates a request it does not parse.

**A target goes on the wire only where a series exists.** `seriesFields()` adds
`roundsTarget`, and `drawEnds` beside it, to `matched` and to every `result`,
and only when `seriesMatch()` is true. On `matched` the target is what lets the
client draw the scoreboard before round one rather than after it — the width of
the pip row has to come from the server, or the client ends up holding a copy of
the rules. `drawEnds` rides along because the two together are the mode: a
first-to-1 floor and a 1-off match both have a target of 1, and only the field
tells them apart — so a rule that ships in the engine belongs on the wire, where
the client reads it, rather than in the client's head. A 1-off is not always
absent, either: a CPU opponent is always a series by `seriesMatch()`, so a bot
1-off carries `{roundsTarget: 1, drawEnds: true}`, while an online 1-off carries
neither field — and the client's inference, an absent rule at a target of one is
1-off, renders both the same quiet way. Only a match that can span rounds draws
pips: a target above one, or a target of one whose draws replay. Sending `3` for
a one-round game instead would put a three-pip row over it and promise rounds
that never arrive.

**The series bookkeeping lives in `judge()`, and the result is announced after
it.** The tally is updated, `seriesOver` is decided, and only then does
`announce()` build the frame — so `youRoundWins`/`oppRoundWins` on the wire are the
score *after* the round that frame reports. Announcing first and accounting after
would put the score a round behind, which reads on screen as a stale scoreboard
and cannot be fixed client-side without the client re-deriving the rules.

**`seriesBreak` is a pause for the player, not for the protocol.** Three seconds
between rounds so the result panel, the moves and the score are readable before
the next countdown repaints over them. It is a package var purely so tests do not
have to wait it out.

**A round starts from nothing and closes completely.** `beginRound()` clears the
announced deadline and both sides' previous picks before the countdown restarts.
`closeRound()` is the other end: the shoot loop stops reading when the window
closes, so a pick accepted before the deadline can still be buffered when the
result goes out, and the *next* round's loop would take it as that round's pick —
judged against a deadline its arrival predates, surfacing as an `early` loss in a
round whose window it was never part of. `discardStragglers()` drops them the
moment the round is judged, which is the rule `drainPending` already states and
could not enforce while a match played one round.

It runs after the judgement rather than at the start of the next round because
the engine does not pre-filter what it receives: a pick that arrived before its
round's window opened is judged `early` and loses, and discarding it up front
would silently convert that loss into a timeout `void`. Both directions are
pinned — `TestAJudgedRoundDiscardsPicksStillBuffered` and
`TestAPickBeforeTheWindowIsJudgedEarlyNotDiscarded`.

The loop is pinned where it can be: `series_test.go` drives `judge()` directly to
check the tally, the draw, the target and the void accounting without waiting on
the clock, and the CPU/PvP tests play real rounds end to end. The integration
tests assert the wire tally as a running sum across a whole series, and that a
CPU match does not stop after one round.

## The arcade ladder

The ladder is a client-side progression over ordinary CPU matches: the floors are
the roster from `GET /characters`, shuffled once per run, with the player's own
character always last as the mirror match, and every floor is the stock bot. The
server holds no ladder — it is told which fighter to send out via
`POST /cpu`'s `opponentCharacter` and judges every round as it does any other
match, which is what keeps the rules server-side while the *route through* the
ladder is the player's own business.

Because the order is random, progress is a position *in that order*, so the order
is persisted alongside the floor (`kxp-arcade` in `localStorage`). Three decisions
follow from that, and each has an alternative that was rejected:

- **A loss ends the run.** A decided loss discards the ladder, and the next entry
  draws a fresh one. The arcade original climbs the same ladder again; that is not
  kept, because a run the player has been beaten out of is one they are no longer
  on, and holding onto it only leaves stale progress to resume.
- **Changing the lobby's mode ends the run.** The run is fought at the length it
  was started at, so picking a different mode discards it rather than carrying a
  floor into a control that no longer matches it. A re-tap of the mode already
  showing is not a change of mind and leaves the run alone.
- **A saved order is repaired against the current roster, not trusted and not
  discarded.** Stored fighters still on the roster keep their positions, roster
  fighters the run never mentioned are appended ahead of the mirror, removed ones
  take their floors with them, and the mirror is put last. Discarding the order
  would silently drop a run in progress to the bottom; trusting it would point a
  floor at a fighter that no longer exists.
- **A run whose fighters have all left the roster is a first run, not a repaired
  one.** Repairing it would return the roster in server order — the one thing the
  draw exists to avoid, since every first run would be identical and start with
  the same fighter.

What is in `localStorage` is untrusted input: it is writable by hand and outlives
the code that wrote it, so a saved run is parsed defensively and anything that is
not a usable order draws a fresh ladder.

Progress moves on the match's **final** result only — `seriesOver` — never on a
mid-series round, which is the whole reason the series fields exist. A win climbs
one floor; a loss ends the run and discards the ladder. A drawn floor is neither:
every floor's request says its drawers replay (`drawEnds: false`), so a draw
replays instead of reaching a result — and were one to arrive anyway, the run would
stay where it was rather than misreading a round that decided nothing as one it
lost.

Clearing the mirror is a **state**, not a position. The run records `cleared`
rather than leaving the floor wrapping to zero, because a run sitting on floor one
is a run in progress, and the entry would invite the player to resume a ladder they
had already beaten. A cleared run draws a new order on the next request, the way a
discarded one does — the redraw is shared by the result screen's "New Arcade Mode"
and the lobby's entry, so neither can leave a player with nothing to do.

The result button stops being "Play Again" for a ladder match, because it is not
the same match: it is a different fighter. It says which of the two things comes
next — the next floor, or a new ladder after a loss or a completion — and it fights
the run's own length, captured when the mode was entered rather than re-read from
the lobby, so a floor is always the length its run was started at.

Server-side persistence is deferred to
[player identity](../issues/player-identity.md); a per-tab localStorage ladder
means two browsers each climb their own, which is the visible consequence of that
debt and the reason it is recorded rather than forgotten.

### The tower is the run's own screen, not a decoration on the result

A won floor does not drop straight into the next match, and a run does not start
in one either. After a floor the result screen hands over to the tower, and when
the mode is entered the lobby does — the whole order, floor one at the bottom,
the player standing on the floor the run moved to, beside the fighter that floor
holds, with the fight started from the tower's own button. Three decisions are in
that:

- **The climb waits for the player.** Auto-advancing after the animation was
  considered and rejected: it puts a match on screen underneath the one moment the
  ladder has to say something, and it takes the timing of the transition away from
  whoever has the slowest connection. A tap costs one press and puts the animation
  somewhere the player is actually looking, which a flash over a result they are
  still reading is not.
- **The markup is in match order and CSS lays it out bottom-up.** The rows are the
  order the floors are fought, so "up" is the floor's own number rather than a row
  index the renderer has to reason about in reverse — and the hop distance is the
  row height, so the animation cannot drift out of step with the layout. The client
  places the player on the final floor and the keyframe carries them in: no pixel
  offsets are computed anywhere in `app.js`.
- **The whole order is drawn, not a window onto it.** A ladder showing only the
  next few floors is a list. How far is left is the thing a climb is for.

A cleared run stands at the **top** of the tower. Its floor is reset to zero so the
entry treats it as a completed run rather than one to resume, and the tower is the one
place that reset is not what happened — drawing it as "back at the bottom" would end
the run the player just won by dumping them at its first floor.

What a screen shows is saved before it is drawn. A first run draws its order on the
way in — only then, because the draw depends on the fighter the picker just chose —
and is stored in the same move, so a reload mid-tower resumes the same ladder
rather than a new one. A *cleared* run is the exception that explains the rule: it
enters as the completed run, and the fresh order for its restart is drawn by the
request, which keeps the one redraw in one place and leaves a reload mid-tower on
the ladder it shows.

The tower is entered from the result screen after a decided floor and from the
lobby when the mode begins — so on one side a match has just ended and on the other
none has started, and in neither case is there a live match to reconcile. That is
why the server's trailing `state idle` is ignored there rather than routed to the
lobby like everywhere else, and why the machine gives `ladder` no `stateIdle` edge
to take: honouring it would put a player standing on their own ladder back in the
menu with the climb half played. All of it is pinned in `app.arcade.test.cjs` — the
entry drawing and saving the run it shows, the rows in ladder order, the climb up
after a win, a new run opening at the bottom after a loss, the completed run at the
top, a second visit finding its button armed, and the leave that returns to a lobby
resuming the same floor.

## Match history

The lobby's "Match History" opens a `#history` view: one `<details>` per match
this browser finished, newest first, expandable to the rounds it was made of. The
record is the client's own — `kxp-history` in `localStorage`, beside `kxp-stats`
and `kxp-arcade`, capped at 50 — and it is display-only: nothing is judged from
it, and clearing the site clears it.

That limit is deliberate rather than a first step. The server keeps no history and
has no key to keep one under: no persistence surface in this repo and no identity
to key one to, so a server-side record would be a per-tab copy of the same thing
with a round trip attached. It is therefore not a leaderboard and is not shaped
like one — ranking is what [leaderboard](../tasks/open/leaderboard.md) stays gated
on [player identity](../issues/player-identity.md) for, and this record needs
neither, which is why it ships ungated. Its own standing is written beside it: a
per-browser record means two browsers each keep theirs.

Four things make it an honest record of what it saw:

- **A match is filed when it is decided, not when a round is.** Rounds are
  appended to a pending list as they resolve, and the match is committed by the
  frame that ends the series — `seriesOver !== false`, the same rule the
  [arcade ladder](#the-arcade-ladder) advances on and the result screen draws its
  button from, so history, the ladder and the button agree on what "decided"
  means, and a server predating the field records rather than leaving the match
  unrecorded. The tally on the entry is the frame's own scoreboard read, after
  the round that frame reports (see
  [A match is a series of rounds](#a-match-is-a-series-of-rounds)), so the
  summary line never has to add one up.
- **A tab closed mid-series leaves an uncommitted pending list**, which is an
  unfinished match — not part of a record of finished ones, and not a loss
  either. Nothing claims the match went the other way.
- **`matchCtx` is what a deciding frame does not carry.** Captured on `matched`,
  it holds the opponent, the length and the stage. An opponent's departure never
  carries the stage at all; the plain form of one — a departure before anything
  was scored — carries no series fields either (only identity, which the wire
  grew later); and a forfeited series carries its tally but no round. The context
  fills those gaps and makes the record independent of which of the two departure
  shapes arrived, while the frame's own fields win wherever they exist.
- **`localStorage` is untrusted input**, for the reason the ladder treats it that
  way: it is writable by hand and outlives the code that wrote it, so every entry
  is shape-checked on the way in — not an object, an unknown outcome or mode, a
  missing timestamp or rounds array, and a round that names neither a number nor
  an outcome is dropped rather than drawn. The check runs on read and the cap
  runs on the way in as well as the way out, because what is stored cannot be
  trusted to have been capped when it was written.

A frame that names no round — the two departure forms — is a row only when nothing
else is recorded: a match that opened and closed on a departure is still a match
worth showing, while a forfeited series must not grow a round nobody won. Round
one is what starts a new pending list, since it is the one thing on a frame that
says *which* match it belongs to for a client whose server restarted underneath it.

The view is reached by two edges — `lobby + history → history` and
`history + mode → lobby`, the same shape as the tower's own pair — plus `waiting`
and `matched`, because a frame saying this client is queued or paired is a live
match and wins over the screen it interrupts, exactly as it does from the lobby.
There is no `stateIdle` edge for the reason `result` and `ladder` have none: the
tower subsection above argues it, and it applies here for the same two reasons —
nothing of a match is live behind the screen, and honouring the frame would walk
the player out of the record they opened. A reconnect snapshot does cross it, for
the reason `waiting` and `matched` do. There is no wire change: no new event type,
no field, so a tab open across the deploy that has never seen the button is
unaffected.

It is pinned in `web/app.history.test.cjs`, which drives the real `app.js`
against a stubbed context: a final result files a match, a mid-series round does
not, a departure files the match it was made with and a forfeit adds no round to
it, malformed storage is dropped rather than rendered, and the cap holds at
fifty. Rendering itself — the rows, the expansion, the styling — has no coverage
on this host, and the probe suite observes frames rather than client storage, so
`t1`–`t8` see none of it either.

## Matchmaking

A single global FIFO queue pairs players under the hub mutex, and it pairs only
players waiting for the *same* match: each queue entry carries its
`roundsTarget` and `drawEnds`, and the scan finds the first pair in queue order
that agrees on both. A waiter whose length nobody else wants keeps its seat and
its place rather than being bounced to the back or paired into a match only one
of them asked for, and a side handed back by a cancelled handshake re-enters
with the length it was playing — it is halfway through a series and must not
come back as a one-off. Anonymous clients receive server-issued random IDs on
first SSE connection. Every match runs a ready handshake between "matched" and
the countdown: no countdown may start until every human side has `POST`ed
`/ready` (re-sent every 2s while matched). The gate is a bitmask over the
non-bot sides, so a CPU match waits on its one human and a PvP match waits on
both, and an online series waits on both again between every pair of rounds. If
the *opening* handshake never acks — timeout or disconnect — the pending match
is cancelled and the survivor(s) re-queued; a gate failed *between rounds*
forfeits instead, because there is a tally to stand on
([protocol](protocol.md#cancelled-handshakes)).

**The handshake is verified buffer, not a fixed sleep.** A fixed 2s `Ready?` step
ahead of KA was considered and rejected: the client does all of its setup in one
shot when the first `countdown` arrives (`planRound` → arm `punTimer`), which is
microseconds, so there is nothing incremental to give a slow client more time
for. It does cost something real — it widens the pre-PUN phase from ~3.2s to
~5.2s, and that phase is precisely the window in which a drop loses the round
outright ([drop-loss](../issues/drop-loss.md)). That is buying a hypothetical
benefit with a certain 67% increase in drop exposure. The handshake gives the
same buffer *verified* rather than hoped-for: the client acks from the end of its
`matched` handler, so a slow client waits as long as it needs and a fast one
pays nothing. Landed in `32a3b02`.

**The client-side gate has two conditions, and their order is load-bearing.** The
ack waits for the announced background to decode *and* for a presented frame, in
that order — see [backgrounds](backgrounds.md#selection). The order is the whole
point: `requestAnimationFrame` fires on the next paint of whatever is on screen, so
arming the ack before the image resolved would be waiting for a frame of the queue
view rather than of the match screen, and the countdown could start with the fight
not yet drawn. A background that fails to load still acknowledges, or the
handshake timeout would cancel the match and cost the player the round over a
background.

The cost it does accept is a new failure mode: a CPU match whose human never acks
is cancelled and re-queued after 8s, where before it could not happen. The 2s
ack re-post plus the `pending` snapshot flag — which routes a reconnecting client
back through `matched` and re-arms its acks — cover the realistic cases.

**A challenge link is a scoped queue that lives until its match ends.**
`POST /challenge` binds a token to its creator; `POST /join` pairs the first
claimant through the same `makeMatch`/`startMatchLocked` path the queue uses,
creator at slot 0 and claimant at slot 1. The token is consumed when the *match*
ends, not when it is paired: while the match is live a second opener is told
`409 challenge in play`, and only a join after termination finds `404 challenge
gone`. `finishMatch` is the one hook, because every termination — a decided
round, a `void`, an opponent-left, a ready timeout or abandon — reaches it
through `m.finish`, and it drops the entry whose match is this one. A challenge
match's `requeue` returns false, so the survivor of a cancelled handshake goes to
the lobby rather than the global queue: the link named the opponent, and there is
nobody to pair with — the same branch a CPU match takes. The endpoints landed in
`8e59608`; consuming at termination, rather than at `/join`, is what keeps the
live/in-play distinction and is pinned by `challenge_test.go`.

## SSE lifecycle

Connections are guarded by a `connID` freshness check so a newer connection
survives an overlapping reconnection. A 20-second keepalive comment frame
prevents idle-proxy disconnection. Disconnect cancels the client's `alive`
context, which triggers match abandonment and notifies the opponent. If a
client's event backlog ever overflows its send buffer, the server logs the
dropped push (`send backlog full`) instead of dropping it silently. The client
arms a stall watchdog while a round is live and, if no result arrives within a
few seconds, forces a reconnect so the `connected` snapshot reconciles it back
out. Snapshots for a finished (`done`) or already-expired (`shoot`) match route
straight to the lobby rather than a dead end.

**The watchdog is governed by `GAME_STATES` on both sides.** It fires in
`countdown`, `shoot` and `locked`, and disarms on the entries that leave a round
(`lobby`, `waiting`, `matched`, `result`, `ladder`). `locked` is the load-bearing
one: a round resolves locally into `locked` a couple of seconds into the PUN
window and waits there for the result frame, so a lost result is a stall *in
`locked`* — and a fire check that only knew `shoot` and `countdown` never fired
for the case it exists to rescue. `countdown` is live too, because a
`snapshot:countdown` can route an armed round back into it, so it no longer
disarms. The result screen's disarm is the complementary half: it is what keeps
a stale heartbeat from a previous round off the next one.

**The reconciler is pinned by test, because nothing else can observe it.** The
`connected` handler decides which of five states a reconnected client lands in,
and it is the only place a stalled link is recovered from. `go test` does not run
client code, the `kxp.js` tests exercise the pure schedule helpers away from
`app.js`, and probes `t1`–`t8` assert frames arriving on the wire rather than
what the browser does with them — so the entire recovery path was invisible until
`web/app.reconnect.test.cjs` drove the real `app.js` against a stubbed context.
The rejoin case is the substantive one, since it judges the PUN window on *server*
time ([Timing model](#timing-model)): a phone whose own clock reads headroom on a
window the server has already closed loses a PUN it was owed, and because the skew
correction is signed, both directions and the `shootAt + windowMs` boundary itself
are asserted — one millisecond of dead window is all the difference `>` versus
`>=` would make, and nothing else here would notice it. Landed in `54a1801`.

**Match teardown is per-side and conditional.** When a handshake is abandoned,
`readyTimeout`/`readyAbandon` re-queue both sides and `m.requeue` calls
`tryMatch`, which can re-pair the survivor into a *new* match before the
abandoned match's `finishMatch` runs. Sending `state {state:"idle"}` to every
side of the old match would therefore show the survivor `matched` (new match)
and then `state` (stale teardown) — in either order, since both frames land
within the same millisecond. The client reads that trailing `state` as a
`stateIdle` edge out of `matched` and drops to the lobby while the server still
holds it in a live match. So only a side still in *this* match is told to go idle.
That decision is taken under `h.mu`, because `Client.match` is plain state and an
unlocked read would be a data race — and `-race` cannot run on this platform
(see [environment](../development/environment.md)). `drainMoves` stays
unconditional: that channel is the client's own, and a re-paired client must not
open its new round on the old round's buffered pick.

The live race is order-dependent — roughly 1 run in 7 — so `finish_test.go`
drives the pointer states directly instead: a re-paired side gets no frame, an
already-removed side gets no frame, and the normal path still tells **both**
sides to go idle. That last one is the guard against over-correcting into
stranding every finished client. `t8` still asserts the scenario as a live
canary. Landed in `4143f1b`.

Client joins/leaves are logged with the live count (so an off-by-one "online
now" is diagnosable from the journal), and each stream's writes carry a short
rolling deadline atop TCP keepalive so a vanished device stops counting as
online about a minute after the drop instead of lingering as a half-open
connection.

If a reverse proxy fronts the server, streaming must not be buffered: the
server always sends `X-Accel-Buffering: no`, and the proxy should set
`proxy_buffering off` / `proxy_cache off` for `/events`, otherwise the whole
countdown arrives in a single blob.

## Request limiting

The six state-mutating POST endpoints (`queue`, `cancel`, `cpu`, `ready`,
`move`, `character`) sit behind a per-IP token bucket (`ratelimit.go`) keyed on
the peer address in `RemoteAddr`; over-limit requests get `429` with
`Retry-After`. Thresholds (~200-burst, ~120/min sustained) are sized far above
any legitimate session, including best-of-5 series and arcade-ladder chains.
`GET /events` is exempt — it's one long-lived connection, torn down on
disconnect. Keying uses `RemoteAddr` because the server is directly exposed;
if an nginx proxy is ever added in front, key the first `X-Forwarded-For` hop
instead (only trustworthy because nginx overwrites it).

## Resource limits

The hub also caps the state a flood can grow: `getOrCreate` refuses to mint
new clients once `maxClients` are live (`GET /events` answers `503`), `POST
/queue` answers `503` once `maxQueue` players are waiting, and `POST /cpu`
answers `503` once `maxMatches` engines are running. Existing clients are
always re-admitted, so the caps only bound new growth, never legitimate
reconnects. These sit beside the rate limiter: the limiter bounds request
floods, the caps bound the resulting memory/goroutine footprint.

## Operational settings

Every operating value the engine and hub read is settable without a rebuild, so
an install can be recorded and reproduced rather than interpreted against
"whatever this build compiled in". `main.go` binds seven flags to the package
vars themselves — `-shoot-window`, `-ready-timeout`, `-sse-write-deadline`,
`-max-body-bytes`, `-rl-capacity`, `-rl-refill-per-sec`, `-rl-max-entries` —
each defaulting to the shipped value; `-addr` and `-h` complete the set.

A flag is not a second source of truth: it is bound to the same var the code
reads (`flag.DurationVar(&shootWindow, "shoot-window", shootWindow, …)`), so the
default and the runtime value cannot drift, and `main` sets them once before any
goroutine or the hub exists. Environment variables were considered and rejected:
a second input route needs precedence rules or reintroduces the duplicate-source
problem, and this repo already exposes its one runtime choice, `-addr`, as a
flag.

Values that are part of the client contract rather than an operator's knob stay
compiled in: `readyLease` and `readyRecheck` track the client's fixed 2s re-ack
interval, `countStep`/`countdownSlots` are the countdown the client paints from
`COUNTDOWN_SLOTS`, and `maxClients`/`maxQueue`/`maxMatches`/`frameJournalCap`
bound the process's own memory and goroutines. Changing any of those server-side
alone would desynchronise the two ends, or has no operational meaning.

## Pure game engine

`round.go`'s `match` doesn't touch `Hub`, `Client`, or SSE. Each side is a
neutral `matchParty` (emit callback + move/left channels + name/character); the
hub wires the engine's `finish`/`requeue` callbacks back to real clients when
it builds a match, so the whole lifecycle, timing, and resolve logic is
testable and reusable without a hub or a wire.

Three injectable seams keep a CPU match deterministic in a test without a hub:
`now` (the match clock, shared with the readiness lease), `pickMove` (the CPU
opponent's choice, default `randomMove`), and `botThink` (its reaction delay).
`newMatch` sets the shipped defaults and a nil hook falls back to them, so a
struct-literal match still plays; the bot stamps its arrival from the match clock
rather than `time.Now()`, so an injected clock and a zero think time make a round
wholly reproducible. See
[cpu-determinism-hooks](../tasks/closed/cpu-determinism-hooks.md).

## Testing

- `go test ./...` runs the Go suite: HTTP/SSE integration
  tests for the full CPU and PvP match flows, concurrent-move submissions,
  mid-match disconnects, and endpoint validation, alongside the unit tests.
- Client and harness tests run under `npm run unit`, which globs
  `web/*.test.cjs` and `tools/lib/*.test.mjs`: client pure logic (the PUN-window
  plan, stats, result lines), the client state machine, and every
  `web/app.*.test.cjs` — the tests that load `web/appHarness.cjs` and drive the
  real `app.js` against a stubbed context. The countdown paint path and the
  snapshot reconciler that decides where a reconnecting client lands (with, in the
  same file, the stall watchdog that decides whether it reconnects) are the
  examples this description was written around, not the whole set. Invoke the
  script rather than the individual files — the set is a glob, and these are the
  ones that close the gap probes cannot.
- `web/appHarness.cjs` is shared by all of them rather than copied
  into each. It holds the stubbed clock, the hand-fired timer queue and the
  recording state machine — the seam that makes a second such test cost almost
  nothing, since [stall-watchdog](../tasks/closed/stall-watchdog.md) needs no new
  infrastructure. A harness duplicated per test file is a second copy that drifts,
  which is the failure the registers in [docs/register.md](../register.md) were
  reorganised to remove. Sharing it also exposed that the countdown dedupe case had
  been asserting nothing: delivered in a single tick, removing the `plannedShootAt`
  guard re-planned to an identical schedule, so the test passed either way. Its
  frames are now staggered as the server sends them, and the guard is caught.
  Landed in `54a1801`. The guard has since been removed on purpose — repeats
  re-derive the countdown rather than being dropped, which is what lets a bad
  clock reading be corrected; see
  [client-countdown-painter.md](../tasks/closed/client-countdown-painter.md).
- `go test -race` is not supported on the device this is developed on (arm64
  Android); see [automated-test-workflow](../tasks/closed/automated-test-workflow.md)
  if you add CI.