---
phase: 2
depends-on: []
gated-on: []
---

# Structured (JSON) log output

The diagnostics traces log as human-readable lines, which is the right trade for
now: the reader is a person reading one incident, not a pipeline. Structured
output is deliberately deferred until something actually consumes it, and
Protocol rework Task A already adds `ts` to the timed frames, so lag is
measurable without it.

**Revisit only if evidence after the rework still calls for it.**
