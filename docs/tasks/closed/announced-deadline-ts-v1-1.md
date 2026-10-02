# A. Announced deadline + `ts` (v1.1)

The countdown frame pre-announces the round's `shootAt` and the run loop sleeps
to the announced schedule (KA at S-2s, CHI at S-1s, PUN at S; no re-mint on the
shoot frame); the client schedules KA/CHI/PUN locally, so a stalled or dropped
`shoot` frame no longer costs the round (a late `shoot` is advisory; the machine
already ignores it in the shoot state). `countdown`, `shoot`, `matched`,
`result`, `waiting` carry a server `ts` (epoch-ms) so delivery lag vs clock skew
is observable. `connected` snapshots carry the plan when `phase=countdown` (only
once announced, so a mid-handshake snapshot can't leak a deadline), and the
`shoot` snapshot keeps `shootAt`/`windowMs` for rejoin. `shootAt` is now an
`atomic.Int64`, closing a read/write race opened by snapshots reading it during
countdown. Exercised by `TestCountdownCarriesAnnouncedPlan`,
`TestSnapshotCarriesCountdownPlan`, and `planRound` unit tests.
