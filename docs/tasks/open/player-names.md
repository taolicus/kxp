---
phase: 3
depends-on: [identity-registry]
gated-on: []
---

# Player names

A defined model for assignment, validation, and display.

## Blocked on

[identity-registry](../closed/identity-registry.md) — names have to attach to whatever
identifies a player, and the arcade ladder's existing `localStorage` names are
per-browser rather than server-side.
