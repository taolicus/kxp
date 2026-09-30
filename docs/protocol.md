# KACHIPUN game protocol

Version: 1.1. All payloads are JSON. Numbers are seconds unless stated.
(Timed frames carry `ts`, server epoch-ms at construction. v1.1 shipped the
announced-deadline schedule; the v1.2–v1.3 drafts below are **parked** as
symptom descriptions in docs/issues.md until their cause is confirmed — see
"Rework" near the end.)

The server speaks two things: a single persistent Server-Sent Events (SSE)
stream per client (`GET /events`, pull-only) and plain `POST` endpoints for
player actions. The browser is a dumb renderer — every rule is enforced
server-side.

## Client identity

A first `GET /events` with no `?id=` creates an anonymous client and assigns a
random server ID; the `connected` event carries it. The client keeps using that
ID for POST bodies and reconnects. POSTs whose `id` has never connected are
rejected with `400 not connected`.

## Match lifecycle

Server side a match moves through four atomic phases:

```
idle → countdown → shoot → done
```

`shoot` is the **PUN!** instant: the server records `shootAt` and opens a 2s
window. Any pick is judged by arrival time relative to `shootAt`.

Every match runs a **ready handshake** between "matched" and the countdown: no
countdown may start until every *human* side has `POST`ed `/ready`. Clients
re-send readiness every 2s while matched (self healing on a lost ack), and a
client that reconnects mid-handshake is re-admitted by the `pending` snapshot
flag, which sends it back through `matched` and so re-arms its acks. If a match
never acks — 8s timeout or a disconnect — the pending match is cancelled and the
survivor(s) go back to the queue.

The handshake is a **self-timing buffer, not a fixed sleep**: the client acks
from the end of its `matched` handler, so the countdown cannot begin until it
has finished setting the round up. A slow client waits as long as it needs (up
to the 8s timeout) and a fast one pays nothing. A CPU match gates on its single
human exactly this way; the bot is not a participant and is never waited for.

### Cancelled handshakes

A handshake that does not complete is *cancelled*, never lost: no `result` is
emitted and nothing is scored. The teardown `state` frame says why, so a bounced
player is not left staring at a lobby that silently moved them.

| `reason` | when | `requeued` | player ends up |
| --- | --- | --- | --- |
| `handshake-timeout` | no human acked within 8s | PvP: `true`. CPU: absent | PvP: back in the online queue. CPU: back in the lobby. |
| `opponent-left` | the other side disconnected before the countdown | `true` (survivor only) | back in the online queue |

`requeued` is present and true **only when the server actually put that client
back on the queue**, which is what the client needs in order to keep showing the
Searching view and its Cancel button. Without it the client reads a bare
`state idle` as "back to the lobby" while the server still holds it in the queue —
invisible, with no way to leave. A CPU match's human is deliberately **not**
re-queued: they asked for a CPU round, so they return to the lobby instead of
being dropped into the queue for a human opponent they never requested.

The client shows the reason without blame: the server observes an ack that never
arrived, which is equally consistent with a slow upload, a stalled connection, or
a device that slept, so it can prove the handshake was cancelled but never which
player caused it.

Match duration: `matched` → `READY` (+1s) → `KA` (+1s) → `CHI` (+1s) → `shoot`
(2s window) → `result`. Handshake time precedes the countdown and is
client-dependent.

## Server-sent events

Each frame is `event: <type>` followed by one `data: <json>` then a blank line.
A `: ping` comment is sent every 20s as a keepalive. If a client's send buffer
overflows, the push is logged and dropped; the client recovers via reconnect +
snapshot.

