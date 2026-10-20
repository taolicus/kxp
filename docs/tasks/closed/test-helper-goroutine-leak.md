# The tests leak match goroutines, and `captureLog` is what catches it

CI's `-race` step failed on a docs-only commit (`39410641914`) with a data race
between `TestSSEFrameJournalLoggedOnLeave` and a match goroutine belonging to an
*earlier* test. This is the second family of test-harness race CI has found —
the first is [test-helper-package-var-race.md](../closed/test-helper-package-var-race.md),
which fixed the *pacing* leak. This one is the goroutine leak that fix left
standing.

## Required context

- [architecture.md](../../features/architecture.md) — the match lifecycle: a
  `match` is started by the hub, runs its own goroutine, and calls back into
  `finishMatch` when it ends.
- [verification.md](../../development/verification.md) § the third runner — why
  `-race` is CI's alone, and that this host cannot run it.

## The mechanism

`startMatchLocked` (`server.go`) calls `m.start()`, which does `go m.run()`
(`round.go`). Nothing in the tests waits for that goroutine. When a match ends —
or when a test abandons one — `m.run`'s deferred `m.finish()` runs
`h.finishMatch` → `sendEv` → `logDroppedEvent` → `log.Printf`.

`captureLog` (`logging_test.go`) redirects the *package-level* `log` output to a
plain `bytes.Buffer` and hands the test that same buffer. A goroutine from a
previous test writing to `log` while the current test calls `buf.String()` is a
race on the buffer — which is exactly the reported stack:

```
Write at … by goroutine 2088:      logDroppedEvent → sendEv → finishMatch → match.run.func1
Previous read at … by goroutine 2109:  TestSSEFrameJournalLoggedOnLeave → buf.String()
```

Two separate defects, and both matter:

1. **The leak.** A test that calls `makeMatch` (or drives `/cpu`) leaves a live
   match goroutine running after the test returns. Only `shutdown_test.go` calls
   `h.Shutdown()`; the other ~48 `makeMatch` call sites do not.
2. **The unsynchronised sink.** `captureLog`'s buffer is read by the test and
   written by any live goroutine, with nothing ordering the two. That is what
   turns any late write into a `-race` failure rather than a harmless stray log
   line.

Fixing only (2) hides (1): the goroutine would still outlive its test and could
race on real hub state next. Fixing only (1) leaves (2) as a trap for the next
background goroutine someone adds.

## Acceptance criteria

- `captureLog`'s buffer is safe to read while a background goroutine writes it.
- A test that starts a match does not leave that match running past the test.
  The mechanism is stated in the commit and pinned by a test, not just applied.
- `go test -race ./...` is green in CI across repeated runs, not once.
- The tests still assert what they asserted: no assertion is weakened to make a
  race go away.

## Where this stopped (superseded — see the correction below)

**Correction, and the reason this file changed after being written.** It said
this was "deferred to the laptop" because the phone cannot run `-race`. That was
wrong, and the very CI run that found this race is the disproof: CI ran
`go test -race ./...` on a hosted runner and produced the report below. CI runs
`-race` on every push, so the phone does not need the laptop to race-check a
concurrency change — it needs to push. The deferral premise is corrected in
[device-aware-workflow.md](../../development/device-aware-workflow.md).

The consequence here: **this task is not blocked on any device.** It is ordinary
work that a phone session can start, with CI as the `-race` verdict rather than a
laptop.

**Not started**, but for an ordinary reason rather than a device one: it is a
second, separate slice from the browser fixture it was discovered alongside, and
each slice here lands on its own.

**The diagnosis is confirmed from the stack, not guessed.** The full report is in
CI run `39410641914`, job `test`, step `go test -race ./...`. Reproduce with
`go test -race -run TestSSEFrameJournalLoggedOnLeave ./...` — on a host that can
run it, which now means the laptop or CI, not the phone. The pair of goroutines
is `finishMatch → sendEv → logDroppedEvent → log.Printf` (writer) against
`TestSSEFrameJournalLoggedOnLeave → buf.String()` (reader). The writer's
goroutine was created in an earlier test, through
`makeMatch.func1 → tryMatch → startMatchLocked → match.start` — i.e. the match
was built by a *different* test and is still running.

**The two defects, located:**

1. **The leak.** `startMatchLocked` (`server.go:929`) calls `m.start()`, and
   `m.start()` (`round.go:683`) does `go m.run()` at `:685`. Nothing joins that
   goroutine. `m.run`'s defer calls `m.finish()` (`round.go:694`), which is
   `h.finishMatch` (wired at `server.go:918`), which logs. `h.active`
   (`server.go:218`) already counts matches — incremented `server.go:930`,
   decremented `server.go:937` — so the bookkeeping exists; what is missing is a
   *blocking* join. Only `shutdown_test.go` calls `h.Shutdown()`; the other ~48
   `makeMatch` call sites do not. Note `m.requeue` (`server.go:914`) spawns a
   further `go h.tryMatch()` that can build and start a *new* match, so a leaked
   match can spawn its successor — this is how an earlier test's match outlives
   several later ones.

2. **The unsynchronised sink.** `captureLog` (`logging_test.go:12`) points the
   package-level `log` at a plain `bytes.Buffer` and returns that same buffer.
   Callers only ever call `.String()` (`sse_lifetime_test.go:118,169`,
   `beacon_test.go:36,91`), so a mutex-guarded writer that offers `String()` is
   drop-in. This is the reason a late write is a `-race` failure rather than a
   harmless stray line, and it is what makes the leak visible anywhere.

