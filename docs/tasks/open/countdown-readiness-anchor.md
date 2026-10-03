---
phase: 3
depends-on: []
gated-on: []
---

# Make the countdown deadline adapt to the slowest side

> **Now partly superseded.** The human half of this has shipped -- readiness is a
> tap, not an automatic ack (see [protocol.md](../../features/protocol.md) § Why
> readiness is a tap), so the deadline hangs off a person rather than
> off a network ack that only proved bytes arrived. That fixes the absent-player
> case. The remaining half is the adaptive lead below, which is still needed for
> the slow-but-present link -- the tap bounds the anchor, it does not remove the
> round trip between the tap and the countdown.

## Why margin alone cannot be the answer

The obvious fix is to announce the countdown further ahead. It does not scale,
and the reason is structural rather than a matter of picking a bigger number:
latency has no lower bound, so every margin added is wait paid by everyone to
chase a distribution whose tail keeps growing. A game with N players cannot be
corrected per-player. Diagnosis first, arithmetic second.

The structural statement: **a fixed schedule cannot survive an unbounded delay.**
The lead before PUN is whatever we choose, and delivery latency eats it from the
front one second per second. The only two things that work are (a) letting the
schedule adapt per round, or (b) anchoring the deadline to something slower than
the network. This task is (a); the human ready-tap discussed below is (b).

## Why the existing handshake is not already the fix

Worth being explicit, because it looks like the reordering is already there. It
is: `matched` is sent, the client acks `/ready` from the end of its handler, and
only then does the server set `shootAt = ackTime + countdown` and send the first
countdown frame. So the countdown is already sent after the ack and already has
a full `countdown`-length of lead.

That lead is exactly the countdown length, and that is the whole defect. Widening
it only lengthens the thing being lost.

## The circularity, and how this breaks it

The server cannot know the countdown will land before it has sent it, and it
cannot send `shootAt` before it has decided `shootAt`. So the server needs an
acknowledgement *for the countdown itself*, and that means the deadline has to
be announced in two steps: first without one, then with.

```
matched ──▶ countdown {shootAt: null}   prepare   ──▶ client ──▶ /ready
server: both prepared → shootAt = now + countdown ──▶ countdown {shootAt}
```

`shootAt` is set from the server clock at the instant the *prepare* acks land,
so the countdown then always has a full-length lead regardless of how slow the
delivery was. The slow side's round starts later instead of losing its countdown.

## What to build

- A `countdown` frame with no `shootAt`, meaning "prepare, acknowledge this". It
  is the existing event type carrying an absent field, not a new event type, so a
  tab open across the deploy survives — see the additive-wire invariant.
- The client acks it with the existing `/ready` endpoint. If the ack must be
  distinguishable from the match ack, that is a new decision, not an assumption
  to bake in.
- The server sets `shootAt` once both sides have prepared, and never re-mints it.
  The "announced, not recomputed" property in
  [protocol.md](../../features/protocol.md) survives this: there is still exactly
  one `shootAt`, both clients judge the same instant, and the deadline is still
  server-authoritative.
- The prepare phase needs its own timeout, reusing the `readyTimeout` shape, and a
  handshake that stalls here must cancel exactly as it does today — cancelled,
  never silently lost, with the teardown `state` frame saying why.

## Costs and open decisions

- **One extra round trip per round.** On a good link that is a small tax on every
  match; on a 3s link it is 3s of extra waiting before the countdown even
  begins. The trade is a longer, predictable wait instead of a missing countdown.
  Whether that is acceptable for the fast majority is the open question, and it is
  a product call.
- **Server must wait for the slowest side**, so a lagging player delays the round
  for both. Bounded by the prepare timeout, but it is a fairness cost.
- **Should the human be the anchor instead?** Every synchronous game anchors on a
  human action rather than a network ack, because human reaction dwarfs latency.
  A ready-tap would make the anchor trivially slow, and would additionally
  distinguish "bytes reached the browser" from "a person is looking at it" — which
  is the real failure on a phone, where the app can be backgrounded with the
  network perfectly healthy. This changes how a match starts, so it is not a
  silent part of this task.
- **Interaction with the client-generated ack.** `/ready` is sent automatically
  from the `matched` handler, so today it proves only that bytes arrived. If that
  remains true for the prepare ack, the adaptive lead fixes late delivery but not
  an absent player, and the two symptoms stay conflated. Worth deciding whether
  the ack should require the document to be visible.

## Required context

[protocol.md](../../features/protocol.md) § Why three beats precede PUN and
§ Cancelled handshakes. [architecture.md](../../features/architecture.md) § Timing
model. The code is `round.go` (the countdown schedule and the ready handshake),
`web/app.js` (`planFromCountdown`) and `web/kxp.js` (`planRound`, which already
returns null without a plan, so a deadline-less frame is inert rather than
destructive).

[countdown-margin.md](countdown-margin.md) is the shallow version of this and
becomes redundant if this lands; its measurement section stays useful either way.