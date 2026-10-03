# Features

Durable knowledge about the system as it now stands. One file per subject, named
for the subject rather than for the task that produced it.

This is not a work-item register. Nothing here has a status, nothing here moves
when work lands, and per [workflow.md](../../workflow.md) a task is never moved
into this directory — when completed work establishes durable knowledge, the
knowledge goes here and the work record stays in
[docs/tasks/closed/](../tasks/closed/).

The rationale for how something works belongs *in* the file that describes it,
not beside it. A rejected alternative you would otherwise re-litigate — why the
deadline is a `time.Time`, why there is no fixed `Ready?` step — is a paragraph
under the invariant it constrains, in the present tense, closing with the commit
that landed it. That is the same **file** as the knowledge, not a second copy of
it.

- [architecture.md](architecture.md) — the engine and its invariants: round
  timing, matchmaking, the state machine, SSE lifecycle, and what the tests
  cover.
- [protocol.md](protocol.md) — the wire format: events, endpoints, the client
  state table, and clock handling. Read this before changing anything a client
  sees.
- [character-selection.md](character-selection.md) — the data-driven fighter
  roster, and how to add a fighter.
- [backgrounds.md](backgrounds.md) — the match background asset pipeline.

One thing about this tree that is deliberately *not* here:

- **[docs/development/](../development/)** is durable, but it describes the
  development host and the verification gates rather than the implemented
  system.
