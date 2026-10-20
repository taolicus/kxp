---
phase: 2
depends-on: []
gated-on: []
---

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

## Where this stopped (deferred to the laptop)

**Not started.** This is a concurrency change and the phone cannot race-check it
— `go test -race` refuses on android/arm64 — so per
[device-aware-workflow.md](../../development/device-aware-workflow.md) it is
deferred rather than half-done here. Everything below is what was established by
inspection, so the laptop session can begin at the fix.

**The diagnosis is confirmed from the stack, not guessed.** The full report is in
CI run `39410641914`, job `test`, step `go test -race ./...`. Reproduce with
`go test -race -run TestSSEFrameJournalLoggedOnLeave ./...` on the laptop; the
pair of goroutines is `finishMatch → sendEv → logDroppedEvent → log.Printf`
(writer) against `TestSSEFrameJournalLoggedOnLeave → buf.String()` (reader). The
writer's goroutine was created in an earlier test, through
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

**Acceptance on the laptop:** the fix must be argued against `h.mu` and the
phase atomics, then proven by a green `go test -race ./...` — and the
`docs/issues/` rule applies: this is a traced mechanism, so it lands as a fix,
not parked as a symptom.

