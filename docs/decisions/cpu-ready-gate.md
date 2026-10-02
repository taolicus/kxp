# CPU ready gate

Landed. Status and summary live in the closed-task file
**[cpu-ready-gate.md](../tasks/closed/cpu-ready-gate.md)** (Phase 1). This
file holds the rationale: what was considered, what was rejected, and
why.

Considered and **rejected**: inserting a fixed `Ready?` 2s step ahead of
KA. It does not buy sync — the client does all of its setup in one shot
when the first `countdown` arrives (`planRound` → arm `punTimer`), which
is microseconds, so there is nothing incremental to give a slow client
more time for. It does cost something real: it widens the pre-PUN phase
from ~3.2s to ~5.2s, and that phase is precisely the window in which a
drop loses the round outright (see [docs/issues/drop-loss.md]). Buying a
hypothetical benefit with a certain 67% increase in drop exposure. The
handshake gives the same buffer *verified* rather than hoped-for, and
self-timed — a slow client waits as long as it needs, a fast one pays
nothing.

New failure mode, accepted: a CPU match whose human never acks is now
cancelled and re-queued after 8s, where before it could not happen. The
2s ack re-post plus the `pending` snapshot flag (which routes a
reconnecting client back through `matched` and re-arms its acks) cover
the realistic cases.

Verified: `go test ./...` and 38/38 client unit tests green. `-race` is
**not runnable on this platform** (android/arm64 under Termux), so the
`ackReady` CAS/close path is hand-checked, not race-checked.

**The probe suite caught the deploy gap, then mislabelled it.** `t5`, `t6`
and `t7` drive CPU matches and never sent `/ready` (only `t8`, the PvP
probe, did). Against the gated server they sat in the handshake for 8s,
timed out, and never saw a `countdown` — and the harness reported all
three as `INCONCLUSIVE (link dropped)`, because any frame timeout matched
the network-error pattern. So the first post-deploy run read as a train
problem, on a link that was in fact fine: t1–t4 and t8 all passed around
it. The tell was the 8s duration, matching `readyTimeout` exactly.

Fixed on both sides. The three probes now ack (t5 asserts the gate is
*held* before the ack, making it the live regression test for this
change), and `classify()` now separates a frame withheld on a **healthy**
stream — `WITHHELD`, a FAIL — from one lost on a broken link. The general
lesson: a timeout means "did not arrive", and only the stream's own health
says whether that is the server's doing or the train's. Reporting the
first as the second is how a contract break hides behind a flaky link.
