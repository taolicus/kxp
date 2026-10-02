# Game-state transition tests

`TestAllowedTransitionTable` walks the full valid/invalid edge set, with
`TestAdvanceRejectsWrongFrom` and `TestAdvanceWinsOnlyOnce` covering rejection
and idempotency.
