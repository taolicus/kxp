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

The server records `shootAt = time.Now()` when the shoot phase begins. Reaction
time is calculated as `arrival.Sub(shootAt)` where `arrival` is `time.Now()`
captured at POST receipt. Picks outside the shoot window (its length is
server-controlled — see the `windowMs` field in the `shoot` event) are rejected
with `400`; failing to pick within it is a timeout loss. `handleMove`'s
phase/deadline check is best-effort and races the deadline timer; a move
accepted there is never silently dropped — `drainPending` counts anything
buffered before the deadline, and a straggler is drained at `finishMatch` (it
can only lose an already-closed round).

Displayed reaction times use the client's own click timestamps when provided
(network-neutral); win/loss remains server-authoritative on arrival time. The
client estimates phone/server clock skew from the `now` field of the
`connected` snapshot so a skewed clock never shrinks the local PUN window.

Planned (Protocol rework, see the roadmap): `shootAt` is pre-announced at
countdown start and the run loop sleeps to the announced instant instead of
minting the deadline on the `shoot` frame; the client then schedules KA/CHI/PUN
against the plan, so a stalled or dropped `shoot` frame no longer destroys the
window. Per-frame `ts` makes delivery lag vs clock skew measurable; a per-stream
seq with reconnect replay and a `/ping` probe follow in later slices.

## Matchmaking

A single global FIFO queue pairs players under the hub mutex. Anonymous
clients receive server-issued random IDs on first SSE connection. A two-player
(PvP) match runs a ready handshake between "matched" and the countdown: neither
countdown may start until both clients have `POST`ed `/ready` (re-sent every 2s
while matched). If a pair never acks — timeout or disconnect — the pending
match is cancelled and the survivor(s) re-queued. CPU matches skip the
handshake entirely.

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
- Client pure logic (the PUN-window plan, stats, and result lines) is tested
  with `node --test web/kxp.test.cjs`; the client state machine with
  `node --test web/machine.test.cjs`.
- `go test -race` is not supported on the device this is developed on (arm64
  Android); see the Roadmap note under "Automated test workflow" if you add CI.