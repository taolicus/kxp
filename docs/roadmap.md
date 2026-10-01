# Roadmap

Planned work for KACHIPUN TOURNAMENT, by phase. Checked items are implemented;
unchecked items are open.

## Current priorities

Ordered active work, in the order it should be picked up. **This list is a table
of contents, not a second copy of the status.** Every item below is recorded in
full — with its one status — in the phase named beside it, so there is exactly
one place to tick and one place to read. Land a slice by ticking the checkbox in
its phase; do not restate it here.

Items outside this list — the remaining Phase 1 hardening (anonymous abuse
prevention) — are deliberately postponed until the feature set settles; the
risk is accepted while the game is small-scale. Per-IP rate limiting and
resource limits were landed in the background (Phase 1) and are live: the
public server is kept at the current build by an ops script kept outside this
repo (`git pull` + build + `systemctl restart`).

The protocol rework's Task A (v1.1) has landed and removed the "skip PUN → You
lose" burst-delivery dependency. The remaining reliability slices (stream seq +
replay, `/ping` probe, latency compensation, reconnect recovery, ghost online
count) were defined from unconfirmed connectivity symptoms, so they are **parked
as symptom descriptions** in [docs/issues.md](issues.md) — described, not
scheduled — until the connectivity diagnostics traces (Phase 2) confirm a cause.

1. **Protocol rework (connectivity)** — Task A landed (v1.1). Tasks B (stream
   seq + replay) and C (`/ping` health probe) are parked in
   [docs/issues.md](issues.md) pending cause confirmation. → **Protocol rework
   (active)** below.
2. **Character roster & portraits** — expand the cosmetic fighter roster with
   user-supplied art and an emoji fallback; select-screen polish. → Phase 3.
3. **Best-of-5 game mode** — first to 3 decisive rounds, draws replayed;
   best-of-1 stays the default. Depends on Protocol rework Task A. → Phase 3,
   "Game-mode architecture".
4. **Best-of-5 for PvP** — re-open the ready handshake per round once the client
   machine is proven against the CPU. → Phase 3, "Game-mode architecture" (it
   ships after item 3, CPU first).
5. **Connectivity diagnostics** — confirm, then *diagnose*, the reliability
   symptoms that keep surfacing at the boundary. Ships **surgical and
   incremental**, one trace at a time, each independently deployable; the landed
   traces and the one still waiting are both in Phase 2. The symptoms themselves
   are described — not scheduled — in [docs/issues.md](issues.md), and graduate
   into scheduled work only when their cause is confirmed.
6. **Connectivity-safe scoring** — a no-valid-move timeout resolves as `void`
   (like a draw): no win, no streak break, "No contest" reported, while the
   opponent keeps the round win. → Phase 1.
7. **Busy affordances** — a pending affordance while a request awaits its SSE
   reply, so a long wait reads as "working" rather than silent. → Phase 3.
8. **Core-gameplay e2e** — decided and scoped: three Playwright flows that
   surface game-breaking connectivity failures against the production server.
   Landed. Phase 2 holds the scope and the runner requirements.

## Protocol rework (active)

The reaction opportunity must not depend on burst delivery of a single `shoot`
frame over one unacknowledged SSE stream. Task A shipped and landed that
removal. The remaining B/C slices are parked as symptom descriptions in
[docs/issues.md](issues.md) until the diagnostics slice confirms a cause;
their draft specs remain in protocol.md, "Rework", marked parked.

