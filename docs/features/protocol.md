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

Server side a match moves through five atomic phases:

```
idle → preparing → countdown → shoot → done
```

`preparing` is the span where a match exists but no round has been announced: the
round's background has been chosen, `matched` has gone out, each client is
loading assets for the match screen, and the readiness gate is waiting on every
human side. `countdown` begins only when that gate opens — every human's match
screen is up and has acked — and is the first phase in which any countdown frame
can exist.

The phase used to be called `countdown` for that whole span, which meant a phase
named after something that had not started yet. The split is what makes "assets
loaded and everyone acked" a state the server can assert rather than an
assumption buried in a client.

> **`phase` in the reconnect snapshot changed from `countdown` to `preparing`, and
> that is a deliberate break.** A client decides how to rejoin an in-flight
> handshake by testing `phase === "countdown" && pending`, so a tab open across a
> deploy would miss the test, take a different transition, and never re-arm its
> readiness ack — the handshake would then time out against a correctly working
> server. This is accepted because the project has no live users, so the client
> that could be stranded does not exist; the alternative was keeping a name the
> server has stopped believing. `app.js` accepts both names, so the only client
> that breaks is one predating this change, talking to a server that has it.

`shoot` is the **PUN!** instant: the server records `shootAt` and opens a 2s
window. Any pick is judged by arrival time relative to `shootAt`.

Every match runs a **ready handshake** during `preparing`: no
countdown may start until every *human* side has `POST`ed `/ready`. Clients
re-send readiness every 2s while matched (self healing on a lost ack), and a
client that reconnects mid-handshake is re-admitted by the `pending` snapshot
flag, which sends it back through `matched` and so re-arms its acks. If a match
never acks — 8s timeout or a disconnect — the pending match is cancelled and the
survivor(s) go back to the queue.

