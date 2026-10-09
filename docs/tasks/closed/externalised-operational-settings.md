# Externalised operational settings

`-addr` (`main.go:23`) is the only flag; every other operating value is a
compile-time constant or package `var` — `shootWindow` (`round.go:11`),
`readyTimeout` (`round.go:30`), `sseWriteDeadline` (`server.go:43`),
`maxBodyBytes` (`server.go:18`), the rate-limit defaults (`ratelimit.go:13`).
An operator who needs a different value therefore has no route to one short of a
rebuild and restart, and tuning has to be a code change rather than a config
change.

Carried over from the retired review checklist, where it was the only item not
already implemented, documented elsewhere, or tracked here.

## Decided and scheduled

Decide flag vs env; keep today's values as the defaults; and keep the engine
reading one authoritative value, since a second source of timing truth is the
failure the monotonic deadline already had to be fixed for (see "Monotonic PUN
deadline" in the Phase 2 rationale, and [cpu-determinism-hooks](../open/cpu-determinism-hooks.md)
below).

## Why

Reducing the operational surface to one knob is what makes the rest of this repo
reproducible: today no two installs are running the same timing values, and a
reported symptom has to be interpreted against "whatever this build compiled in".

## Landed

Flag vs env decided as **flags**, and the listed values are now settable.

**What changed.** `main.go` gains `operationalFlags`, called before
`flag.Parse()`, binding seven flags to the package vars themselves:
`-shoot-window`, `-ready-timeout`, `-sse-write-deadline`, `-max-body-bytes`,
`-rl-capacity`, `-rl-refill-per-sec`, `-rl-max-entries`. To make the binding
possible, `shootWindow` (`round.go`), `maxBodyBytes` (`server.go`) and the three
rate-limit defaults (`ratelimit.go`) moved from `const` to `var`; `readyTimeout`
and `sseWriteDeadline` were already vars. The `MaxBytesReader` call took an
`int64(maxBodyBytes)` conversion, which is the only call-site change.

**One authoritative value, not a flag beside a constant.** Each flag's default
is the var's own value (`flag.DurationVar(&shootWindow, "shoot-window",
shootWindow, …)`), so the default and the runtime value are the same storage and
cannot drift; `main` sets them before any goroutine or the hub exists, and the
engine and `NewHub` read the var directly.

**Flags, not env.** `-addr` is already the repo's one runtime choice, so flags
keep one input route. An env layer would need its own precedence rule against
the flag or reintroduce the duplicate-timing-source problem this task is about.
Recorded in [architecture.md](../../features/architecture.md) § Operational
settings, which also lists the values deliberately left compiled in —
`readyLease`/`readyRecheck` and `countStep`/`countdownSlots` are the client
contract, and the resource caps bound the process's own memory.

**Verified to fail against the old code.** The feature is new, so the old tree
has no `operationalFlags` and the test cannot compile against it; to prove the
test pins behaviour rather than just the new symbol, two mutations were checked:
binding `-shoot-window` to a throwaway var made
`TestOperationalFlagsSetTheValuesTheGameReads` fail (`shootWindow = 2s, want
3s`), and hardcoding `200.0` in `NewHub`'s limiter made
`TestNewHubReadsTheRateLimitVars` fail. Both reverted.

**Verified green.** `gofmt -l .` clean, `go vet ./...` clean, `go test ./...`
passes (`settings_test.go` adds the two tests). Phone host: no `-race` here, but
this slice only moves startup-time assignment of package vars, all before any
goroutine starts, so there is no concurrent access to reason about.
