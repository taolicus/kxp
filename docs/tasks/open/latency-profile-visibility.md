---
priority: 11
phase: 2
depends-on: []
gated-on: [reconnect-loss, window-shrink]
---

# Latency profile visibility

The last remaining trace of the diagnostics slice, and the one that cannot start
yet: profiling latency needs a real one-way measurement, which is exactly what the
parked `/ping` probe (Protocol rework Task C) exists to produce. It graduates to
its own item when Task C lands; until then there is nothing to profile.

## Why it is not an issue

"Cannot start yet" names the work and the shape of the work, so it fails
`workflow.md`'s test for an issue: it is not a question about what to build, it is
a specified build whose prerequisite is parked. The prerequisite itself is an
issue —
[`/ping` health probe](../../issues/reconnect-loss.md) is recorded as the
prospective fix for two symptoms in
[docs/issues/reconnect-loss.md](../../issues/reconnect-loss.md) and
[window-shrink.md](../../issues/window-shrink.md) — and that is where the gate
is visible. This task points at it so the ordering survives.

## Notes

- Gated on the diagnosis, not just on Task C: if the traces land and the
  connectivity symptoms turn out to be transport faults, this trace is measuring
  the wrong thing and should be re-derived rather than unblocked.
