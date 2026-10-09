# CPU determinism hooks

Inject a deterministic clock and move picker for automated tests.

Protocol rework Task A's schedule-driven run loop (`sleep-until` on an announced
`shootAt`) is the hook this needs.

## Notes

- Depends on [externalised-operational-settings](../closed/externalised-operational-settings.md):
  an injected clock is only reachable if the timing values are already injectable
  rather than package constants.
- `go test -race` cannot run on the phone (`race is not supported on
  android/arm64`), so there the determinism hooks are the substitute for the
  concurrency coverage the race detector would otherwise give, not an addition
  to it. On the laptop the detector runs
  ([environment.md](../../development/environment.md)) and is worth running
  alongside.

## Landed

The clock half already existed: `match.now` (with `fakeClock` in
`ready_lease_test.go`) was added for the readiness lease, and
[externalised-operational-settings](../closed/externalised-operational-settings.md)
had already put the timing values in vars. What was missing was the move: the CPU
opponent picked with `randomMove()` and stamped its arrival from `time.Now()`,
neither of which a test could pin.

Added two hooks on `match`, set in `newMatch` with a struct-literal fallback:

- `pickMove func() Move` (default `randomMove`)
- `botThink func() time.Duration` (default `defaultBotThink`, the shipped
  50–349ms jitter)

`botAction` now reads both through `botMovePick`/`botThinkTime` and stamps
`arrive` from `m.clock()`, so an injected match clock and a zero think time make
a bot round wholly deterministic. The countdown and shoot-deadline timers stay on
`time.NewTimer`: they are the round's announced schedule, not the CPU's, and
tests already shape them by shrinking `seriesBreak` and driving the state
pointers directly.

Verified with `cpu_determinism_test.go` (`go test -run ... .` ok): the bot's move
and arrival come from the injected hooks, and a struct-literal match still falls
back to a valid random move and the jitter window. Proved to bite by reverting
`botAction` to `MoveRock`/`time.Now()`, which failed both assertions (move
`rock` ≠ `scissors`; arrival was wall time against the fake clock).
