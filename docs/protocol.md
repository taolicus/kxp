# KACHIPUN game protocol

Version: 1. All payloads are JSON. Numbers are seconds unless stated.
(A protocol rework v1.1–v1.3 is planned; see "Planned rework" at the end of
this document — not yet implemented.)

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

A human-vs-human (PvP) match additionally runs a **ready handshake** between
"matched" and the countdown: neither countdown may start until both clients
have `POST /ready`. Clients re-send readiness every 2s while matched (self
healing on a lost ack). If a pair never acks — 8s timeout or a disconnect —
the pending match is cancelled and the survivor(s) go back to the queue. CPU
matches skip the handshake entirely and start instantly.

Match duration: `matched` → `KA` (+1s) → `CHI` (+1s) → `shoot` (2s window) →
`result`. PvP adds handshake time on top.

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
| `matched` | `{opponentName, opponentCharacter}` | Opponent found; PvP clients should start `POST /ready`. |
| `countdown` | `{n}` | `n` is `KA` or `CHI`. |
| `shoot` | `{windowMs, shootAt}` | **PUN!** Window opens. `windowMs` is authoritative (2000); `shootAt` is server clock epoch-ms. |
| `lock` | (none — client timer) | Client closes its own input after `windowMs - elapsed` of the window remains reachable. |
| `result` | see below | Round resolved. |
| `opponent-left` | `{outcome: "win", mode}` | Other player left; counts as a win. |
| `state` | `{state: "idle"}` | Match fully finished / queue left; client may return to the lobby. |

`result` payload:

| field | meaning |
| --- | --- |
| `you`, `opponent` | Moves: `rock`, `paper`, `scissors` (absent on timeout). |
| `outcome` | `win`, `loss`, `draw`. |
| `yourNote`, `opponentNote` | `early`, `timeout`, or `""`. |
| `youTimingMs`, `opponentTimingMs` | Server-side arrival relative to `shootAt` (nil when not valid / timeout). |
| `youClientMs`, `opponentClientMs` | Client-reported reaction (`clickedAt − sawPunAt`) when present and sane; displayed in preference to the network-inflated `*TimingMs`. |
| `youCharacter`, `opponentCharacter` | Characters chosen for each side. |
| `opponentName` | `CPU` or `Opponent`. |
| `mode` | `online` or `cpu`. |

## POST endpoints

Request bodies always start with the client id; content-type JSON.

| endpoint | body | responses |
| --- | --- | --- |
| `POST /queue` | `{id}` | `200 {}` — joins the online queue (idempotent). |
| `POST /cancel` | `{id}` | `200 {}` — leaves the queue (best effort). |
| `POST /ready` | `{id}` | `200 {}` — advertises readiness for the current PvP match; `400 no active match` if none. Ignored for CPU matches. |
| `POST /cpu` | `{id}` | `200 {}` — starts an instant CPU match (also drains/leaves the queue). |
| `POST /move` | `{id, move, sawPunAt?, clickedAt?}` | `200 {}` on acceptance. `400 too early` during countdown, `400 too late` past the deadline, `400 match over` on a finished match, `400 invalid move`, `400 no active match`, `409 move already submitted`, `413 body too large`. `sawPunAt`/`clickedAt` are client epoch-ms used only for display. |
| `POST /character` | `{id, character}` | `200 {}` — picks a fighter (`scorpion`, `subzero`, `raiden`); `400 invalid character`. |

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

## Planned rework: v1.1–v1.3 (not yet implemented)

The current protocol makes the player's ability to act depend on burst delivery
of the `shoot` frame over a single unacknowledged SSE stream: a ~2s stall at
that moment (or a lost frame, unrecoverable faster than a reconnect) produces
"skip PUN → Waiting for result → You lose" with no chance to act. The planned
rework removes that dependency. Slices ship one at a time (see the roadmap,
"Protocol rework").

### v1.1 — announced deadline + per-frame `ts`

- The server pre-announces the round schedule at countdown start. The `KA`
  frame (and the `CHI` frame, idempotently) carries `{n, shootAt, windowMs, ts}`
  where `shootAt` is the announced, already-fixed deadline; the run loop sleeps
  to the announced slots (KA at S−2s, CHI at S−1s) and advances to `shoot` at `S`
  **without re-minting `shootAt`**.
- The client schedules KA/CHI/PUN locally against the announced `shootAt`; a
  late or dropped `shoot`/`countdown` frame is harmless (already acted upon), so
  `shoot` demotes to advisory. `connected` snapshots carry the plan
  (`shootAt`+`windowMs`) when `phase=countdown` so a mid-countdown reconnect
  rebuilds the schedule.
- `countdown`, `shoot`, `matched`, `result`, and `waiting` all gain a `ts`
  field (server epoch-ms at construction), making delivery lag vs clock skew
  measurable at the client for the first time.

### v1.2 — stream sequence numbers + replay

- Every frame is written with its SSE `id:` (a per-stream monotonic seq); a
  reconnecting client presents the browser's `Last-Event-ID` (or a `?seq=`
  query) and the server replays missed frames from a small per-client ring
  buffer. Past the ring, or when the match already finished, the existing
  snapshot reconciliation applies. Replaces the reconnect-then-snapshot
  recovery whose backoff is slower than the 2s window.

### v1.3 — `/ping` health probe

- `POST /ping` → `{clientTs, serverTs}` lets the client probe one-way latency
  while in lobby/matched, surface a weak-connection indicator, and back out of
  a match before it begins on a degrading link.