| event | payload | meaning |
| --- | --- | --- |
| `connected` | `{id, state, online, now?, phase?, opponentName?, opponentCharacter?, windowMs?, shootAt?, pending?}` | First frame of every connection. `state` is `idle` / `waiting` / `ingame`; `now` is the server's epoch-ms at send, used by the client to estimate clock skew (`skew = now − Date.now()`); `phase` (`countdown`/`shoot`/`done`) and opponent fields only when `ingame`; `shootAt`+`windowMs` only when `phase=shoot` (epoch-ms); `pending=true` only while a PvP handshake is still open. Used to reconcile on reconnect. |
| `online` | `{count}` | Number of other clients currently connected. |
| `waiting` | `{}` | Entered the queue. |
| `matched` | `{opponentName, opponentCharacter}` | Opponent found; every client should start `POST /ready`. |
| `countdown` | `{n, shootAt, windowMs, ts}` | `n` is `READY`, `KA` or `CHI`. The plan fields are present on every countdown frame — see v1.1 below. |
| `shoot` | `{windowMs, shootAt}` | **PUN!** Window opens. `windowMs` is authoritative (2000); `shootAt` is server clock epoch-ms. |
| `lock` | (none — client timer) | Client closes its own input after `windowMs - elapsed` of the window remains reachable. |
| `result` | see below | Round resolved. |
| `opponent-left` | `{outcome: "win", mode}` | Other player left; counts as a win. |
| `state` | `{state: "idle", reason?, requeued?}` | Match fully finished / queue left; client may return to the lobby. Both extra fields are **additive and server-generated** (never taken from request input) and appear **only** when a ready handshake was cancelled — see "Cancelled handshakes" below. A finished match's teardown stays a bare `{state: "idle"}`, so a client that predates them is unaffected. |

`result` payload:

| field | meaning |
| --- | --- |
| `you`, `opponent` | Moves: `rock`, `paper`, `scissors` (absent on timeout). |
| `outcome` | `win`, `loss`, `draw`; `void` for a no-valid-move timeout (see "Connectivity-safe scoring" below). |
| `yourNote`, `opponentNote` | `early`, `timeout`, or `""`. |
| `youTimingMs`, `opponentTimingMs` | Server-side arrival relative to `shootAt` (nil when not valid / timeout). |
| `youClientMs`, `opponentClientMs` | Client-reported reaction (`clickedAt − sawPunAt`) when present and sane; displayed in preference to the network-inflated `*TimingMs`. |
| `youCharacter`, `opponentCharacter` | Characters chosen for each side. |
| `opponentName` | `CPU` or `Opponent`. |
| `mode` | `online` or `cpu`. |

### Connectivity-safe scoring (planned)

A round that resolves with a valid move on only one side scores `void` for the
no-move side when its note is `timeout`: it never counts as a loss against
that side's record (no win, no streak break) and the UI reports "No contest",
while the opponent still takes the round win. An *early* pick is a deliberate
act and stays a full `loss`. If neither side produces a valid move the round
is a `draw`. `yourNote`/`opponentNote` keep reporting `timeout`/`early`
unchanged.

Decided and scheduled: the engine emits `void` on timeouts, the client
scorebook treats it like a draw, and the leaderboard applies the same rule
server-side (see the roadmap).

## HTTP endpoints

`POST` request bodies always start with the client id; content-type JSON.
`GET /events` is the SSE stream; `GET /characters`, `GET /health`, and
`GET /metrics` are read-only and exempt from rate limiting. Everything else
(including the `POST /report` client error beacon) is rate-limited.

