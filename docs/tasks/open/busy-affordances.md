---
priority: 4
phase: 3
depends-on: []
gated-on: []
---

# Busy affordances

Show a brief pending/disabled affordance on action buttons — Play Online, Instant
CPU, rematch, cancel, fighter select, move submit — while their request awaits the
SSE reply, so a long wait reads as "working" rather than silent.

A failsafe clears the affordance if the reply never comes. Also covers the
loading gap while "Waiting for result…".

**Decided and scheduled.**
