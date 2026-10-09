---
phase: 3
depends-on: []
gated-on: []
---

# Buy the countdown a delivery margin

The report was a player going from `MATCH FOUND` straight to **PUN!**, with the
pick window open and no cue that a round began, on a slow mobile link. The
question this file was opened to answer: is the schedule too tight to survive real
delivery latency, leaving a product trade-off about how long the wait before PUN
should be?

## The answer: measured, and no

On the link that reported the symptom, eight consecutive CPU matches each
delivered all three beats plus `shoot` and `result` — no beat lost in any of them
— with arrival spread around 90ms against a 1s beat spacing. The beats were never
late. What was missing was a client that could fail to paint frames it had
already received, which is what
[client-countdown-painter.md](client-countdown-painter.md) turned out to be, and
the symptom is reported gone against that build.

So nothing here gets built, and the table further down stays a design space rather
than a pending decision. What is worth keeping is the reasoning that margin is the
wrong instrument in the first place, independent of this measurement: latency has
no lower bound, so every second of tolerance is a second of pre-PUN wait paid by
everyone to chase a tail that keeps growing, and a game with N players cannot be
corrected per-player. The table is the shape of that trade for whoever hits a link
that genuinely loses beats — on one that does not, widening the lead would only add
waiting.

## The schedule's shape

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

That last sentence is where the reasoning went wrong. Every measurement here is
on the wire, so "the deficit is margin, not correctness" only ever cleared
*transport* — the client's own paint path was not in scope for any of it, and
correctness was assumed rather than checked.

The paint path had a defect, and it produced exactly the reported symptom. It could
blank the countdown *entirely*, not lose a beat: a countdown client that walked one
beat per timer could be walked past its own deadline, because each delay was
measured from the step before it, so one late timer step shifted every later beat
with it, and a stale `clockSkew` sampled once at connect could do the same thing
outright. Either way the count sat blank until **PUN!** with the window open, and
the repeat frames that could have corrected it were dropped as duplicates. It is
fixed in [client-countdown-painter.md](client-countdown-painter.md) and the symptom
is reported gone against that build.

So there was a violated invariant here after all, and it was on the client. The
margin question below was never the live one for this report, which is why nothing
here gets built.

## Measuring it, without a console

`web/diag.html` is served from the same origin and is the way to get this number
from a real player. It opens two throwaway clients, plays one real match against
itself, and reports how many of the three beats each side actually received,
lateness measured against the `ts` every frame already carries. It renders the
countdown by driving `/kxp.js`'s real `countdownPainter`, so what it shows is
what a player sees rather than a recording of it.

This exists because nothing else here can answer the question. The probes see
frames arriving but have no reference to measure delivery against, and there is
no `/ping`. Handing a player a devtools snippet was tried first and is not a
reasonable thing to ask of someone trying to play a game on a phone.

**The number has since been taken on the link that reported the symptom, by a
throwaway script rather than by `diag.html`, and it says there is no deficit to buy
margin against.** Eight consecutive CPU matches against `d6d9899` each delivered
`READY`, `KA`, `CHI`, `shoot` and `result` — no beat lost in any of them. Arrival
spread across every frame of every match was about 90ms, against a beat spacing of
1s, with no frame type arriving later than another. The apparent 2.17s figure is
not latency at all: the same constant offset appears on `matched`, on `result` and
on every beat, which identifies it as the phone's clock running ahead of the
server's, and watching it over 24 fresh connections held it to a 94ms range rather
than a lurch. `clockSkew` absorbs that offset; it is not the missing margin.

So the beats arrive promptly on this link and always did. What was missing was a
client that could fail to paint frames it had already received, which
[client-countdown-painter.md](../closed/client-countdown-painter.md) fixed. The
table below is therefore a design space rather than a pending decision, and it
should stay unbuilt unless a link is measured losing beats — which this one does
not do.

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
- [`latency-profile-visibility.md`](../open/latency-profile-visibility.md) would size the
  margin from real players rather than from one report. It is gated on a `/ping`
  probe, so it cannot be waited on; a per-player margin is out of scope.
- [`externalised-operational-settings.md`](externalised-operational-settings.md)
  if the margin becomes a tuned constant rather than a literal.

## Required context

[protocol.md](../../features/protocol.md) § Why three beats precede PUN, for the
announced schedule and the client-side resolution. The code is `round.go` (the
countdown schedule), `web/kxp.js` (`COUNTDOWN_SLOTS`, `countdownSlot`,
`countdownSchedule`) and `web/app.js` (`planFromCountdown`, the `punTimer` arm).