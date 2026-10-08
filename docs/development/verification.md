# Verification on these hosts

How a change gets checked, and why the gates are shaped this way. The
operational minimum — the commands to run, and what no gate here can verify —
is in `AGENTS.md` ("Verify"), because it applies to every task. This
page is the reference behind it, and earns a read when you are adding a test,
changing what a gate covers, or deciding whether something can be verified here
at all.

For the machines themselves, see [environment.md](environment.md); for which of
them a given task belongs on, see
[device-aware-workflow.md](device-aware-workflow.md).

## The gates

| gate | covers | does not cover |
| --- | --- | --- |
| `npm run links` | internal doc paths resolve, each `#fragment` names a heading that exists | whether a linked document says anything true |
| `gofmt -l .` | formatting | anything behavioural |
| `go vet ./...` | printf misuse, unreachable code, bad struct tags | logic |
| `go test ./...` | server internals, engine, handlers, and the invariants `AGENTS.md` lists | client behaviour, the deployed binary |
| `npm run unit` | client state machine, countdown arming, snapshot reconciliation, probe harness | rendering, CSS, console errors |
| `npm run tall` | the deployed server over real SSE and HTTP | anything this machine cannot observe |

`npm run unit` is the catch-all for client and harness tests, and the gate column
above mirrors the run list in `AGENTS.md` ("Verify") — adding a gate means adding
it in both places. Name the script, not the files it globs: the shorter
`node --test web/kxp.test.cjs web/machine.test.cjs` form misses
`web/app.countdown.test.cjs`, which is the test that runs the real `app.js` source
against a stubbed context — see [the gap probes cannot close](#the-gap-probes-cannot-close)
below. Both `README.md` and `docs/features/architecture.md` prescribed that
shorter form until this commit, which is the shape of drift a link checker cannot
see: a path in prose is not a path.

## Run the gates the way a phone can finish them

`go test ./...` carries no wall-clock estimate in `AGENTS.md` — deliberately.
The phone is a phone and it moves ([environment.md](environment.md)): thermal
throttling, other apps, FUSE shared storage, and the network load it differently
from run to run, so a number would be true on the day it was measured and a lie
the next. Measured on the day this section landed, the same warm suite finished
one run and exceeded a fifteen-minute tool timeout on the run after — the
variance is the fact.

The rule that survives the variance is how the gate is *run*, not how fast it
is. Standalone step with an ample tool timeout; never chained behind another
gate with `&&`; never piped through a pager. A paged run hides progress, so
"slow" reads as "hung" and invites the one action that makes it worse — killing
it restarts the whole compile while the machine is already loaded. A genuinely
hung test is still bounded: each Go package invocation carries Go's own
`-timeout` (10 minutes by default), so waiting until that fires is a decision,
not a guess. Short slices keep the loop tight with `go test -run <Name> ./...`
and run the full suite once, at the end.

The habit is worth keeping on the laptop, where none of this pressure applies:
the constraint there is availability rather than load
([device-aware-workflow.md](device-aware-workflow.md)).

## The gap probes cannot close

Protocol probes assert on frames arriving over the wire. A bug in `app.js` that
re-arms a timer incorrectly, or paints a beat that is overwritten in the same
tick, is invisible to both `go test` and `t1`–`t8`: the server sent the right
frames, and the probe has no browser.

That gap is why `web/app.countdown.test.cjs` and `web/app.reconnect.test.cjs`
drive the real `app.js` source against a stubbed context instead of
reimplementing client logic in the test. Reimplementing it would test the copy.
Both load the same `web/appHarness.cjs`, which is where the stubbed clock, the
hand-fired timer queue and the recording state machine live: a harness copied per
test file is a second copy that drifts, which is the failure the docs registers
were reorganised to remove. If you touch client logic, add a client-behaviour test
— the probe suite will not catch it for you.

Rendering, CSS, and in-browser console errors have **no** automated coverage
anywhere in this repo. The Playwright e2e suite that would have covered them was
withdrawn; the reasoning and what a browser-level suite would require are in
[automated-test-workflow.md](../tasks/closed/automated-test-workflow.md). This
is a known, recorded gap, not an oversight — treat a rendering claim as
hand-checked and say so.

## Why there is no `tests/` directory

Tests sit beside the code they test, and for the Go suite that is a toolchain
requirement rather than a preference. All 21 `_test.go` files are `package main`,
and so are all 8 non-test `.go` files: the tree contains exactly one Go package,
at the root. `package main` cannot be imported at all, so a `tests/` directory
would force every test file into a package that cannot see the code under test —
and the external-test-package form (`package main_test`) is required by the go
tool to live in the *same directory* as the package it tests, so it is not a way
out either. That matters here more than it would elsewhere, because a lot of this
suite is deliberately internal: `finish_test.go` drives match pointer states
directly because the live race is order-dependent and cannot be reproduced
reliably, `state_test.go` and `snapshot_test.go` reach through `c.mu` and `h.mu`,
and the whole reason `go test -race` being unavailable does not block those tests
is that they assert by driving the state rather than by racing two goroutines.
Relocating them would trade that for nothing.

The JavaScript side could move — `node --test` takes any path — but would gain
nothing and lose the adjacency that matters: `web/appHarness.cjs` loads `app.js`
by path from beside it, and the client-behaviour tests exist precisely to run the
real source.

Test files are a large share of this repo's text, and the answer to that is the
working agreement in `AGENTS.md` — the landing commit names the one that matters,
and the bodies are not read as a sweep. It has never been a reason to move them.

## Why browser-free probes

The integration path is `t1`–`t8` in `tools/`: Node scripts that speak the real
protocol against a deployed origin. No browser, no DOM, no Playwright — which is
what makes the suite runnable on the machine in
[environment.md](environment.md) at all. Landed in `6a154fc`.

The design constraint that matters more than the absence of a browser is the
verdict taxonomy: **PASS / FAIL / INCONCLUSIVE**, where an inconclusive verdict
always names its reason — link dropped, self-rate-limited, or a readiness gate
that expired because the link was too slow to deliver a `/ready` ack in time.

The suite runs over unreliable links. A suite that cannot tell a transport fault
from a server defect trains you to ignore its output, which is worse than having
no probe at all. `tall` exits 1 on a real failure and 2 on an inconclusive one,
so the two are distinguishable from a script. Do not "fix" an INCONCLUSIVE into a
FAIL: an inconclusive link must never be allowed to mask a defect found in the
same run.

It has already earned its keep — it traced the stale-teardown race filed in
Phase 1, and measured the zero-grace drop behaviour recorded in
[docs/issues/drop-loss.md](../issues/drop-loss.md).

## Why a failing probe keeps its evidence

`run-all` originally threw the output away. It piped each script's stdout,
grepped it for a verdict, and discarded the rest — then told the reader "FAIL
means the server misbehaved, go and read that output". That output no longer
existed.

Worse, `script()` dropped the checks too: a script's reporter lived inside the
body, so any throw before `rep.print()` discarded every check already recorded.
The `t5` run that started this had already recorded
`/ready accepted = 400 "no active match"` — which names the cause outright — and
threw on the next line waiting for a countdown. All of it was lost, leaving a
bare `WITHHELD: timeout waiting for 'countdown'` and no way to tell a server bug
from a slow ack. The reporter is now retained and its checks printed before any
verdict. Landed in `02047ff`.

**The verdict was wrong too, and the visible checks are what showed it.** With
them on screen it was clear the server had behaved correctly: the 8s readiness
gate expired while the ack was still in flight, so it requeued the human and sent
`state idle`. The probe then waited 30s for a countdown that was never coming and
reported a contract break. A withheld frame is only the server's fault when
every precondition for it held — so a withheld frame following a failed check is
now reported as that failure. `WITHHELD` is unchanged when all checks pass, which
is the missing-`/ready`-ack bug it was added to catch. Both directions are
covered.

**`GATE` is its own verdict.** Collapsing a gate expiry into a generic failure,
or into generic link noise, both lose information, so it is neither:
`INCONCLUSIVE (ready gate expired — ack slower than the link allowed)`, exit 2.
A gate expiry is recorded by `expectReadyAck` only for the rejection that
actually means it (`400 no active match`); every other `/ready` rejection stays
an ordinary failure, because those *are* the server's. `tall` calls the case out
separately, since it is not merely unjudgeable — a round really was lost to the
network. Precedence is server failure > gate expiry > pass, in a pure
`classifyThrow` with tests in both directions.

The first version nested the gate branch inside a condition unreachable when the
verdict was `GATE`, so a real expiry still reported as a contract break. The unit
tests passed anyway; the live re-check caught it. Worth remembering when a
classification looks obviously right.

## The traces that make live diagnosis possible

A probe can only assert what it observes, so what the server records matters as
much as what the probe checks. Landed across the connectivity-diagnostics series
— `ba66922`, `5694980`, `7eec97c`, `a50628d`:

- a per-request access log (`accessLog`: method, path, status, duration) and an
  error log at every `handlerError` (`kxp: reject <code> "<msg>"`), exercised by
  `logging_test.go`
- client join/leave lines carrying the live online count
- `GET /metrics`: requests, rejects by code and message, joined/left, dropped
  events, rate-limited, live SSE streams, client error beacons by kind, and
  **reaped** connections
- `GET /health`, which reports `build.sha` — `t1` asserts it against local `HEAD`
  and fails loudly on a stale binary, because a green probe run against a stale
  build reads as verification and is not
- the client-side error beacon (`POST /report`), throttled client-side via
  `beaconGate`, hooked at SSE errors, fetch failures, machine-rejected
  transitions, stall-watchdog fires, and rejoin-past-window

**The bounded SSE connection lifetime** is part of this: `/events` re-arms a
short rolling per-write deadline before every frame, so a write that stalls
against a vanished peer (a half-open connection) reaps it — the client is
removed, the online count reconciles down, a `reap client …` line joins the
`leave online=N` line, and the `reaped` counter moves. TCP keepalive (15s) arms
at the listener so the OS also notices silent idle peers between frames. Each
client logs a short **frame journal** (the last 16 event types actually flushed)
on leave, so a vanished or reaped device's last-seen can be correlated with its
reconnect or beacon.

Still open here: structured (JSON) log output.

These traces are why [docs/issues/](../issues/) can hold a hypothesis rather than
a guess. An entry graduates when a measurement distinguishes its candidate causes,
and most of the measurements available are ones the server chose to emit.