An **online series re-opens the same gate between rounds.** The `result` frame
that announces the series continues also opens it: `betweenRounds` is set before
the frame goes out, `/ready` is accepted again for the whole span — including
during the pause, while the phase still reads `done` — and the next countdown
starts once both sides have re-acked. Clients keep their 2s re-ack loop running
across the pause, which is what makes the lease work here: an ack from round one
is stale by the time the gate opens, so each side must answer this round's gate
rather than lean on its old ack. A reconnect during the pause or the gate is
re-admitted by the same `pending` snapshot flag as at the start of a match.
The gate is also the series' only exit, and its failure **forfeits** rather than
requeues — see [Cancelled handshakes](#cancelled-handshakes) below. A bot's
series never opens it: those rounds follow each other without a handshake, as
they always have.

### Why readiness is a lease, not a latch

The gate opens only while every human side
holds an ack newer than `readyLease` (4s), re-tested every 250ms rather than once,
so a side that acked and then went quiet stops counting and the match ends on the
existing timeout instead of being served a round. A latch says "this side acked
once", which is true forever and is not the same claim as "this side is here now"
— which is the only version of it that still means anything when the countdown
starts. `readyLease` must stay comfortably above the client's 2s re-ack interval
for exactly this reason: a client that is behaving correctly must not be able to
expire its own lease between acks and stall the match. Re-acking renews the lease,
so the renewal cannot short-circuit on a side that has already acked.

The lease does not close every gap, and the one it leaves is worth naming rather
than implying otherwise. A side that acks and is then hidden *within the window
before the countdown starts* still counts as fresh, because freshness is judged at
the instant the gate opens and nothing re-checks afterwards. Closing that would
mean refusing to open the gate until every side had acked across a full renewal
interval, which adds a fixed multi-second delay to the start of every round. That
is a worse trade than the narrow window it removes, so the window is documented
rather than paid for.

The handshake is a **self-timing buffer, not a fixed sleep**: the client acks
once it has finished setting the round up, so the countdown cannot begin until it
is ready to receive one. A slow client waits as long as it needs (up to the 8s
timeout) and a fast one pays nothing. A CPU match gates on its single human
exactly this way; the bot is not a participant and is never waited for.

### Why readiness waits for a painted frame

The ack used to be posted straight from the `matched` handler, which meant it
proved only that bytes had reached the browser. On a phone that is a much weaker
claim than it looks: an app in the background with a healthy connection acks just
as reliably as one being looked at, and the round then fires at somebody who never
saw it start. That is the same experience as a late first countdown frame — a
round arriving without warning — arriving from an unrelated cause, which is part
of why it survived: from the lobby the two are indistinguishable.

So the ack waits for a **presented animation frame** before it is sent, and it is
gated on `document.visibilityState` as well. `requestAnimationFrame` does not run
in a backgrounded tab, which makes the whole gate self-suppressing: no frame means
no ack, and the existing 8s timeout cancels the match rather than firing a round at
an absent player. No new UI is involved — the count simply reads MATCH FOUND while
the client decides whether it is really on screen.

A button was tried first and rejected. It did earn the ack more strictly, but it
charged every player a control to learn and press to start a round they were
already looking at, and it bought a distinction the frame gate gets nearly all of
for free: what it added was attention rather than presence, so it only separated
the case of a phone propped up, screen awake and rendering, with nobody watching.

What this cannot prove is attention, and the honest limit is that. It fixes the
backgrounded app, which is the common case and the one that produced the reported
symptom; it does not fix a distracted player, and no amount of client-side
machinery can, because the server only ever sees an ack. The trade is that a round
no longer starts on its own, so a player who backgrounds the app cancels it for
both — one round lost, instead of one round fired at nobody. The ack re-posts every
2s while matched so a lost ack on a flaky link still self-heals, and stops on every
exit from `matched`, so a client never asks to start a round that no longer exists.
Landed with the client tests in
`web/app.ready.test.cjs`.

### Why three beats precede PUN

`READY` → `KA` → `CHI` is three beats to `shoot`, not two, and `READY` is
deliberately leading slack rather than a countdown digit. It is the player's
first warning that a round has begun, and it arrives over the same connection
that may still be waking from radio idle or sitting in a buffering proxy. With
only the KA-CHI-PUN rhythm, a link that had lost ~2s of delivery had no beat
left to show — the count jumped straight to PUN and the player never saw a
countdown at all, despite the pick window being open. A third beat absorbs that
lag.

That absorption is bounded rather than general, and the bound is worth stating
because it separates "a third beat helps" from "a third beat is enough". The
server announces `shootAt` three seconds ahead and sends `READY` at that same
instant, so the lead before the deadline equals the countdown length and there is
no margin beyond it. Delivery latency therefore eats the countdown from the
front, one beat per second: up to a second of lag still shows all three beats,
two shows `KA`/`CHI`, three shows `CHI` alone, and three or more leaves nothing to
paint, so the client goes from `MATCH FOUND` straight to **PUN!** with the window
open. This is a property of the schedule and not of the client — `countdownSlot`
is right to report no beat once `msUntilPun <= 0`, since painting one there would
flash a beat with no time behind it, and once a client knows `shootAt` it paints
the remaining beats on its own timers. Widening the tolerance means spending
seconds before PUN, and that trade-off is held open in
[`countdown-margin.md`](../tasks/closed/countdown-margin.md). The envelope is pinned
by "app.js loses exactly one countdown beat per second of first-frame delay" in
`web/app.countdown.test.cjs`, so changing the schedule has to move that table on
purpose. The three-beat schedule itself landed in `8a859f7`; the bounded
envelope was measured against a production report afterwards.

The schedule is **announced, not recomputed**. The server sets `shootAt` once at
countdown start and the run loop sleeps to the announced slots, never re-minting
the deadline, so every client judges the same instant regardless of when its
frames arrive. The client therefore paints from the announced deadline rather
than from `n`: on receipt it resolves which beat is genuinely showing and arms a
timer to re-check, so a frame that arrives after its own beat degrades to the next
beat instead of painting one with no time behind it — that flash would be
overwritten in the same tick and cost the countdown outright.

**The client re-derives the beat from the clock on every check rather than
stepping once per beat.** `countdownPainter` in `web/kxp.js` is a pure stepper:
call it and it reports the beat due now and how long until that could change. It
replaces a generator walked one beat per timer, and that version blanked the whole
countdown outright — not by losing a beat, but by losing all of them. Each delay
was measured from the step before it, so anything a runtime did to a timer
accumulated down the chain, and the chain was built once from the first frame, so
the repeats carrying the same `shootAt` could never correct it. Two things could
put that chain past its own deadline, and re-deriving covers both rather than
betting on which one occurred.

A **late timer step** is the likelier of the two on a phone. Because each delay
was measured from the step before it, one step firing late shifted every later beat
with it, so ordinary main-thread contention — a background decode, a GC, a
backgrounded tab — could compound three times inside a three-second lead. A
**wrong clock** is the sharper but rarer case: `clockSkew` is sampled once at
connect and never re-derived, so a phone whose wall clock stepped between the
snapshot and the round counted against a reading no longer true. One bad
measurement parked the display on a single long timer with nothing able to
re-check, so nothing repainted until it fired — with the pick window still open and
every frame delivered on time, then dropped as a duplicate. The harness
reproduces that second case directly. Neither was isolated in the field, because
this host cannot watch a phone's clock step; the link is measurably prompt
(~90ms of jitter against 1s beats, no beat lost in eight consecutive matches), so
margin was never the missing piece.

Re-deriving bounds the damage to one check — the wait before the first beat is
capped rather than trusted, so a wrong reading is re-read within a second instead
of waited out — and the repeats are no longer dropped, which is invisible because a
label is reported only when the beat actually changes, with one stepper per round
keeping that memory across re-arms. The stepper is deliberately pure: `kxp.js`
never touches a timer or the DOM, so the caller owns the scheduling and an injected
clock can drive it, and `web/diag.html` paints its countdown with the same code the
game does rather than modelling it separately. Pinned by "the countdown survives a
clock that reads wrong and then comes back" in `web/app.countdown.test.cjs`; the
reasoning is in
[client-countdown-painter.md](../tasks/closed/client-countdown-painter.md).

The `READY`/`KA`/`CHI` offsets live in one table shared by that logic and
`countdownBeats` in `round.go`, and the two must stay in step.

Because the window is scheduled client-side against the announced `shootAt`, a
late or dropped `shoot` frame is harmless — the client has already acted on the
deadline — so `shoot` is advisory rather than load-bearing. Landed in `e01bbcd`.

### Cancelled handshakes

A handshake that does not complete is *cancelled*, never lost: no `result` is
emitted and nothing is scored. The teardown `state` frame says why, so a bounced
player is not left staring at a lobby that silently moved them.

| `reason` | when | `requeued` | player ends up |
| --- | --- | --- | --- |
| `handshake-timeout` | no human acked within 8s (opening gate) | PvP: `true`. CPU: absent | PvP: back in the online queue. CPU: back in the lobby. |
| `opponent-left` | the other side disconnected before the countdown (opening gate) | `true` (survivor only) | back in the online queue |

`requeued` is present and true **only when the server actually put that client
back on the queue**, which is what the client needs in order to keep showing the
Searching view and its Cancel button. Without it the client reads a bare
`state idle` as "back to the lobby" while the server still holds it in the queue —
invisible, with no way to leave. A CPU match's human is deliberately **not**
re-queued: they asked for a CPU round, so they return to the lobby instead of
being dropped into the queue for a human opponent they never requested.

**A gate that fails between rounds of an online series forfeits instead**, with
the same two `reason`s and no `requeued`:

| `reason` | when | `requeued` | player ends up |
| --- | --- | --- | --- |
| `opponent-left` | a side disconnected while the between-rounds gate was open | absent | the side still present is **awarded the series** |
| `handshake-timeout` | the gate's 8s ran out and one side had re-acked | absent | the side that answered is **awarded the series** |
| `handshake-timeout` | the gate's 8s ran out and neither side re-acked | `true` (both) | back in the online queue — nothing was decided about them |

Each award is announced first, on the departing side's `opponent-left` frame
(see the events table for its series payload), and only then torn down by the
`state` frame above with the reason and no `requeued` flag. The distinction the
client needs is the same one the opening gate draws — queue or lobby — with one
addition: a player with a tally is never handed back to the queue, because the
opponent who left has already lost the series to them and requeueing would
strand the survivor as half of a pair nobody asked for. Only a timeout with
*neither* side answering requeues, where the old rule (nothing was played,
nobody is owed a result) still holds. A one-round online match never reaches
this gate: it ends on its result, as it always did.

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
| `connected` | `{id, state, online, now?, phase?, opponentName?, opponentCharacter?, background?, windowMs?, shootAt?, pending?}` | First frame of every connection. `state` is `idle` / `waiting` / `ingame`; `now` is the server's epoch-ms at send, used by the client to estimate clock skew (`skew = now − Date.now()`); `phase` (`preparing`/`countdown`/`shoot`/`done`), the opponent fields and `background?` (the same stage name `matched` carries, so a reconnecting client restores the arena instead of picking its own) only when `ingame`; `shootAt`+`windowMs` whenever `phase` is `countdown` or `shoot` (`server.go:509`) — carrying the plan during countdown is what lets a client reconnect *inside* the window rather than being left without a deadline, and `preparing` is excluded because no deadline exists yet to carry; `pending=true` only while a handshake is still open, i.e. `phase === "preparing"` or the between-rounds pause/gate of an online series (`betweenRounds`), and not every human ready. Used to reconcile on reconnect. |
| `online` | `{count}` | Number of other clients currently connected. |
| `waiting` | `{}` | Entered the queue. |
| `matched` | `{opponentName, opponentCharacter, background, ts, roundsTarget?}` | Opponent found, and the stage to play on: `background` is a name from the server's roster, chosen once per match so both sides are sent the same one. Only the name travels — the WebPs are client-side assets. `roundsTarget?` is present only for a match that is a series (see below), and is what lets the client draw the scoreboard before round one rather than after it. Every client should start `POST /ready`. |
| `countdown` | `{n, shootAt, windowMs, ts}` | `n` is `READY`, `KA` or `CHI`. The plan fields are present on every countdown frame — see v1.1 below. |
| `shoot` | `{windowMs, shootAt}` | **PUN!** Window opens. `windowMs` is authoritative (2000); `shootAt` is server clock epoch-ms. |
| `lock` | (none — client timer) | Client closes its own input after `windowMs - elapsed` of the window remains reachable. |
| `result` | see below | Round resolved. |
| `opponent-left` | `{outcome, mode, opponentName?, opponentCharacter?, seriesOver?, youRoundWins?, oppRoundWins?, roundsTarget?, drawEnds?, ts?}` | Other player left; counts as a win. The plain form (`{outcome: "win", mode}` plus the opponent's name and fighter) is a departure before anything was scored. On a forfeited series the same event carries the series state — `outcome` is `win` or `loss` per side, `seriesOver: true`, the tally as it stands (a forfeit decides the series; it is not a round anybody won), and the same `roundsTarget`/`drawEnds` a scoreboard is drawn from — but deliberately no `round`, because it decides the series as a whole. The identity pair rides on every form because this frame is rendered by the same result panel as a `result`, and that panel re-reads the opponent slot from the frame: without them the last screen of a forfeit shows a bare `(opponent)` where the fighter both players chose was. |
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
| `round` | Current round number (1-based). |
| `youRoundWins`, `oppRoundWins` | Decisive round wins per side **including the round this result reports** — a scoreboard read, not a running total the client has to add up. A `void` round counts for the opponent. |
| `roundsTarget?` | Target number of decisive wins to win the series (3 today). **Only on a match that has a series** — a one-round match omits it. A client reads a missing target as "no series", so it draws no scoreboard, which is the only honest reading for a match that cannot go past round one. |
| `drawEnds?` | Whether a drawn round ends the match (`true` for a one-round match, `false` for a ladder floor). **Only on a match that has a series**, beside `roundsTarget`. It is the field that tells a first-to-1 floor apart from a 1-off at the same target, and it lands on the wire rather than in the client's head; nothing renders it yet. |
| `seriesOver` | `true` if the series ended with this result, else `false`. |

## HTTP endpoints

`POST` request bodies always start with the client id; content-type JSON.
`GET /events` is the SSE stream; `GET /characters`, `GET /health`, and
`GET /metrics` are read-only and exempt from rate limiting. Everything else
(including the `POST /report` client error beacon) is rate-limited.

| endpoint | body | responses |
| --- | --- | --- |
| `POST /queue` | `{id, roundsTarget?, drawEnds?}` | `200 {}` — joins the online queue for a match of that length (idempotent; re-posting while waiting updates the length rather than taking a second seat). `roundsTarget` is the same closed set `/cpu` offers (`1` or `3`); absent means `1`, what the lobby's plain button has always asked for, so a client predating the field still queues for the one-round match it expects. Any other value is `400 unsupported roundsTarget`. `drawEnds` is decoded exactly as `/cpu` decodes it (absent means the one-round inference). The queue pairs only entries that agree on both fields — see "Why the series length is a closed set". `409 already in a match` while the client holds a live match. |
| `POST /cancel` | `{id}` | `200 {}` — leaves the queue (best effort). |
| `POST /ready` | `{id}` | `200 {}` — advertises readiness for the current match; `400 no active match` if none; `409 ready gate closed` if the match has left every open-gate state (`preparing`, `countdown`, and the between-rounds pause/gate of an online series, which is open while `betweenRounds` is set) and will send no countdown, and `409 not a side of this match` if the client's match pointer resolves to no side of it. Both 409s exist because a `200` is read by the client as "hold still, it is coming", so it must never be returned for an ack that did not register or for a match that will not run. Gates CPU and PvP alike, and gates each round of a series. Idempotent while the match is live — every call renews the readiness lease — so a re-sent ack from a reconnecting client is still accepted, and a repeat ack from a client that is behaving correctly must not expire its own lease. |
| `POST /cpu` | `{id, roundsTarget?, opponentCharacter?, drawEnds?}` | `200 {}` — starts a CPU match (also drains/leaves the queue), ending when one side has won `roundsTarget` decisive rounds. `roundsTarget` is the length the lobby offers (`1` or `3`); absent means `3`, so a client predating the field still starts a match. Any other value is `400 unsupported roundsTarget` — the set is closed rather than a range, so a hand-written request cannot invent a series the game has never described. `opponentCharacter` is which roster fighter the bot plays, for an [arcade ladder](../tasks/closed/arcade-ladder.md) floor; absent means the random pick, and a name off the roster is `400 invalid opponent character` — it reaches the opponent slot and the wire, so it is not passed through unfiltered. Naming the bot is not a hole: its reaction is fixed, its move is random, and every round is still judged here. `drawEnds` is whether a drawn round ends the match; absent means the one-round inference (a match of one round is whatever that round came to), and the arcade ladder always sends `false` so a drawn round replays rather than deciding a floor. `409 already in a match` while the client holds a live match. The match still waits for the client's `/ready` ack before its countdown. |
| `POST /move` | `{id, move, sawPunAt?, clickedAt?}` | `200 {}` on acceptance. `400 too early` during countdown, `400 too late` past the deadline, `400 match over` on a finished match, `400 invalid move`, `400 no active match`, `409 move already submitted`, `413 body too large`. `sawPunAt`/`clickedAt` are client epoch-ms used only for display. |
| `POST /character` | `{id, character}` | `200 {}` — picks a fighter; `400 invalid character`. See `GET /characters` for the current roster. |
| `GET /characters` | — | `200 [{id, name, emoji}]` — the full roster, the single source of truth for character data at runtime; what it currently holds is listed in [characters](characters.md). The client fetches it at startup and no longer bundles its own copy. |
| `GET /health` | — | `200 {status, uptime, online, queue, activeMatches, build}` — liveness/readiness probe. Exempt from rate limiting. `build` is `{sha, modified, source}`: the commit the running binary was built from, whether that build tree had uncommitted changes, and how the identity was obtained (`vcs`, `ldflags`, or `unknown`). `sha` is `"unknown"` when the binary carries no VCS metadata. The probe suite's `t1` compares it against the local HEAD — without it, a green live result cannot be distinguished from a stale binary serving traffic. |
| `GET /metrics` | — | `200 {uptime, online, queue, matches, counts}` where `counts` carries cumulative request/reject/join/leave/drop/rate-limit/beacon streams plus breakdowns `byStatus`, `byCode`, `byMsg`, `byBeaconKind`. Read-only; exempt from rate limiting. |
| `POST /report` | `{id, kind, state, detail?, ts?}` | `200 {}` — fire-and-forget client-side error beacon (SSE stall, fetch failure, machine-rejected transition). Unknown/stale `id` accepted and logged — a beacon from a reaped client is itself diagnostic data. `kind` required (`400 missing kind`); rate-limited like other POSTs; the client throttles (see `beaconGate` in `web/kxp.js`). |

### Why the series length is a closed set

`roundsTarget` — on `POST /cpu` and on `POST /queue` alike — is validated
against the two lengths the lobby offers, not against a range. A range would
accept `2`, which nothing in the UI describes: the client would be asked to draw
a two-pip row for a mode that does not exist, and the server would be
maintaining series behaviour for a request that no player can make. Absent is
not an error either, though the two endpoints read it differently: on `/cpu` it
means the client predates the field and gets the series default, so a tab open
across the deploy can still start a match; on `/queue` it means the one-round
match the lobby's plain button has always asked for, so the same tab still gets
the match it expects.

The queue shares the set because it is the queue that has to *pair* a length: a
waiting entry carries its `roundsTarget` and `drawEnds`, and only entries that
agree on both are paired — a first-to-three player and a one-round player
waiting together are two people who would otherwise be dropped into a match only
one of them asked for, and the mismatched waiter keeps their seat and their
place until an equal-length partner arrives. A side handed back to the queue by
a cancelled handshake re-enters with the length it was playing, for the same
reason: it is halfway through a series and must not come back as a one-off. The
pairing and the re-entry are pinned by `TestQueuePairsOnlyEqualLengths` and
`TestRequeuedSideReentersWithTheLengthItWasPlaying`.

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
| `lobby` | `queue*`→`waiting`, `waiting`→`waiting`, `matched`→`matched`, `climb*`→`ladder` |
| `waiting` | `cancel*`→`lobby`, `matched`→`matched`, `waiting`→`waiting`, `stateIdle`→`lobby` |
| `matched` | `cancel*`→`lobby`, `matched`→`matched`, `countdown`→`countdown`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `countdown` | `countdown`→`countdown`, `matched`→`countdown`, `shoot`→`shoot`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `shoot` | `move*`→`locked`, `lock*`→`locked`, `reject*`→`locked`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `locked` | `move*`→`locked`, `reject*`→`locked`, `result`→`result`, `opponentLeft`→`result`, `stateIdle`→`lobby` |
| `result` | `matched`→`matched`, `countdown`→`countdown`, `climb*`→`ladder`, `rematch:online*`→`waiting`, `mode*`→`lobby` |
| `ladder` | `matched`→`matched`, `mode*`→`lobby` |

Snapshot events are total: from any state, `snapshot:idle`→`lobby`,
`snapshot:waiting`→`waiting`, `snapshot:matched`→`matched`,
`snapshot:countdown`→`countdown`, `snapshot:shoot`→`shoot`.

Notes:

- A `shoot` event arriving in `shoot`/`locked` is upgraded client-side into a
  shortened catch-up window (see the README) instead of being dropped.
- `result` is the only signal that ends a *round*; a `mode`/`rematch:online`
  choice after it returns to the lobby or queue. It ends the *match* only when
  `seriesOver` is `true` — a client that offers "Play Again" on a non-final
  result is offering to abandon a match still being played.
- `result` + `countdown` is how a series plays its next round: a result with
  `seriesOver: false` is followed by the next round's countdown frames. The
  countdown frame carries only the schedule (`n`, `shootAt`, `windowMs`), so
  `enter.countdown` treats a `result` origin as *the same match continuing* — it
  clears the finished round's panel and rematch buttons but keeps the background,
  the opponent slot and the series pips. Rebuilding the screen from the frame
  instead would re-roll the stage and revert the opponent to a generic name,
  which is invisible in round one and wrong in every round after it.
- The series score is drawn as a **pip per round win still needed**, one row
  under each fighter, filled from the left as the wins come in. The rows go up
  empty on `matched` and are `roundsTarget` pips wide because that is what the
  server says, so the client holds no copy of the series rules. There is no
  scoreboard below `roundsTarget: 2`: a match one round long has no running
  tally, and a single pip says nothing the result banner does not. So a
  `roundsTarget` of 1 draws nothing, exactly as a `matched` or a result with no
  `roundsTarget` at all does (a one-round match, or a pre-series server) — the client never
  guesses a width. The pips are module state beside the
  round panel for the same reason the opponent slot is kept: a tally that reset
  with each round would read as the score having been thrown away.
  A reconnect mid-series does not restore the tally — `snapshot:countdown` is a
  schedule, and the score returns with that round's `result`.
- `ladder` is the [arcade ladder](../tasks/closed/arcade-ladder.md)'s tower, the
  run's own screen: the result screen's "next floor" after a decided floor, and the
  lobby's mode entry, both hand over to it. It draws the stored order, and its
  fight button posts the next `POST /cpu`. Nothing
  about it is on the wire — no event, no field, no server-side state — because the
  tower draws the client's own run and the fight it starts is an ordinary CPU
  match. The `matched` edge out of `ladder` is the load-bearing one: the request
  that leaves the tower is a normal match request, so without the edge the client
  would decline the frame answering it and sit on the tower through a match it had
  already been admitted to. There is no `stateIdle` here for the reason there is
  none in `result`: after a floor the match is decided, and before one it has not
  started, so a trailing teardown frame has nothing to reconcile from either
  direction, and routing it to the lobby would walk them off their own ladder.

## Clock handling

`shootAt` and the move timestamps are wall-clock epoch ms. The client
estimates the phone/server clock offset once per connection from the
`connected` frame's `now` field (`skew = now − Date.now()`) and applies it
when computing how much of the PUN window remains, so a skew-delayed delivery
still shows the true server-side remaining time instead of a collapsed one. On
`shoot` it plays out only the remaining `windowMs − ((now + skew) − shootAt)`
and never shows an unwinnable PUN. Win/loss is decided exclusively by server
arrival time; client times are cosmetic.
