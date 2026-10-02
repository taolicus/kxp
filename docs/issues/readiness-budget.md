# Is 8s the right readiness-gate budget?

An open question, not an observed symptom: the gate's value is unmeasured in both
directions, so nothing about it can be justified on the present evidence.

**Question** — is the 8s `ready` handshake budget correct, and if not, should it
be longer, or is the cheaper fix a lighter ack?

**Why it is open** — the evidence pulls both ways and neither side is a
measurement.

- Against 8s: the `GATE` verdict had to be built at all, which means the gate is
  being hit often enough on one mobile link to distort a whole probe run.
- For 8s: that is one link and one workload, and the client normally acks within
  milliseconds of the `matched` handler, so a `GATE` verdict measures the train,
  not the budget.

Neither the number nor its distribution is known.

**Evidence that would settle it** — two measurements, not a guess:

1. the server-side distribution of time-from-`matched`-sent to ack-received, and
2. the client-side round-trip of the ack POST itself,

both over real play rather than a local loopback.

**Context that must survive the answer** — this is an investigation, so the
reasoning below is the part worth keeping.

The measurement is blocked on the `/ping` rework (protocol v1.3), which is what
is meant to measure the ack round-trip properly; see
[`window-shrink`](window-shrink.md), whose prospective fix already records it.
That makes this cheapest to answer after that lands rather than before.

Weigh the result against a cost already documented, not against an ideal:
raising the budget widens the pre-PUN phase, and that phase is precisely the
window in which a drop loses the round outright — see
[`drop-loss`](drop-loss.md). The same argument that rejected the fixed 2s
`Ready?` step applies here with more force: a larger 8s does not make the gate
wrong, but it makes every handshake longer and every drop inside it more costly.

So if the data says 8s is too tight, the cheaper fix is likely a
longer-or-lighter `matched` payload, not a longer timer.

**Prospective fix (not scheduled)** — none until the two distributions exist.
Whatever they show, the timer itself is the last thing to change.