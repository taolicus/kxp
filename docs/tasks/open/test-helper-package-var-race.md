---
phase: 2
depends-on: []
gated-on: []
---

# The test helpers race on the package vars they shrink

CI's first `go test -race ./...` run failed, and the report is a real race — in
the test harness, not the server. `series_test.go`'s `noSeriesBreak` writes the
package-level `seriesBreak` (and restores it from `t.Cleanup`) while a match
goroutine started by a *different* test is still running and reading it.

## Mechanism (traced from the CI report, not hypothesised)

```
WARNING: DATA RACE
Write at 0x000000df5998 by goroutine 548:
  kxp.noSeriesBreak()            series_test.go:19
  kxp.finishCPUSeries()          integration_test.go:186
  kxp.TestCPUIntegration()       integration_test.go:245

Previous read at 0x000000df5998 by goroutine 561:
  kxp.(*match).judge()           round.go:921
  kxp.(*match).closeRound()      round.go:825
  kxp.(*match).playRound()       round.go:817
  kxp.(*match).run()             round.go:662
  kxp.(*match).start.gowrap1()   round.go:609
```

`m.start()` (`round.go:609`) does `go m.run()`. Nothing joins that goroutine
before the test returns, so a match still parked in the between-rounds pause is
still inside `m.wait(seriesBreak)` (`round.go:921`) when the next test's
`noSeriesBreak` writes the var, or when the previous test's `t.Cleanup` restores
it. The race report repeats against several distinct test pairs
(`integration_test.go:245`, `:600`, and others), which is the signature of a
harness-wide pattern rather than one bad call site.

`seriesBreak` is one of at least three package vars with the same shape:
`readyLease` (`round.go:42`) and `readyRecheck` (`round.go:45`) are documented as
"a package var so tests can shorten it" and follow the identical
save-overwrite-restore pattern. Any test that shrinks one while another test's
match is running is the same race.

**It is not a production defect.** Nothing writes these vars outside tests; in a
running server they are set once at init and read forever after. The fix is
confined to the test harness, and saying so is the point — a reader who finds
this by its title should not go looking for a live concurrency bug in `round.go`.

## The build

Make the shrinking not mutate shared state, or make the mutation safe. The
candidates, in rough order of preference:

- **Inject the pacing instead of overwriting the var.** These values are already
  read at one or two sites each; a `match` field (filled from the package
  default by `newMatch`, overridable in a test) removes the shared state rather
  than synchronising it. This is the shape the pure-engine refactor already
  established, and it needs no test-visible globals at all.
- **Make them atomics.** `atomic.Int64` nanoseconds, or a
  `sync/atomic`-friendly type, with the tests storing and restoring through it.
  Smaller diff, but it keeps the mutable global and only papers over the causal
  problem: a test still leaves a value changed while another test's goroutine
  reads it, and `t.Cleanup` restoring it mid-read remains a legal interleaving
  even if it is no longer a *race*.
- **Join the match goroutine before the test ends.** A `t.Cleanup` that waits
  for `m.run()` to return would close the window, but only for matches a test
  holds a handle to, and only if every such test remembers — the pattern that is
  already duplicated eleven times across `series_test.go`, `ready_test.go` and
  `integration_test.go`.

## Constraints

- **The fix must not weaken what the suite asserts.** These vars are shrunk so
  tests reach a second round without waiting out three real seconds; whatever
  replaces that has to keep the reachable states reachable.
- **Test-only change.** Production behaviour, timing, and the wire format are
  untouched. If a fix requires a production signature to change (the injection
  option would), that is still a test-enabling refactor of the engine, not a rule
  change, and the engine's own tests are the check.
- **All three vars, or the pattern is only half-fixed.** `seriesBreak`,
  `readyLease` and `readyRecheck`; a fix for one that leaves the other two is
  the same race with a different name.

## Acceptance

- `go test -race ./...` passes in CI, and the negative direction is pinned: a
  test that deliberately calls `noSeriesBreak` (or its successor) while a
  started match is running must fail the race detector rather than pass by luck.
  Until that exists, the green run only says it did not happen *this* time.
- The eleven `noSeriesBreak` call sites and the `ready*` equivalents are
  accounted for — moved to the new mechanism, or deliberately kept with the
  reason written down.
- No claim is made on the phone: `-race` refuses on android/arm64
  ([environment.md](../../development/environment.md)), so this task is verified
  by pushing and reading the CI run. That is now possible only because CI landed,
  which is why this is a follow-up to it rather than work done alongside.
