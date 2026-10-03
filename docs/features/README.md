# Features

Durable knowledge about the system as it now stands. One file per subject, named
for the subject rather than for the task that produced it.

This is not a work-item register. Nothing here has a status, nothing here moves
when work lands, and per [workflow.md](../../workflow.md) a task is never moved
into this directory — when completed work establishes durable knowledge, the
knowledge goes here and the work record stays in
[docs/tasks/closed/](../tasks/closed/). If a file here needs a "why did we do it
that way" answer, that lives in [docs/decisions/](../decisions/) and is linked
from the relevant feature file.

- [architecture.md](architecture.md) — the engine and its invariants: round
  timing, matchmaking, the state machine, SSE lifecycle, and what the tests
  cover.
- [protocol.md](protocol.md) — the wire format: events, endpoints, the client
  state table, and clock handling. Read this before changing anything a client
  sees.
- [character-selection.md](character-selection.md) — the data-driven fighter
  roster, and how to add a fighter.
- [backgrounds.md](backgrounds.md) — the match background asset pipeline.

Two things about this tree that are deliberately *not* here:

- **[docs/environment.md](../environment.md)** is durable, but it describes the
  development host rather than the implemented system.
- **[docs/decisions/](../decisions/)** is durable, but it records why a decision
  was made, which is history rather than a description of what the code now
  does.