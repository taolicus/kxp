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
clobber a newer phase. The engine never prints debug state (no
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

## Matchmaking

A single global FIFO queue pairs players under the hub mutex. Anonymous
clients receive server-issued random IDs on first SSE connection. Every match
runs a ready handshake between "matched" and the countdown: no countdown may
start until every human side has `POST`ed `/ready` (re-sent every 2s while
matched). The gate is a bitmask over the non-bot sides, so a CPU match waits on
its one human and a PvP match waits on both. If a match never acks — timeout or
disconnect — the pending match is cancelled and the survivor(s) re-queued.

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

## Pure game engine

`round.go`'s `match` doesn't touch `Hub`, `Client`, or SSE. Each side is a
neutral `matchParty` (emit callback + move/left channels + name/character); the
hub wires the engine's `finish`/`requeue` callbacks back to real clients when
it builds a match, so the whole lifecycle, timing, and resolve logic is
testable and reusable without a hub or a wire.

## Testing

- `go test ./...` runs the Go suite: HTTP/SSE integration
  tests for the full CPU and PvP match flows, concurrent-move submissions,
  mid-match disconnects, and endpoint validation, alongside the unit tests.
- Client and harness tests run under `npm run unit`, which globs
  `web/*.test.cjs` and `tools/lib/*.test.mjs`: client pure logic (the PUN-window
  plan, stats, result lines), the client state machine, and the two files that
  run the real `app.js` against a stubbed context — the countdown paint path and
  the snapshot reconciler that decides where a reconnecting client lands. Invoke
  the script rather than the individual files — the set is a glob, and those two
  are the ones that close the gap probes cannot.
- `web/appHarness.cjs` is shared by both client-behaviour tests rather than copied
  into each. It holds the stubbed clock, the hand-fired timer queue and the
  recording state machine — the seam that makes a second such test cost almost
  nothing, since [stall-watchdog](../tasks/open/stall-watchdog.md) needs no new
  infrastructure. A harness duplicated per test file is a second copy that drifts,
  which is the failure the registers in [docs/register.md](../register.md) were
  reorganised to remove. Sharing it also exposed that the countdown dedupe case had
  been asserting nothing: delivered in a single tick, removing the `plannedShootAt`
  guard re-planned to an identical schedule, so the test passed either way. Its
  frames are now staggered as the server sends them, and the guard is caught.
  Landed in `54a1801`.
- `go test -race` is not supported on the device this is developed on (arm64
  Android); see [automated-test-workflow](../tasks/closed/automated-test-workflow.md)
  if you add CI.