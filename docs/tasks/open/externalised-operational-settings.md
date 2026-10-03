---
phase: 1
depends-on: []
gated-on: []
---

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
deadline" in the Phase 2 rationale, and [cpu-determinism-hooks](cpu-determinism-hooks.md)
below).

## Why

Reducing the operational surface to one knob is what makes the rest of this repo
reproducible: today no two installs are running the same timing values, and a
reported symptom has to be interpreted against "whatever this build compiled in".
