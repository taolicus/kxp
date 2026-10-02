---
priority: 6
phase: 2
depends-on: [externalised-operational-settings]
gated-on: []
---

# CPU determinism hooks

Inject a deterministic clock and move picker for automated tests.

Protocol rework Task A's schedule-driven run loop (`sleep-until` on an announced
`shootAt`) is the hook this needs.

## Notes

- Depends on [externalised-operational-settings](externalised-operational-settings.md):
  an injected clock is only reachable if the timing values are already injectable
  rather than package constants.
- `go test -race` cannot run on this host (`race is not supported on
  android/arm64`), so determinism hooks are the substitute for the concurrency
  coverage the race detector would otherwise give, not an addition to it.
