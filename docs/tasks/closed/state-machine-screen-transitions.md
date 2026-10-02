# State machine for screen transitions

Pure, table-driven `web/machine.js`; invalid edges no-op instead of drifting
state. Go match phases route through `advance(from, to)` with an explicit edge
table. Validated by `web/machine.test.cjs` plus Go tests.
