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
`clockSkew` is sampled once at connect and never re-derived, so a phone whose wall
clock stepped between the snapshot and the round counted against a reading that was
no longer true. One bad measurement produced a "time until PUN" of tens of
seconds, which armed a single long timer and left nothing that could re-check it:
the count sat blank until **PUN!** with the pick window still open and every frame
delivered on time. `countdown-margin.md` had already ruled out transport for this
symptom — frames measured spaced 1s apart, within tens of milliseconds of the
server's own send `ts` — so the remaining candidates were on the client, and this
was one of them.

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

Not verifiable on this host: whether a phone's wall clock actually stepped during
the rounds that prompted this. The harness demonstrates that a step blanks the
countdown and that the painter survives one; it cannot say how often the step
happens, and the frame that would confirm it is one this host does not capture.

→ rationale: [protocol.md](../../features/protocol.md), [countdown-margin.md](../open/countdown-margin.md)