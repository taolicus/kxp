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

## Landed

`go test -race ./...` is green in CI. It took five pushes — four red, then green —
and the shape of the fix is larger than this file first imagined: the race was not
one pattern in one file but the general rule that **a test must not write anything
a live match reads**, and the engine had five such values, not three.

### What the fix is

- **The pacing is per match.** `shootWindow`, `readyTimeout`, `readyLease`,
  `readyRecheck` and `seriesBreak` are fields on `match`. A test shrinks its own
  match and touches no shared state, which is what the engine's other injectable
  hooks (`now`, `pickMove`, `botThink`) already did.
- **The hub paces the matches it builds.** `Hub.pacing` is a `matchPacing`
  snapshotted at `NewHub`, and `makeMatch` copies it onto each match.
- **`newMatch` reads no package var.** It leaves the pacing fields zero, which
  the `*Or` accessors read as "use the shipped value" — the same fallback
  `clock()` and `botThinkTime()` use for a struct-literal match.

### Why the first three attempts were not enough

Each earlier push was a true statement about a real read and still left one
behind, and the sequence is the evidence for the shape above:

1. **Fields for the three vars this file named.** Sufficient for the tests that
   held their match, and it still spent a CI run: `TestOperationalFlagsSet…`
   writes `shootWindow` through `operationalFlags`, which no field on a match the
   test holds could cover.
2. **`shootWindow` as a field too.** That test writes the package var, and a match
   goroutine read it in `playRound`.
3. **Hub pacing, `newMatch` reading nothing.** The third report was a leftover
   match goroutine from an earlier test re-queueing, building a fresh match
   through `tryMatch`, and reading a var the next test's cleanup had just written
   back — a read from a match no test had a handle on.

### The call sites

The eleven `noSeriesBreak` calls became seven `noSeriesBreak(t, m)` calls on
matches that genuinely pause between rounds, and three `noPacing()` hubs where a
test played a whole CPU series through HTTP and never held the match. Three more
were dropped as no-ops: the two `seriesMatchForTest` helpers and
`TestAPVPMatchCanBeAFirstToThree` drive `judgeRoundAs` directly and never start a
match, so they had nothing to shrink. The `ready*` equivalents are all on
`shortReadyTimeout`/`shortGateTimeout`, except the two `ready_lease_test.go` tests
whose match re-queues, which pace the hub through `twoSided`'s new argument.

### The negative proof

There is no test that reintroduces the racy write, so the acceptance item asking
for one is **not met as written**. What stands in its place is stronger evidence
of the same thing: `-race` failed on four consecutive pushes (`39390815176`,
`39396634152`, `39398392908`, `39400339958`), each naming a different live read,
and passed on the fifth (`39402882216`) with no `-race` test weakened or skipped.
A deliberate racy test would have to be kept in the suite to stay meaningful, and
a permanently-racy test is the thing this task exists to remove.

### One functional regression, caught by the same run

The fourth push was clean of races and failed
`TestReadyTimeoutRequeuesAndExplainsBothSides` instead: shortening only the first
match left the re-paired one on the shipped eight-second gate. It passed on the
phone and failed under `-race`, which is the timing difference and not a
coincidence. `shortGateTimeout` now paces the hub, and `twoSided` takes the
timeout it already applied to the match, so a test whose match can re-queue paces
the thing that builds the replacement.

### Verified

- `go test -race ./...` green in CI run `39402882216`; `test` and `unit` both
  `success`.
- On the phone: `gofmt -l .` clean, `go vet ./...` clean, `go test ./...` ok
  (226.9s), `npm run unit` 222/222, `npm run links` 137 documents / 458 links / 0
  broken.
- The re-queue path was run ten times over (`-count=10`) after the fix, since it
  is the one that failed on timing rather than on a rule.
- Not verified here: the race detector itself, which refuses on android/arm64.
  Every `-race` claim in this record is the runner's.
