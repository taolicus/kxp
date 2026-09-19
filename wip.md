# WIP notes — game backgrounds + minor work log

## Backgrounds (naming scheme: <name>.webp / <name>-static.webp / <name>.gif)
- pool  (799x242, 58fr):        webp 356K + static 40K + gif 272K (~668K)
- forest (639x480, 19fr):       webp 408K + static 40K + gif 688K (~1.1M)
- tomb  (639x480, 160fr -> every 4th): webp 824K + static 40K + gif 1.4M
  (~2.3M, WEBP_QUALITY=65)
- arena  (636x479, 27fr):       webp 636K + static 44K + gif 944K (~1.6M)
- portal (636x479, 54fr -> every 2nd): webp 528K + static 24K + gif 1.3M
  (~1.85M)
- Game screen picks one at random per match (app.js BGS list).
- Script knobs: MAX_SOURCE_FRAMES/SAMPLE_FPS/SAMPLE_STEP/WEBP_QUALITY env overrides.
  Auto-sampling kicks in above 90 source frames; SAMPLE_STEP also forces
  sampling below the threshold. Loop duration is preserved.

## Notes
- Sources live in gitignored `web/img/sources/`.
- Exec bit can't be set on external storage; run `bash tools/gen-ani-bg.sh`.
- No `fps` normalization in the script (it trimmed the loop tail); encoders
  preserve the source's variable frame delays exactly.

## Minor work log
- Flavor A deadline determinism: run loop drains each side's channel when the
  shoot timer fires (round.go drainPending/takeFirst), so an on-time tap is
  never dropped by the channel-vs-timer scheduler coin-flip. Added
  TestDrainPendingCountsBufferedMove / TestDrainPendingLeavesEmptyChannelAsTimeout.
  README: ticked Deterministic deadline enforcement, Game-state transition
  tests, Random fight backgrounds; added unchecked "Latency compensation"
  Phase 1 item for a future server-side grace window.
- Ready-handshake countdown (slow-network "You lost" on Play Again):
  PvP matches wait for both clients' POST /ready (re-sent every 2s while in
  the new machine 'matched' state) before KA/CHI; stale matched-in-result
  routes to 'matched' instead of a doomed window; pending timeouts/disconnects
  cancel and re-queue (readyTimeout var, 8s). CPU skips the handshake. shoot
  event now carries shootAt; the client skips a PUN whose window already
  closed and waits for the result. Server: ackReady/bothReady/needsReady/
  waitReady/readyTimeout/readyAbandon in round.go, handleReady + snapshot
  pending in server.go, /ready route in main.go. Tests: TestPvPReadyGate,
  TestCPUStartsWithoutReady, TestReadyAbandonOnLeaveRequeuesSurvivor,
  TestReadyTimeoutRequeuesBoth; ack injection in all PvP tests;
  machine.test.cjs 'matched' gate cases.