| endpoint | body | responses |
| --- | --- | --- |
| `POST /queue` | `{id}` | `200 {}` — joins the online queue (idempotent). `409 already in a match` while the client holds a live match. |
| `POST /cancel` | `{id}` | `200 {}` — leaves the queue (best effort). |
| `POST /ready` | `{id}` | `200 {}` — advertises readiness for the current match; `400 no active match` if none; `409 ready gate closed` if the match has already left the countdown phase and will send no countdown. Gates CPU and PvP alike. Idempotent while the match is live, so a re-sent ack from a reconnecting client is still accepted — but a `200` is never returned for a match that will not run a countdown, since a client reads it as "hold still, it is coming". |
| `POST /cpu` | `{id}` | `200 {}` — starts a CPU match (also drains/leaves the queue). The match still waits for the client's `/ready` ack before its countdown. `409 already in a match` while the client holds a live match. |
| `POST /move` | `{id, move, sawPunAt?, clickedAt?}` | `200 {}` on acceptance. `400 too early` during countdown, `400 too late` past the deadline, `400 match over` on a finished match, `400 invalid move`, `400 no active match`, `409 move already submitted`, `413 body too large`. `sawPunAt`/`clickedAt` are client epoch-ms used only for display. |
| `POST /character` | `{id, character}` | `200 {}` — picks a fighter; `400 invalid character`. See `GET /characters` for the current roster. |
| `GET /characters` | — | `200 [{id, name, emoji}]` — the full roster; the single source of truth for character data. The client fetches it at startup and no longer bundles its own copy. |
| `GET /health` | — | `200 {status, uptime, online, queue, activeMatches, build}` — liveness/readiness probe. Exempt from rate limiting. `build` is `{sha, modified, source}`: the commit the running binary was built from, whether that build tree had uncommitted changes, and how the identity was obtained (`vcs`, `ldflags`, or `unknown`). `sha` is `"unknown"` when the binary carries no VCS metadata. The probe suite's `t1` compares it against the local HEAD — without it, a green live result cannot be distinguished from a stale binary serving traffic. |
| `GET /metrics` | — | `200 {uptime, online, queue, matches, counts}` where `counts` carries cumulative request/reject/join/leave/drop/rate-limit/beacon streams plus breakdowns `byStatus`, `byCode`, `byMsg`, `byBeaconKind`. Read-only; exempt from rate limiting. |
| `POST /report` | `{id, kind, state, detail?, ts?}` | `200 {}` — fire-and-forget client-side error beacon (SSE stall, fetch failure, machine-rejected transition). Unknown/stale `id` accepted and logged — a beacon from a reaped client is itself diagnostic data. `kind` required (`400 missing kind`); rate-limited like other POSTs; the client throttles (see `beaconGate` in `web/kxp.js`). |

### One live match per client

`/cpu` and `/queue` both return `409 already in a match` while the client holds a live match. The invariant has to be enforced at the handler, because nothing downstream can repair the damage otherwise: a retried or double-tapped start request would overwrite the client's match pointer and orphan the first match, and both match loops would then drive the same event stream. The client would see two `matched` and two `countdown` frames for one round, its single pick would be routed to whichever match the pointer names, and the orphan would resolve with no human move — reporting `result: loss` with `yourNote: "timeout"` for a round the player never played. The stale-teardown guard in `finishMatch` cannot clean that up either: it deliberately suppresses the teardown frame for any side that has already been re-pointed at a newer match, so the phantom round is never retracted. The browser also disables its start button for the duration of the request, so a double-tap on Fight does not ask for a second match in the first place.

## Client state machine

`web/machine.js` is the single source of truth; this table mirrors it. Events
that are purely client-generated are marked with `*`.

| from | event → to |
| --- | --- |
| `lobby` | `queue*`→`waiting`, `waiting`→`waiting`, `matched`→`matched` |
| `waiting` | `cancel*`→`lobby`, `matched`→`matched`, `waiting`→`waiting`, `stateIdle`→`lobby` |
| `matched` | `cancel*`→`lobby`, `matched`→`matched`, `countdown`→`countdown`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `countdown` | `countdown`→`countdown`, `matched`→`countdown`, `shoot`→`shoot`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `shoot` | `move*`→`locked`, `lock*`→`locked`, `reject*`→`locked`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `locked` | `move*`→`locked`, `reject*`→`locked`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `result` | `matched`→`matched`, `rematch:online*`→`waiting`, `mode*`→`lobby` |

Snapshot events are total: from any state, `snapshot:idle`→`lobby`,
`snapshot:waiting`→`waiting`, `snapshot:matched`→`matched`,
`snapshot:countdown`→`countdown`, `snapshot:shoot`→`shoot`.

Notes:

- A `shoot` event arriving in `shoot`/`locked` is upgraded client-side into a
  shortened catch-up window (see the README) instead of being dropped.
- The `result` event is the only terminal signal; a `mode`/`rematch:online`
  choice after it returns to the lobby or queue.

## Clock handling

`shootAt` and the move timestamps are wall-clock epoch ms. The client
estimates the phone/server clock offset once per connection from the
`connected` frame's `now` field (`skew = now − Date.now()`) and applies it
when computing how much of the PUN window remains, so a skew-delayed delivery
still shows the true server-side remaining time instead of a collapsed one. On
`shoot` it plays out only the remaining `windowMs − ((now + skew) − shootAt)`
and never shows an unwinnable PUN. Win/loss is decided exclusively by server
arrival time; client times are cosmetic.

