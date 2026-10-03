---
phase: 3
depends-on: []
gated-on: []
---

# Buy the countdown a delivery margin

A player on a slow mobile link goes from `MATCH FOUND` straight to **PUN!**,
with the pick window open and no cue that a round began. The cause is traced and
pinned by a test; what is left is a product trade-off about how long the wait
before PUN should be.

## Confirmed mechanism

`round.go` announces `shootAt` three seconds ahead and sends `READY` at *that
same instant*, so the lead before the deadline equals the countdown length and
there is no margin past it. Delivery latency therefore eats the countdown from
the front, one beat per second:

| first frame late by | beats painted |
|---|---|
| 0–1s | `READY` `KA` `CHI` |
| 1–2s | `KA` `CHI` |
| 2–3s | `CHI` |
| ≥3s | none — `MATCH FOUND` → **PUN!** |

The cliff is exact at `msUntilPun <= 0` and pinned by
`web/app.countdown.test.cjs` ("loses exactly one countdown beat per second of
first-frame delay", plus the negative direction: a client that misses the whole
countdown still reaches `shoot` and still gets the PUN cue).

The client is **not** at fault. `countdownSlot` (`web/kxp.js`) deliberately
reports no beat once `msUntilPun <= 0`, because painting one there would flash a
beat with no time behind it. Once the client knows `shootAt` it paints the
schedule on its own timers, so the only fragile step is learning `shootAt` in
time.

## Ruled out, so it is not re-litigated

- **Stale deploy.** `/health` on the reported host reports `61acb80`, which
  contains every earlier countdown fix.
- **Proxy coalescing or backlog drops.** Measured on a real PvP match: `READY`,
  `KA` and `CHI` each arrived within ~50ms of the server's own send `ts`, spaced
  1s apart as sent. Frames are not being batched.
- **The lost-frame dedupe guard / late-frame filter.** Both are deployed and both
  work; they are not what produces the missing beats.

So the deficit is margin, not correctness. Nothing here is a bug in the sense of
a violated invariant, which is why this is a task rather than an issue.

## Measuring it, without a console

`web/diag.html` is served from the same origin and is the way to get this number
from a real player. It opens two throwaway clients, plays one real match against
itself, and reports how many of the three beats each side actually received,
lateness measured against the `ts` every frame already carries. It renders the
countdown by driving `/kxp.js`'s real `countdownSchedule`, so what it shows is
what a player sees rather than a recording of it.

This exists because nothing else here can answer the question. The probes see
frames arriving but have no reference to measure delivery against, and there is
no `/ping`. Handing a player a devtools snippet was tried first and is not a
reasonable thing to ask of someone trying to play a game on a phone.

## The trade-off

Margin is bought with seconds before PUN, one for one. The budget before the
window opens is the resource; the question is how to split it between beats and
margin:

| option | total before PUN | beats | tolerance |
|---|---|---|---|
| today | 3s | 3 | 0s |
| A | 4s | 3 | 1s |
| B | 5s | 3 | 2s |
| C | 3s | 2, 500ms apart | 1s |
| D | 6s | 3 | 3s |

The reported link needs ≥3s, so only D restores a full three-beat countdown
there, and it does it by making everyone wait six seconds. **This is the open
input and it is a product decision, not a technical one** — the magnitude is not
implied by the diagnosis. What is specified is the mechanism: the server sends
the schedule announcement ahead of the first beat, and every client schedules
against the announced `shootAt` as it already does today.

Worth noting for whoever sizes it: adding the announcement early needs **no
client change and no wire change**. A `countdown` frame arriving before its
first beat is already handled — the client arms its chain from the plan and
paints `READY` when that beat comes due. The frames are additive, so a tab open
across the deploy survives.

## Open questions

- Is a longer `MATCH FOUND` wait actually a cost, or neutral? If neutral, a
  straightforward margin beats option C's re-spacing.
- Is a three-beat countdown worth protecting at this latency, or would two beats
  that always arrive be worth more than three that mostly do not?

## Related

- [`window-shrink.md`](../../issues/window-shrink.md) is the sibling symptom on
  the same fixed timeline: latency there eats the *pick window*, here it eats the
  *countdown cue*.
- [`latency-profile-visibility.md`](latency-profile-visibility.md) would size the
  margin from real players rather than from one report. It is gated on a `/ping`
  probe, so it cannot be waited on; a per-player margin is out of scope.
- [`externalised-operational-settings.md`](externalised-operational-settings.md)
  if the margin becomes a tuned constant rather than a literal.

## Required context

[protocol.md](../../features/protocol.md) § Why three beats precede PUN, for the
announced schedule and the client-side resolution. The code is `round.go` (the
countdown schedule), `web/kxp.js` (`COUNTDOWN_SLOTS`, `countdownSlot`,
`countdownSchedule`) and `web/app.js` (`planFromCountdown`, the `punTimer` arm).