**A rejected option, recorded so it is not re-tried.** Making only `captureLog`
safe would turn this CI run green and hide the leak: the goroutine would still
outlive its test and would race on hub state the next time a test reads it
unlocked. The leak is the defect; the sink is the detector.

**What blocks the obvious fixes, to save the next reader the search.**

- A `sync.WaitGroup` on the hub fails on its own: a match that never ends never
  decrements, so `Wait()` would hang. `h.active` is decremented only by
  `finishMatch`, so it has the same shape as a `WaitGroup` but no guarantee of
  reaching zero.
- `m.run` does not observe `h.down` — the engine deliberately knows nothing
  about the hub's context (`round.go` has no `h.` field at all), so a shutdown
  signal cannot simply be threaded into the loop without breaking the
  engine/hub boundary that `AGENTS.md` lists as load-bearing.

**Acceptance:** the fix must be argued against `h.mu` and the phase atomics, then
proven by a green `go test -race ./...` — which CI produces on the push. Because
the race is intermittent, one green run is weak evidence; the proof is a green
`-race` step across several pushes, or a run of `go test -race ./...` on the
laptop if it is to hand. The `docs/issues/` rule also applies: this is a traced
mechanism, so it lands as a fix, not parked as a symptom.

## Landed

Both defects fixed, in `server.go`, `round.go` and the test helpers.

**The wait is bounded by cancel, and the join makes it a join.** `Hub.Shutdown`
now cancels the clients taking part in every match the hub started, then waits
on a `sync.WaitGroup` incremented in `match.start` and decremented in `run`'s
deferred block. Cancelling *clients* rather than `h.down` is what preserves the
engine boundary this file named as the blocker: `round.go` still never sees the
hub's context, and every engine select already watches `leftCh` (derived from
`client.alive`), so a match parked in `waitReady` or in its shoot window leaves
by the ordinary departure path with no new hook. Hub shutdown is expressed to
the engine as "everyone left at once".

**`h.running` is the mapping the engine cannot hold.** `matchParty` deliberately
carries no `Client`, so the hub keeps `map[*match][2]*Client`, written in
`startMatchLocked` (and by the test helpers) and deleted in `finishMatch`. An
early draft cancelled `h.clients` instead; the full suite then hung for the whole
ten-minute package timeout with a match parked in `playRound`, because a test
builds matches from clients it never registered with the hub. That hang is the
reason the mapping exists, and it is why the naive fix is recorded here rather
than left to be re-tried.

**`startMatchLocked` refuses to start once `h.down` is cancelled.** This is what
makes the Add-before-Wait ordering hold: `m.requeue` spawns a `tryMatch` that can
still be waiting on `h.mu` when `Shutdown` takes it, and a start after `Wait`
began is `sync: WaitGroup is reused before previous Wait has returned` — a panic,
not a failure. The guard sits at the single point every start passes through, and
the client cancels happen under the same lock, so a start either completes before
the stop is visible or is refused.

**`captureLog` is a mutex-guarded sink** (`logSink` in `logging_test.go`), which
this file called defence in depth and still is: the leak is closed at its source
by `stopHub`, and the sink closes the trap for the next background goroutine.

**What was verified, and how.** On the phone: `gofmt -l .` clean, `go vet ./...`
clean, `go test -count=1 ./...` ok (210s), `npm run unit` 222/222, `npm run
links` 138 documents / 471 links / 0 broken. The phone cannot run `-race`, so per
[device-aware-workflow.md](../../development/device-aware-workflow.md) CI is the
verdict here rather than the laptop.

**The race verdict, repeated.** `go test -race ./...` green in **six** CI jobs
across three triggers on the identical tree (`e2da3fe`): two `push` runs, and
`push` + `pull_request` for each of two empty commits branched from it. The
step list of run `39464592193` confirms step 7 is `go test -race ./...` and
`success` — not skipped. The temporary PR used to produce the repeats is closed
and its branch deleted.

**The negative proof, and it is two separate negatives.** `shutdown_test.go`
gains `TestHubShutdownJoinsRunningMatch`, checked to *fail* against each half of
the fix independently:
- Drop `h.Wait()` → `Shutdown returned before the match goroutine exited; it
  did not join`.
- Drop the client cancel → `Shutdown took 29.95s with a 30s gate; it did not
  wake the match`.

Getting the second one to bite needed the observation hook placed *first* in
`run`'s deferred block, before the counter is decremented: a hook after `Done`
can run after `Wait` has already returned, which is exactly what the test exists
to disprove, so the first draft passed for the wrong reason.

**A note on the test-side change.** `makeMatch` requires `h.mu` and every test
called it bare — harmless until it began registering matches, at which point the
registration itself would have been a fresh race. Rather than teach forty call
sites about the lock, tests now go through `startMatch`/`startBuiltMatch`, which
take it; `stopHub(t, h)` registers a `t.Cleanup` that calls `Shutdown`, so a
test that fails partway is covered too. Every test that creates a hub and starts
a match calls it — checked by scanning the test sources, not by eye.

**Still unverified here.** `npm run e2e` does not run on the phone (no
Chromium); CI's `browser` job ran it green in each of the six runs above, which
is the only coverage that claim has.


