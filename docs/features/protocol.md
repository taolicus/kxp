# KACHIPUN game protocol

Version: 1.1. All payloads are JSON. Numbers are seconds unless stated.
Timed frames carry `ts`, server epoch-ms at construction, so delivery lag is
distinguishable from clock skew at the client for the first time. The schedule
is the announced-deadline one described under
[Match lifecycle](#match-lifecycle).

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

### Why three beats precede PUN

`READY` → `KA` → `CHI` is three beats to `shoot`, not two, and `READY` is
deliberately leading slack rather than a countdown digit. It is the player's
first warning that a round has begun, and it arrives over the same connection
that may still be waking from radio idle or sitting in a buffering proxy. With
only the KA-CHI-PUN rhythm, a link that had lost ~2s of delivery had no beat
left to show — the count jumped straight to PUN and the player never saw a
countdown at all, despite the pick window being open. A third beat absorbs that
lag.

The schedule is **announced, not recomputed**. The server sets `shootAt` once at
countdown start and the run loop sleeps to the announced slots, never re-minting
the deadline, so every client judges the same instant regardless of when its
frames arrive. The client therefore paints from the announced deadline rather
than from `n`: on receipt it resolves which beat is genuinely showing
(`countdownSlot` in `web/kxp.js`) and arms a single timer to advance to the next,
so a frame that arrives after its own beat degrades to the next beat instead of
painting one with no time behind it — that flash would be overwritten in the same
tick and cost the countdown outright. The `READY`/`KA`/`CHI` offsets live in one
table shared by that logic and `countdownBeats` in `round.go`, and the two must
stay in step.

Because the window is scheduled client-side against the announced `shootAt`, a
late or dropped `shoot` frame is harmless — the client has already acted on the
deadline — so `shoot` is advisory rather than load-bearing. Landed in `e01bbcd`.

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
player caused it. The copy states the cause it can prove and never which player
was at fault, and it must not read as a loss: no `result` is emitted, so nothing
is scored.

**The extra fields are additive, and that was not the obvious choice.** Swapping
the event type for `waiting` would have reused the frame `POST /queue` already
sends — but `waiting` has no `matched → waiting` edge in the client machine, and
adding it does not help a client that predates the change. A tab open across a
deploy would strand itself on the game screen with a rejected transition. Keeping
the frame as `state idle` and adding fields means an old client ignores them and
behaves exactly as before. The client needed one new edge
(`matched + waiting = waiting`) to avoid a lobby flash, which is safe precisely
because the wire format did not change.

The mode-aware requeue matters more than the message did. `makeMatch` originally
wired the *same* requeue closure for CPU and PvP, so a CPU handshake timeout put
the player into the **PvP queue** for a human opponent they never asked for —
`requeueSide(1)` correctly no-ops for the bot, but side 0 never checked the mode.
Fixed at the source, and pinned by asserting the human is *not* on the queue,
which is the inverse of the test it replaced. Landed in `6c96bfb`.

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
| `connected` | `{id, state, online, now?, phase?, opponentName?, opponentCharacter?, windowMs?, shootAt?, pending?}` | First frame of every connection. `state` is `idle` / `waiting` / `ingame`; `now` is the server's epoch-ms at send, used by the client to estimate clock skew (`skew = now − Date.now()`); `phase` (`countdown`/`shoot`/`done`) and opponent fields only when `ingame`; `shootAt`+`windowMs` whenever `phase` is `countdown` or `shoot` (`server.go:509`) — carrying the plan during countdown is what lets a client reconnect *inside* the window rather than being left without a deadline; `pending=true` only while a PvP handshake is still open. Used to reconcile on reconnect. |
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
| `yourNote`, `opponentNote` | `early`, `late`, `timeout`, or `""`. |
| `youTimingMs`, `opponentTimingMs` | Server-side arrival relative to `shootAt` (nil when not valid / timeout). |
| `youClientMs`, `opponentClientMs` | Client-reported reaction (`clickedAt − sawPunAt`) when present and sane; displayed in preference to the network-inflated `*TimingMs`. |
| `youCharacter`, `opponentCharacter` | Characters chosen for each side. |
| `opponentName` | `CPU` or `Opponent`. |
| `mode` | `online` or `cpu`. |

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

### Why `/health` carries a build identity

The probe suite points at a deployed origin, so without an identity every live
result is conditional on an assumption nobody can check — that the deploy
actually happened and restarted. A green suite against a stale binary is *worse*
than no suite, because it reads as verification. This is the same failure shape
as the probe origin defaulting to the wrong host: a suite that looks
authoritative while measuring the wrong thing. The suite cannot detect its own
misconfiguration, so the check has to be explicit and has to run first — hence
`t1`, before any other probe.

**No build script is required.** The identity comes from Go's automatic VCS
stamping, so a plain `go build -o kxp .` inside a work tree identifies itself
with no deploy-time discipline to forget. `modified` is reported separately from
`sha` so a dirty tree cannot masquerade as its commit, and `source` names which
mechanism supplied it. `sha` is `"unknown"` for a binary carrying no VCS
metadata, which is what a stale or externally-built binary reports — and `t1`
treats that as a failure rather than passing it. `go test` does not stamp test
binaries, so the parser is unit-tested from synthetic settings and only a real
binary on a deployed origin exercises the stamped path end to end.
Landed in `a9abeba`.

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
