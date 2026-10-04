# The countdown re-derives from the clock instead of stepping once per beat

The countdown display used to be a generator walked one beat per timer, and the
walk stopped being able to correct itself. Each delay was measured from the step
before it, so anything a runtime did to a timer accumulated down the chain; and
because the chain was built once, from the first `countdown` frame, the later
frames — which all carry the same `shootAt` and were therefore dropped as
duplicates — could never re-derive it. `countdownPainter` replaces it: a pure
stepper that reports the beat due now and how long until that could change, with
the caller re-checking on a timer it owns.

**The failure it removes is not a lost beat, it is a blank countdown.** Measured on
the harness, the old chain painted `["READY","KA","CHI"]` normally and
`["CHI"]` when the three frames landed 500ms before PUN — the graceful degradation
the schedule is designed around. But a clock reading wrong painted `[]`, and
`clockSkew` is sampled once at connect and never re-derived, so a phone counting
against a reading no longer true produced a "time until PUN" of tens of seconds.
That armed a single long timer and left nothing able to re-check it: the count sat
blank until **PUN!** with the pick window still open and every frame delivered on
time, then dropped as a duplicate. `countdown-margin.md` had already ruled out
transport for this symptom — frames measured spaced 1s apart, within tens of
milliseconds of the server's own send `ts` — so the remaining candidates were on
the client, and this was one of them.

**Which of the two triggers actually fired was never isolated, and the doc records
that rather than picking the tidier story.** A wrong clock is what the harness
reproduces, so it is the one the tests pin, but a *late timer step* is the likelier
cause on a phone and needs no exotic premise at all: each delay was measured from
the step before it, so one step firing late shifted every later beat with it, and
three ordinary main-thread stalls compound inside a three-second lead. Measuring
the link afterwards argued against both being about latency — eight consecutive
CPU matches delivered all three beats plus `shoot` and `result`, with arrival
spread around 90ms against 1s beats, and the phone's clock a steady ~2.17s ahead
of the server's rather than one that lurched. So the fix is worth having because it
covers both mechanisms, not because one of them was proven.

Two properties do the work. The wait before the first beat is **capped**
(`SLOT_CAP_MS`) rather than trusted, so a wrong reading is re-read within a second
instead of waited out. And repeats are **no longer dropped**: every frame
re-derives, which is invisible because a label is reported only when the beat
actually changes, and keeping one stepper per round preserves that memory across
re-arms. Skew is read per check rather than captured at build time, so a client
that re-reads it on reconnect is not still counting against the old value.

**`kxp.js` had to stay pure, and that is worth stating because it is invisible
until it breaks.** The first attempt put the whole loop — timers included — in
`kxp.js`, and the client tests hung: `appHarness.cjs` injects the *host realm's*
module as `ctx.KXP`, so a `setTimeout` inside it lands on the real event loop,
outside the queue the harness steps. That is precisely why the old code was a
generator yielding steps for the caller to schedule. The split now is explicit —
`countdownPainter` decides, the caller schedules — and it is also what lets
`web/diag.html` paint its countdown with the same code the game does instead of
modelling it separately. A diagnostic that modelled the old walk would have kept
reporting a failure mode the game no longer has.

Verified: `npm run unit` (107; `web/kxp.test.cjs` 42, `web/app.countdown.test.cjs`
6), `go test -count=1 ./...`, `npm run links`, `gofmt`, `go vet`. The regression
was checked to fail against the old chain restored verbatim — it and the
re-arm contract test both fail there while all four pre-existing countdown tests
still pass, so the new tests bite on the change rather than on the rewrite. Removing
the cap alone fails the `kxp.js` unit test that pins it.

Not verifiable on this host: which trigger fired in the rounds that prompted this.
The harness demonstrates that a wrong clock blanks the countdown and that the
painter survives one, and the follow-up measurement rules out a latency shortfall —
but neither can watch a phone's main thread stall, so the compounding case rests on
the code rather than on a captured instance. It is reported fixed by the player
against `d6d9899`, which is evidence about the outcome and not about the
mechanism.

→ rationale: [protocol.md](../../features/protocol.md), [countdown-margin.md](countdown-margin.md)