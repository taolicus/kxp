# Disconnect tests

`TestPVPDisconnectDuringMatch` disconnects one side mid-match and verifies the
survivor receives `opponent-left` and returns to `state idle`; the client
stall-watchdog path is covered by the recovery hardening in Phase 1.
