# A failing probe keeps its evidence

Landed. Status and summary live in the roadmap entry under
**Phase 2 — Testing & observability** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

**`run-all` threw the output away.** It pipes each script's stdout, greps
it for a verdict, and discards the rest — then tells the reader "FAIL means
the server misbehaved, go and read that output". That output no longer
existed. A failing script's full log is now printed under the summary.

**`script()` dropped the checks too.** Worse: a script's reporter lives
inside the body, so any throw before `rep.print()` discarded every check
already recorded. The t5 run that started this had already recorded
`/ready accepted = 400 "no active match"` — which names the cause outright
— and threw on the next line waiting for a countdown. All of it was lost,
leaving a bare `WITHHELD: timeout waiting for 'countdown'` and no way to
tell a server bug from a slow ack. The reporter is now retained and its
checks printed before any verdict.

**The verdict itself was wrong.** With the checks visible it was clear the
server had behaved correctly: the 8s readiness gate expired while the
client's ack was still in flight, so it requeued the human and sent
`state idle`. The probe then waited 30s for a countdown that was never
going to come and reported a *contract break*. A withheld frame is only the
server's fault when every precondition for it held, so a withheld frame
following a failed check is now reported as that failure. `WITHHELD` is
unchanged when all checks pass, which is the missing-`/ready`-ack bug it
was added to catch — both directions are covered.

**A distinct `GATE` verdict.** Collapsing the gate expiry into a generic
failure — or into generic link noise — both lose information, so it is its
own outcome: `INCONCLUSIVE (ready gate expired — ack slower than the link
allowed)`, exit 2. A gate expiry is recorded by `expectReadyAck` only for
the rejection that actually means it (`400 no active match`); every other
`/ready` rejection stays an ordinary failure, because those *are* the
server's. `tall` calls the case out separately from other inconclusive runs,
since it is not merely unjudgeable — a round really was lost to the network.
Precedence is server failure > gate expiry > pass, so an inconclusive link
can never mask a defect found in the same run, and it lives in a pure
`classifyThrow` with tests in both directions. The first version nested the
gate branch inside a condition unreachable when the verdict was GATE, so a
real expiry was still reported as a contract break; the live re-check caught
it after the unit tests had already passed.

**Server fix found on the way.** The live failure was not a server bug, but
the adjacent window was: `advance(phaseCountdown, phaseDone)` runs before
`finishMatch` clears `c.match`, and an ack landing in that window was
answered `200 {}` — claiming a countdown for a match that will never run
one. Now `409 ready gate closed`. Checked to fail against the old handler.