## Rework

Implemented and parked slices of the protocol rework. The original protocol
made the player's ability to act depend on burst delivery of the `shoot` frame
over a single unacknowledged SSE stream: a ~2s stall at that moment (or a lost
frame, unrecoverable faster than a reconnect) produced "skip PUN → Waiting for
result → You lose" with no chance to act. Task A removed that dependency;
Tasks B/C exist as parked drafts, not scheduled work (see the roadmap and
[docs/issues.md](issues.md)).

### v1.1 — announced deadline + per-frame `ts` (implemented)

- The server pre-announces the round schedule at countdown start. The first
  countdown frame (and each later one, idempotently) carries
  `{n, shootAt, windowMs, ts}` where `shootAt` is the announced, already-fixed
  deadline; the run loop sleeps to the announced slots (READY at S−3s, KA at
  S−2s, CHI at S−1s) and advances to `shoot` at `S` **without re-minting
  `shootAt`**.
- Three beats precede PUN, not two. `READY` is leading slack: the countdown is
  the player's first warning that a round has begun, and it arrives over the
  same connection that may still be waking from radio idle or a buffering
  proxy. With only the two beats of the KA-CHI-PUN rhythm, a link that lost
  ~2s of delivery had no beat left to show — the count jumped straight to PUN
  and the player never saw a countdown at all, despite the pick window being
  open. A third beat absorbs that lag.
- The client paints from the announced deadline, not from `n`. On receipt it
  resolves which beat is genuinely showing (`countdownSlot` in `web/kxp.js`)
  and arms one timer to advance to the next, so a frame delayed past its own
  beat degrades to the next beat instead of painting one with no time behind it
  — that flash would be overwritten in the same tick and cost the countdown
  outright. `READY`/`KA`/`CHI` offsets live in one table shared by that logic
  and `countdownBeats` in `round.go`; the two must stay in step.
- The client schedules the countdown locally against the announced `shootAt`; a
  late or dropped `shoot`/`countdown` frame is harmless (already acted upon), so
  `shoot` demotes to advisory. `connected` snapshots carry the plan
  (`shootAt`+`windowMs`) when `phase=countdown` — only once announced, so a
  mid-handshake snapshot cannot leak a deadline — and keep the existing
  `shootAt`/`windowMs` on `phase=shoot` for rejoin.
- `countdown`, `shoot`, `matched`, `result`, and `waiting` all gain a `ts`
  field (server epoch-ms at construction), making delivery lag vs clock skew
  measurable at the client for the first time.
- Server plumbing: `shootAt` moved from a plain `time.Time` to an
  `atomic.Pointer[time.Time]` so snapshots can read it during countdown without
  racing the run goroutine; it is held as a `time.Time` so it retains a
  monotonic reading for the server's own arrival-timing and deadline maths,
  while the wire value is derived from that instant via `UnixMilli` (epoch-ms
  above is unchanged). `handleMove` judges lateness against the announced
  `deadline()`.

### v1.2 — stream sequence numbers + replay (parked — see issues.md)

Draft spec; not scheduled. Defined from the unconfirmed stuck-in-`matched` /
reconnect-recovery symptoms (issues.md entries 1–2).

- Every frame is written with its SSE `id:` (a per-stream monotonic seq); a
  reconnecting client presents the browser's `Last-Event-ID` (or a `?seq=`
  query) and the server replays missed frames from a small per-client ring
  buffer. Past the ring, or when the match already finished, the existing
  snapshot reconciliation applies. Replaces the reconnect-then-snapshot
  recovery whose backoff is slower than the 2s window.

### v1.3 — `/ping` health probe (parked — see issues.md)

Draft spec; not scheduled. Measurement for the weak-link window-shrink symptom
(issues.md entry 3).

- `POST /ping` → `{clientTs, serverTs}` lets the client probe one-way latency
  while in lobby/matched, surface a weak-connection indicator, and back out of
  a match before it begins on a degrading link.