- [x] **A. Announced deadline + `ts` (v1.1)** — the countdown frame pre-announces
      the round's `shootAt` and the run loop sleeps to the announced schedule
      (KA at S-2s, CHI at S-1s, PUN at S; no re-mint on the shoot frame); the
      client schedules KA/CHI/PUN locally, so a stalled or dropped `shoot` frame
      no longer costs the round (a late `shoot` is advisory; the machine already
      ignores it in the shoot state). `countdown`, `shoot`, `matched`, `result`,
      `waiting` carry a server `ts` (epoch-ms) so delivery lag vs clock skew is
      observable. `connected` snapshots carry the plan when `phase=countdown`
      (only once announced, so a mid-handshake snapshot can't leak a deadline),
      and the `shoot` snapshot keeps `shootAt`/`windowMs` for rejoin. `shootAt`
      is now an `atomic.Int64`, closing a read/write race opened by snapshots
      reading it during countdown. Exercised by `TestCountdownCarriesAnnouncedPlan`,
      `TestSnapshotCarriesCountdownPlan`, and `planRound` unit tests.
- [ ] **B. Sequence numbers + replay (v1.2) — parked (see issues.md)** — SSE
      `id:` per-stream seq with replay after `Last-Event-ID`, snapshot
      fallback past the ring. Draft spec in protocol.md. Speculative fix for
      the stuck-in-`matched` and reconnect-recovery symptoms; cause
      **unconfirmed** — parked in [docs/issues.md](issues.md), entries 1–2;
      graduates only if diagnostics confirm dropped/unrecoverable frames.
- [ ] **C. `/ping` health probe (v1.3) — parked (see issues.md)** — one-way
      latency probe + weak-connection indicator + backout. Draft spec in
      protocol.md. Measurement/fix for the weak-link window shrink; cause
      **unconfirmed** — parked in [docs/issues.md](issues.md), entry 3.

## Phase 1 — Core hardening

Correctness and safety issues that affect reliability on a public server.
Note: the unchecked items below are postponed to keep feature work moving
(see Current priorities).

- [x] **Latency-fair reaction timing** — the *displayed* reaction is
      network-neutral (client click timestamps); win/loss stays
      server-authoritative on arrival time. Spoofed client times are cosmetic.
- [x] **Server-sent PUN window** — each `shoot` event carries `windowMs`; the
      client uses the authoritative, server-determined window for its input
      lock and surfaces `400`/`409` rejections inline instead of silently
      reporting a "Timed out" result.
- [x] **State machine for screen transitions** — pure, table-driven
      `web/machine.js`; invalid edges no-op instead of drifting state. Go
      match phases route through `advance(from, to)` with an explicit edge
      table. Validated by `web/machine.test.cjs` plus Go tests.
- [x] **Mode-aware rematch** — results carry the match `mode`
      (`cpu`/`online`); "Play Again" re-enters the queue (online) or starts the
      next CPU match immediately; "Change mode" returns to the lobby.
- [x] **Phase-aware move validation** — `handleMove` checks `c.match.phase`
      before buffering; rejects with `400` in countdown/done or after the
      deadline.
- [x] **Move channel lifecycle** — stale moves are drained on match end/start
      so a leftover pick never pre-fills the next match.
- [x] **Full-channel drop must error** — a full `c.moves` channel returns
      `409 conflict` instead of `200 {}`.
- [x] **Snapshot phaseDone vs phaseIdle** — `phaseName()` distinguishes `done`
      from `idle` so `snapshot()` can tell "no match" from "match just
      finished".
- [x] **Graceful server shutdown** — signal handling, `http.Server.Shutdown`,
      clean SSE drain.
- [x] **Request timeouts** — `ReadTimeout`/`WriteTimeout`; body size limits via
      `http.MaxBytesReader`.
- [x] **Rate limiting** — per-IP token bucket on the six POST endpoints
      (queue, cancel, cpu, ready, move, character), keyed on `RemoteAddr`;
      over-limit requests get `429` + `Retry-After`. Thresholds sit far above
      any legitimate session (incl. best-of-5 and arcade-ladder bursts);
      `GET /events` exempt.
- [x] **Resource limits** — caps on live clients (`maxClients`, hit in
      `getOrCreate`/`GET /events`), queue length (`maxQueue`, hit on
      `/queue`), and active matches (`maxMatches`, hit on `/cpu`); over-cap
      requests get `503`. Existing clients are never rejected, so the caps
      only bite new growth.
- [ ] **Anonymous abuse prevention** — enforce a max number of anonymous
      clients per IP or time window.
- [x] **Deterministic deadline enforcement** — the run loop drains each side's
      channel when the shoot timer fires (`drainPending`), so an on-time tap is
      never dropped by a scheduler coin-flip; moves after the deadline are
      still rejected by `handleMove` (`400 too late`).
- [x] **Ready-handshake countdown** — a two-player match does not start
      KA/CHI until **both** clients advertise readiness (`POST /ready`,
      re-sent every 2s while matched); a stale `matched` reaching a client on
      the result screen routes to a healthy "match found" state. Non-acking
      pairs are cancelled and the survivor(s) re-queued. CPU matches skip the
      handshake. *(Amended: the gate now covers CPU matches too — see
      "CPU ready gate" below.)* A `shootAt` field in the `shoot` event plus the
      client's clock-skew estimate let the player act for the true remaining
      server window whenever any is left (only a fully closed window shows
      "Waiting for result…").
- [x] **CPU ready gate** — the ready handshake now gates CPU matches, not
      just PvP. The gate is a bitmask over the non-bot sides, so a CPU match
      waits on its one human and `ackReady` ignores a bot bit outright. The
      original rationale ("CPU matches have one human who just clicked, so
      they start immediately") was the gap: the one match with no sync barrier
      was the one that started instantly.

      Considered and **rejected**: inserting a fixed `Ready?` 2s step ahead of
      KA. It does not buy sync — the client does all of its setup in one shot
      when the first `countdown` arrives (`planRound` → arm `punTimer`), which
      is microseconds, so there is nothing incremental to give a slow client
      more time for. It does cost something real: it widens the pre-PUN phase
      from ~3.2s to ~5.2s, and that phase is precisely the window in which a
      drop loses the round outright (see issues.md entry 5). Buying a
      hypothetical benefit with a certain 67% increase in drop exposure. The
      handshake gives the same buffer *verified* rather than hoped-for, and
      self-timed — a slow client waits as long as it needs, a fast one pays
      nothing.

      New failure mode, accepted: a CPU match whose human never acks is now
      cancelled and re-queued after 8s, where before it could not happen. The
      2s ack re-post plus the `pending` snapshot flag (which routes a
      reconnecting client back through `matched` and re-arms its acks) cover
      the realistic cases.

            Verified: `go test ./...` and 38/38 client unit tests green. `-race` is
      **not runnable on this platform** (android/arm64 under Termux), so the
      `ackReady` CAS/close path is hand-checked, not race-checked.

      **The probe suite caught the deploy gap, then mislabelled it.** `t5`, `t6`
      and `t7` drive CPU matches and never sent `/ready` (only `t8`, the PvP
      probe, did). Against the gated server they sat in the handshake for 8s,
      timed out, and never saw a `countdown` — and the harness reported all
      three as `INCONCLUSIVE (link dropped)`, because any frame timeout matched
      the network-error pattern. So the first post-deploy run read as a train
      problem, on a link that was in fact fine: t1–t4 and t8 all passed around
      it. The tell was the 8s duration, matching `readyTimeout` exactly.

      Fixed on both sides. The three probes now ack (t5 asserts the gate is
      *held* before the ack, making it the live regression test for this
      change), and `classify()` now separates a frame withheld on a **healthy**
      stream — `WITHHELD`, a FAIL — from one lost on a broken link. The general
      lesson: a timeout means "did not arrive", and only the stream's own health
      says whether that is the server's doing or the train's. Reporting the
      first as the second is how a contract break hides behind a flaky link.

- [x] **Tell the player *why* a handshake was cancelled** — an expired readiness
      gate was invisible. The client acked with a fire-and-forget
      `post('/ready')` (`web/app.js`) that discards its error, and the requeue
      arrived as a bare `state idle`, so a player whose link was too slow saw
      "match found" and then silently landed back in the queue with no reason.

      Reading the requeue path end to end first turned up a worse bug than the
      missing message: `makeMatch` wired the *same* requeue closure for CPU and
      PvP, so a CPU handshake timeout put the player into the **PvP queue** for a
      human opponent they never asked for. `requeueSide(1)` correctly no-ops for
      the bot, but side 0 never checked the mode. Fixed at the source (the
      closure captures `cpu` and declines to queue), and pinned by
      `TestCPUReadyTimeoutReturnsHumanToLobby`, which asserts the human is *not*
      on the queue — the inverse of the test it replaced.

      The second half was the invisible queue. `requeue` sets `queueing` and
      calls `tryMatch`, but the client was told `state idle`, so a re-queued
      player sat in a lobby that looked idle while the server held them in the
      queue: no Searching view, no Cancel, and re-matched again within the gate
      window. So the teardown frame now carries `reason` and `requeued`, and
      `requeued` is present only when the server actually queued that side.

      **Additive on purpose, and that was not the obvious choice.** Swapping the
      event type for `waiting` would have reused the frame `/queue` already
      sends — but `waiting` has no `matched -> waiting` edge in the client
      machine, and adding it does not help a client that predates the change. A
      tab open across a deploy would strand itself on the game screen with a
      rejected transition. Keeping the frame as `state idle` and adding fields
      means an old client ignores them and behaves exactly as before. The client
      needed one new edge (`matched + waiting = waiting`) to avoid a lobby flash,
      which is safe precisely because the wire format did not change.

      Not scoped, and deliberately: no blame. The server cannot attribute a
      timeout to a player — it observes an ack that did not arrive, which is
      equally consistent with a slow upload, a stalled connection, or a device
      that slept. The copy states the cause it can prove ("Connection wasn't
      ready in time — match cancelled") and never which player was at fault, and
      it must not read as a loss: no `result` is emitted, so nothing is scored
      (pinned by `TestFinishedMatchTeardownCarriesNoReason` and the CPU test).

      Also `readyAbandon` was folded in, as decided: the survivor of an opponent
      disconnect now learns `opponent-left` through the same field.

      *Landed: `abandon`/`requeued` on the engine match, mode-aware requeue in
      `makeMatch`, the reason on the teardown frame, the client notice above
      whichever view is showing, and t5 asserting a finished match's teardown
      stays bare. Verified to fail against the pre-change payload.*

- [ ] **Measure whether 8s is the right readiness budget** — the gate's value is
      unmeasured in both directions, and the current evidence pulls both ways.
      Against it: the `GATE` verdict had to be built at all, which means the
      gate is being hit often enough on one mobile link to distort a whole probe
      run. For it: that is one link and one workload, and the client normally
      acks within milliseconds of the `matched` handler, so a GATE verdict
      measures the train, not the budget. Neither the number nor its
      distribution is known, so nothing can be justified on the present
      evidence.

      Needs two measurements, not a guess: the server-side distribution of
      time-from-`matched`-sent to ack-received, and the client-side round-trip of
      the ack POST itself, over real play rather than a local loopback. Note the
      dependency: the ack round-trip is exactly what the parked `/ping` rework
      (v1.3, "C. `/ping` health probe") is meant to measure properly, and issues.md
      entry 4 is already waiting on it, so this may be cheapest to answer after
      that lands.

      Weigh the result against a cost already documented above, not against an
      ideal: raising the budget widens the pre-PUN phase, and that phase is
      precisely the window in which a drop loses the round outright (issues.md
      entry 5). The same argument that rejected the fixed 2s `Ready?` step
      applies here with more force — a larger 8s does not make the gate wrong,
      but it makes every handshake longer and every drop in it more costly. If
      the data says 8s is too tight, the cheaper fix is likely to be a
      longer/better `matched` payload or a lighter ack, not a longer timer.


- [ ] **Latency compensation — parked (see issues.md)** — one-way delivery
      latency can flatten an on-time reaction into a `400 too late` for
      high-latency players (win/loss stays arrival-time-authoritative; see
      Phase 4 anti-cheat). Cause **unconfirmed** — parked in
      [docs/issues.md](issues.md), entry 3; ships only after the connectivity
      diagnostics slice (Phase 2) measures real pings.
- [ ] **Connectivity-safe scoring** — a no-valid-move timeout resolves as `void`
      (like a draw): no win, no streak break, "No contest" reported, while the
      opponent keeps the round win. Engine + client + leaderboard adopt it.
      **Decided and scheduled.**

      Not a workaround for a lost round — the round genuinely had only one
      valid move, and scoring the absent side as a loss makes a connectivity
      fault indistinguishable from a skill result. Win/loss stays
      arrival-time-authoritative (see Phase 4 anti-cheat); this changes how an
      *absent* side scores, not how a present one is timed. Series mode counts
      a `void` round as a round win for the opposing side (Phase 3,
      "Game-mode architecture"). Pinned today by
      [docs/review.md](review.md) item 56, which records the residual
      no-move path.
- [x] **Stale `state` teardown after a handshake re-pair** — when a PvP ready
      handshake is abandoned, `readyTimeout`/`readyAbandon` re-queue both sides
      and `m.requeue` calls `tryMatch`, which can re-pair the survivor into a
      *new* match before the abandoned match's `m.finish` → `finishMatch` runs.
      `finishMatch` then sent `state {state:"idle"}` to every side of the old
      match **unconditionally**, without re-checking `client.match == m` the way
      it does for the match teardown itself (`server.go:637-642`). The survivor
      could therefore observe `matched` (new match) *then* `state` (stale
      teardown), in either order depending on goroutine interleaving — the two
      frames are emitted within the same millisecond.
      Client impact: the browser reads that trailing `state` as a `stateIdle`
      edge out of `matched` and drops to the lobby while the server still holds
      it in a live match (see the `matched` row in
      [docs/protocol.md](protocol.md)).

      **Fixed.** The teardown frame is now per-side and conditional: only a side
      still in *this* match is told to go idle, decided under `h.mu` because
      `Client.match` is plain state and an unlocked read would be a data race
      (and `-race` cannot run on the arm64 dev device). `drainMoves` stays
      unconditional — that channel is the client's own, and a re-paired client
      must not open its new round on the old round's buffered pick.

      Three unit tests in `finish_test.go` drive the pointer states directly,
      because the live race is order-dependent and a clean probe run is not proof
      of absence: a re-paired side gets no frame, an already-removed side
      (`match == nil`) gets no frame, and the normal path still tells **both**
      sides to go idle — that last one is the guard against over-correcting into
      stranding every finished client. The two bug-catching tests are the
      first and second; the third passes against both servers, since it exists
      to catch an over-correction rather than the original defect.
      *Previously observed via the protocol probe suite's `t8` scenario B,
      roughly 1 run in 7 (order-dependent); `t8` still asserts it as a live
      canary. Not filed in [docs/issues.md](issues.md): that register holds
      symptoms whose cause is unconfirmed, and this one's mechanism was traced.*

- [x] **Monotonic PUN deadline** — the announced deadline is held as a
      `time.Time`, not epoch-ns.

      **Found as a flake, not a reading.** `TestCountdownCarriesAnnouncedPlan`
      failed once across ~9 full runs with `youTimingMs = 13299` — a move that
      arrived ~300ms after the deadline reported as 13.3s late, inside a test
      whose own wall time was 1.21s. That internal contradiction is the
      fingerprint: the test's duration is measured monotonically, so the two
      numbers could not both be right.

      **Mechanism.** `m.shootAt` was stored as `UnixNano` and rebuilt with
      `time.Unix`, which has no monotonic reading. Three judgements in one round
      compare it against a `time.Now()` that *does* have one — arrival timing in
      `resolve`, the KA/CHI/PUN sleeps in `run`, and the `too late` cutoff in
      `handleMove`. `time.Time.Sub` uses the monotonic reading only when both
      operands carry it and **silently falls back to wall arithmetic** otherwise,
      so a device that steps its wall clock mid-round (network change, NTP resync)
      mis-times all three by exactly the size of the step. It was never observed
      on stationary hardware, and the movement that produced it is exactly the
      condition the test could not hold fixed.

      **Fixed** by storing the deadline as a `time.Time` that keeps its monotonic
      reading, set once from `time.Now()` at countdown start. The wire value is
      derived from the same instant via `UnixMilli`, so `shootAt` still reaches
      the client as the same server epoch-ms and protocol/clock-skew handling is
      unchanged. The late cutoff is a real behavioural improvement: a mid-round
      clock step could previously reject an on-time move as `too late`, which is
      the *symptom* of [docs/issues.md](issues.md) 3 — but a distinct
      contributor to it, not that entry's latency hypothesis, and not a
      resolution of it. Issue 3 stays open.

      **Testing.** A clock step cannot be injected, so `monotonic_test.go` pins
      the structural property instead: the stored deadline must retain its
      monotonic reading, which `time.Time.String` renders as a trailing `m=+`.
      That guard was checked to *fail* against the old wall-only form, so it
      cannot silently rot. Two further tests pin the wire value and an ordinary
      arrival judgement. Five consecutive full runs clean. Residual risk: the
      live trigger is unproven, so `t5` remains the live canary.

## Phase 2 — Testing & observability

Make the system testable and debuggable in production.

- [x] **A failing probe keeps its evidence** — three separate places discarded
      the reason a run failed, which is why one intermittent live failure took
      three attempts to diagnose.

      **`run-all` threw the output away.** It pipes each script's stdout, greps
      it for a verdict, and discards the rest — then tells the reader "FAIL means
      the server misbehaved, go and read that output". That output no longer
      existed. A failing script's full log is now printed under the summary.

      **`script()` dropped the checks too.** Worse: a script's reporter lives
      inside the body, so any throw before `rep.print()` discarded every check
      already recorded. The t5 run that started this had already recorded
      `/ready accepted = 400 "no active match"` — which names the cause outright
      — and threw on the next line waiting for a countdown. All of it was lost,
      leaving a bare `WITHHELD: timeout waiting for 'countdown'` and no way to
      tell a server bug from a slow ack. The reporter is now retained and its
      checks printed before any verdict.

      **The verdict itself was wrong.** With the checks visible it was clear the
      server had behaved correctly: the 8s readiness gate expired while the
      client's ack was still in flight, so it requeued the human and sent
      `state idle`. The probe then waited 30s for a countdown that was never
      going to come and reported a *contract break*. A withheld frame is only the
      server's fault when every precondition for it held, so a withheld frame
      following a failed check is now reported as that failure. `WITHHELD` is
      unchanged when all checks pass, which is the missing-`/ready`-ack bug it
      was added to catch — both directions are covered.

      **A distinct `GATE` verdict.** Collapsing the gate expiry into a generic
      failure — or into generic link noise — both lose information, so it is its
      own outcome: `INCONCLUSIVE (ready gate expired — ack slower than the link
      allowed)`, exit 2. A gate expiry is recorded by `expectReadyAck` only for
      the rejection that actually means it (`400 no active match`); every other
      `/ready` rejection stays an ordinary failure, because those *are* the
      server's. `tall` calls the case out separately from other inconclusive runs,
      since it is not merely unjudgeable — a round really was lost to the network.
      Precedence is server failure > gate expiry > pass, so an inconclusive link
      can never mask a defect found in the same run, and it lives in a pure
      `classifyThrow` with tests in both directions. The first version nested the
      gate branch inside a condition unreachable when the verdict was GATE, so a
      real expiry was still reported as a contract break; the live re-check caught
      it after the unit tests had already passed.

      **Server fix found on the way.** The live failure was not a server bug, but
      the adjacent window was: `advance(phaseCountdown, phaseDone)` runs before
      `finishMatch` clears `c.match`, and an ack landing in that window was
      answered `200 {}` — claiming a countdown for a match that will never run
      one. Now `409 ready gate closed`. Checked to fail against the old handler.

- [x] **Deploy identity on `/health`** — the live suite now proves *which* build
      it tested. `/health` reports `build {sha, modified, source}`; `t1` asserts
      it against the local HEAD and fails with a fix hint on absent, unknown,
      mismatched, or dirty.

      **The gap this closed.** The suite points at a deployed origin, and the
      origin reported no version of itself. Every live result was therefore
      conditional on an assumption nobody could check — that the deploy had
      actually happened and restarted. A green suite against a stale binary is
      *worse* than no suite, because it reads as verification. This is the same
      failure shape as the probe origin defaulting to the wrong host earlier in
      Phase 2: a suite that looks authoritative while measuring the wrong thing.
      The suite cannot detect its own misconfiguration, so the check had to be
      explicit and had to run first.

      **No build script.** The identity comes from Go's automatic VCS stamping,
      so a plain `go build -o kxp .` inside the work tree identifies itself with
      no deploy-time discipline to forget. `modified` is reported separately from
      `sha` so a dirty tree cannot masquerade as its commit. `buildSHA` is a
      `-ldflags -X` escape hatch for builds outside a work tree; `go test` does
      not stamp test binaries, so the parser is unit-tested from synthetic
      settings instead, and only a real binary on the deployed origin exercises
      the stamped path end to end.

      **Verified** by building locally and confirming the served sha equals
      `git rev-parse HEAD` byte for byte, and by running `t1` against the
      then-deployed binary — which predates this change — and watching it fail
      with `ABSENT` instead of passing. That negative case is the real proof: the
      check reports a stale build rather than green-lighting it.

- [x] **Timing edge-case tests** — exactly-at-PUN, just-after-PUN,
      at-deadline, and after-deadline boundary cases.
- [x] **Disconnect tests** — `TestPVPDisconnectDuringMatch` disconnects one
      side mid-match and verifies the survivor receives `opponent-left` and
      returns to `state idle`; the client stall-watchdog path is covered by
      the recovery hardening in Phase 1.
- [x] **Simultaneous-move tests** — `TestPVPSimultaneousMove` submits both
      players' moves concurrently and verifies a consistent result with no move
      lost.
- [x] **Game-state transition tests** — `TestAllowedTransitionTable` walks the
      full valid/invalid edge set, with `TestAdvanceRejectsWrongFrom` and
      `TestAdvanceWinsOnlyOnce` covering rejection and idempotency.
- [ ] **CPU determinism hooks** — inject a deterministic clock and move picker
      for automated tests. Protocol rework Task A's schedule-driven run loop
      (`sleep-until` on an announced `shootAt`) is the hook this needs.
- [x] **Connectivity diagnostics — the landed traces** — one slice per trace,
      each independently deployable, producing the evidence the parked
      connectivity symptoms need before any of them can be scheduled against a
      confirmed cause ([docs/issues.md](issues.md), entries 1–5). The causes are
      deliberately **UNCONFIRMED; the slice produces the evidence.** That is the
      whole design — a suite that cannot tell a transport fault from a server
      defect trains you to ignore it, so every trace here exists to make the next
      judgement possible.

      Landed so far: a per-request access log (`accessLog`,
      method/path/status/duration) and an error log at every `handlerError`
      (`kxp: reject <code> "<msg>"`), exercised by `logging_test.go`; client
      join/leave lines carrying the live count; the `/metrics` counter endpoint
      (requests, rejects by code/message, joined/left, dropped events,
      rate-limited, SSE streams, client error beacons by kind, **reaped
      connections**); the `/health` probe; and the client-side error beacon
      (`POST /report`, throttled client-side via `beaconGate`, hooked at SSE
      errors, fetch failures, machine-rejected transitions, stall-watchdog
      fires, and rejoin-past-window).

      **The bounded SSE connection lifetime is in too**: `/events` re-arms a
      short rolling per-write deadline before every frame, so a write that
      stalls against a vanished peer (half-open conn) reaps the connection — the
      client is removed, the online count reconciles down, a `reap client …`
      line joins the `leave online=N` line, and the `reaped` counter moves. TCP
      keepalive (15s) arms at the listener so the OS also notices silent idle
      peers between frames. Each client logs a short **frame journal** (last 16
      event types actually flushed) on leave, so a vanished/reaped device's
      last-seen can be correlated with its reconnect or beacon.

      Still open here: structured (JSON) log output — its own item below.
- [ ] **Structured (JSON) log output** — the diagnostics traces log as
      human-readable lines, which is the right trade for now: the reader is a
      person reading one incident, not a pipeline. Structured output is
      deliberately deferred until something actually consumes it, and
      Protocol rework Task A already adds `ts` to the timed frames, so lag is
      measurable without it. Revisit only if evidence after the rework still
      calls for it.
- [ ] **Latency profile visibility** — the last remaining trace of the
      diagnostics slice, and the one that cannot start yet: profiling latency
      needs a real one-way measurement, which is exactly what the parked
      `/ping` probe (Protocol rework Task C) exists to produce. It graduates to
      its own item when Task C lands; until then there is nothing to profile.
- [x] **Core-gameplay e2e (decided; scoped)** — a small Playwright suite that
      drives the real browser against the **deployed server over the internet**
      to surface **game-breaking connectivity failures that resist unit
      testing**. The suite **never boots the app locally**; a host that can run
      Node >= 20 and Playwright's Chromium is all it needs. Scope is
      deliberately narrow — three flows only, no button/stat/styling
      assertions: (1) a CPU match completes end-to-end within a hard bound with
      zero console/page errors; (2) a PvP match resolves with neither side left
      dead in `matched`/`countdown` (asymmetric-SSE class) — the first
      instance queues and waits **5 seconds** for a real opponent; a real
      pairing is valid and the more valuable case, so it is run as-is, and only
      if none appears is a second instance launched so the two queue against
      each other; (3) reloading mid-match reconciles the client to a live, fair,
      or lobby state — never a dead view stuck on "Waiting for result…". Full
      flows create real matches by design.
      *Landed: `e2e/gameplay.spec.js` + `playwright.config.cjs` +
      `package.json` (`npm run e2e`, `@playwright/test`). `BASE_URL` is
      required and selects the production origin; it fails fast if unset. Keyed
      off a deterministic in-page probe on `renderResult` rather than racing the
      result banner. The runner is device-agnostic: any Chromium-capable host
      runs it.*
- [x] **Protocol-level production probes (browser-free)** — the server needs no
      browser to be exercised: every endpoint is a `POST` plus one `GET /events`
      SSE stream, so a plain Node `fetch` client drives real matches directly.
      Lands the same class of coverage as the Playwright suite on hosts that
      cannot run Chromium at all (the arm64 Android dev device: no Playwright
      browser binaries, and Chromium's dependencies are unavailable there).
      Landed `tools/t1`–`t8` + `tools/lib/harness.mjs` + `tools/README.md`
      (`npm run tall`, `npm run tall -- t5 t6`, `QUICK=1 npm run tall`):
      link characterization, read-only endpoint contracts, character
      round-trip, SSE frame/id/skew contract, a timed CPU match, mid-match
      reconnect + reconciliation, the full rejection-code matrix, and
      self-paired PvP including the abandoned-handshake case.
      The design constraint that matters: verdicts are split into PASS / FAIL /
      INCONCLUSIVE, and an inconclusive verdict always names its reason — link
      dropped, self-rate-limited, or a readiness gate that expired because the
      link was too slow to deliver a `/ready` ack in time — because the suite is
      run over unreliable links and a suite that cannot tell a transport fault
      from a server defect trains you to ignore it. `tall` exits 1 on a real
      failure and 2 on an inconclusive one.
      *Not a replacement for `npm run e2e`: rendering, CSS and in-browser
      console errors remain Playwright-only. Client state machine and server
      internals stay offline (`npm run unit`, `npm run go`). It already earned
      its keep — it traced the stale-teardown race filed in Phase 1 and
      measured the zero-grace drop behaviour recorded in issues.md entry 5.*
- [x] **Automated test workflow** — `go test ./...` target; `go test -race` is not
      runnable on the arm64 Android dev device ("race is not supported on
      android/arm64"), so wire it into CI whenever a suitable host is
      available. Node unit tests run under
      `node --test web/*.test.cjs tools/lib/*.test.mjs`.
      Playwright e2e (`npm run e2e` with a required `BASE_URL`) runs wherever
      Chromium exists; add it to CI on such a host.

## Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [x] **Pure game engine** — `round.go`'s `match` no longer touches `Hub`,
      `Client`, or SSE; sides are neutral `matchParty` and the hub wires
      `finish`/`requeue` callbacks back to real clients.
- [ ] **One owner for match termination** — the engine ends the match; the hub
      only wires. Today `match.run()` advances the phase and records
      `abandon`/`requeued`, then `Hub.finishMatch` decides *per side* whether to
      emit a teardown frame by re-checking `s.match == m` under `h.mu`. That
      re-check exists only because the two lifecycles overlap (a re-pair can
      install a newer match before the old one's `finish` runs), and it is what
      the stale-teardown bug class reduces to. Making the engine the single
      writer — it produces the termination description (per-side `requeued`,
      `abandonReason`, terminal frames) and the hub just applies it to concrete
      clients — collapses two sources of truth into one and retires the
      conditional-teardown branch.

      Shape: `run()` hands its `finish` callback a single termination record
      describing the match instance, so the hub no longer needs to re-derive
      which frames are still valid. `drainMoves()` stays unconditional and in
      the hub — that one is the client's own channel, not the engine's view.

      **Not urgent and deliberately not scheduled.** The current path is
      correct and pinned by `finish_test.go`; this is a structural refactor of
      the finish seam, and the Phase 3 work that actually pays off — series mode
      (below) — has to add per-round termination *on top of* whatever shape this
      takes. Do it in that order, not before, or it is paid for twice.
- [ ] **Dedicated cancellation event instead of additive `state idle` fields** —
      `state {state:"idle", reason?, requeued?}` overloads one frame with two
      meanings: "a match finished" and "this handshake was cancelled". The
      client then has to derive intent from payload and carry a special edge
      (`matched + waiting`, taken only when `requeued` is true) that exists
      purely because of that overload. A dedicated `cancelled {reason,
      requeued}` event would let `state` mean one thing and let the client table
      say it directly.

      **The additive fields were the right call, though** — see the Phase 1
      entry "Tell the player *why* a handshake was cancelled": a pre-existing
      client ignores unknown fields and behaves exactly as before, whereas an
      unknown *event type* is dropped silently and would strand a tab open
      across the deploy on the game screen. So this only becomes worth doing if
      the deploy can guarantee clients refresh, which is currently outside this
      repo (an ops script, `git pull` + build + restart). Park it as a
      post-rework cleanup, and fold in the version handshake it would need: a
      `clientVersion` field on `connected` would let the server emit per-vintage
      frames and would also give the parked seq/replay work a place to hang
      compatibility.
- [ ] **Game-mode architecture** — series-aware `run()`/`resolve()`: a match
      becomes a sequence of rounds, first to 3 decisive wins, draws replayed; a
      round that resolves `void` (no valid move, see Phase 1 "Connectivity-safe
      scoring") counts as a round win for the opposing side.
      `result` gains round/series fields (`round`, `youRoundWins`,
      `oppRoundWins`, `roundsTarget`, `seriesOver`); a round result advances
      the client scoreboard and re-enters countdown, a final result ends the
      series. Ships for CPU matches first (ready stays once-per-series); PvP
      re-opens the ready handshake per round afterward — the two current-priority
      items 3 and 4 are the two halves of this one entry. Builds on the
      Protocol rework Task A schedule, which ships first.
- [ ] **Busy affordances** — show a brief pending/disabled affordance on action
      buttons (Play Online, Instant CPU, rematch, cancel, fighter select, move
      submit) while their request awaits the SSE reply, so a long wait reads as
      "working" rather than silent; a failsafe clears it if the reply never
      comes. Also covers the loading gap while "Waiting for result…".
      **Decided and scheduled.**
- [ ] **Character roster & portraits** — cosmetic expansion of the fighter
      roster (data in `characters.go` + `web/characters.js`; no wire change,
      no gameplay effect). Real art lives at `/img/char/<id>.webp` with an
      emoji fallback (`img.art.missing`); `tools/gen-char.sh` converts
      user-supplied sources from `web/img/sources/char/`. Select-screen polish
      (thumbnails, selected ring, hover).
- [ ] **Player names** — defined model for assignment, validation, and display.
- [ ] **Multiple-tab handling** — deduplicate or isolate sessions from the same
      browser.

## Phase 4 — Public features

Features that depend on identity, persistence, or ranking.

- [ ] **Identity primitive** — decide the player-identity model (a persistent
      anonymous ID is the natural fit) before lobby, leaderboard, challenge
      links, and tournament, since they all share it; the arcade ladder's
      `localStorage` persistence will need retrofit onto it later.
- [ ] **Leaderboard** — server-authoritative with anti-cheat (ignore
      client-submitted timestamps for ranking, cap CPU streaks). A `void`
      connectivity timeout scores like a draw — never a loss.
- [ ] **Leaderboard identity** — persistent player identity model (account,
      token, or anonymous persistent ID).
- [ ] **Lobby / room architecture** — private room creation, joining,
      discovery, and access control.
- [ ] **Send challenge** — a player creates a match and gets a shareable link
      (`/play?challenge=...` or similar) that any guest can open to join that
      specific match directly, bypassing the global queue; the host side shows
      a waiting + cancel state until the challenger joins.
- [ ] **Tournament model** — bracket/round structure for multi-match
      competition.
- [ ] **Solo campaign** — Mortal Kombat–style tower climbing with progression.
      Client-side only: 5-floor ladder against roster fighters, stock bot on
      every floor, boss on the final floor, loss restarts the tower, best
      floor persisted in `localStorage`. Fights run under the mode selector
      (best-of-5 default; draws replayed).
- [ ] **Reconnection — parked (see issues.md)** — a mid-match TCP drop
      instantly forfeits via `opponent-left`, with the dropped player seeing no
      result; resume-vs-grace is undecided and the drop rate is unmeasured.
      Cause/policy **unconfirmed** — parked in [docs/issues.md](issues.md),
      entry 5; re-evaluate once diagnostics measure how often drops actually
      occur.
- [x] **Random fight backgrounds** — each match picks one of five stages at
      random. Implemented client-side: `app.js` keeps a `BGS` roster and
      `randomizeBg()` sets `--bg-anim`/`--bg-static` on the document (the
      animated WebP plus its reduced-motion static frame), so the stage changes
      between fights with no server round-trip.