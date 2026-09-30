# Roadmap

Planned work for KACHIPUN TOURNAMENT, by phase. Checked items are implemented;
unchecked items are open.

## Current priorities

Ordered active work. Items outside this list — the remaining Phase 1
hardening (anonymous abuse prevention) — are deliberately postponed until the
feature set settles; the risk is accepted while the game is small-scale.
Per-IP rate limiting and resource limits have been landed in the background
(see Phase 1) and are live: the public server is kept at the current build by
an ops script kept outside this repo (`git pull` + build + `systemctl
restart`).

The protocol rework's Task A (v1.1, announced round deadline + per-frame `ts`)
has landed and removed the "skip PUN → You lose" burst-delivery dependency.
The remaining reliability slices (stream seq + replay, `/ping` probe, latency
compensation, reconnect recovery, ghost online count) were defined from
unconfirmed connectivity symptoms: they are **parked as symptom descriptions**
in [docs/issues.md](issues.md) until the connectivity diagnostics slice (item
5) confirms a cause.

1. **Protocol rework (connectivity)** — Task A landed (v1.1). Tasks B (stream
   seq + replay) and C (`/ping` health probe) are parked in
   [docs/issues.md](issues.md) pending cause confirmation.
2. **Character roster & portraits** (Phase 3) — expand the cosmetic fighter
   roster with user-supplied art and an emoji fallback; select-screen polish.
3. **Best-of-5 game mode** (Phase 3) — first to 3 decisive rounds, draws
      replayed; best-of-1 stays the default. Ships for CPU matches first, then
      PvP (item 4 below). Depends on Protocol rework Task A.
4. **Best-of-5 for PvP** — re-open the ready handshake per round once the
      client machine is proven against the CPU.
5. **Connectivity diagnostics (decided; ships as observability)** — confirm,
      then *diagnose*, the reliability symptoms that keep surfacing at
      the boundary (silent-stuck-in-`matched`, reconnect-looking-like-a-loss,
      weak-link timing, ghost +1 online, drop-forfeit). Ships **surgical and
      incremental**, one trace at a time, each independently deployable:
      client join/leave lifecycle logging with the live count, a bounded SSE
      connection lifetime that reaps vanished devices, a short SSE frame
      journal, and — once the rework's `/ping` probe data exists — latency
      profile visibility. **Causes are deliberately UNCONFIRMED; the slice
      produces the evidence.** The symptoms themselves are described — not
      scheduled — in [docs/issues.md](issues.md), and graduate into scheduled
      work only when the cause is confirmed.
*Landed so far: the access/reject/join-leave logging half, plus the
       `/metrics` counter endpoint (requests, rejects by code/message,
       joined/left, dropped events, rate-limited, SSE streams, client error
       beacons by kind, **reaped connections**), the `/health` probe, and the
       client-side error beacon (`POST /report`, throttled client-side via
       `beaconGate`, hooked at SSE errors, fetch failures, machine-rejected
       transitions, stall-watchdog fires, and rejoin-past-window). **The
       bounded SSE connection lifetime is also in**: `/events` re-arms a short
       rolling per-write deadline before every frame, so a write that stalls
       against a vanished peer (half-open conn) reaps the connection — the
       client is removed, the online count reconciles down, a `reap client …`
       line joins the `leave online=N` line, and the `reaped` counter moves.
       TCP keepalive (15s) arms at the listener so the OS also notices silent
       idle peers between frames. Each client logs a short **frame journal**
       (last 16 event types actually flushed) on leave, so a vanished/reaped
       device's last-seen can be correlated with its reconnect or beacon. The
       remaining trace — latency profile visibility — waits on the protocol
       rework's `/ping` probe data.*
6. **Connectivity-safe scoring** — a no-valid-move timeout resolves as `void`
      (like a draw): no win, no streak break, "No contest" reported, while the
      opponent keeps the round win. Engine + client + leaderboard adopt it.
      **Decided and scheduled.**
7. **Busy affordances** — show a brief pending/disabled affordance on action
      buttons (Play Online, Instant CPU, rematch, cancel, fighter select, move
      submit) while their request awaits the SSE reply, so a long wait reads as
      "working" rather than silent; a failsafe clears it if the reply never
      comes. Also covers the loading gap while "Waiting for result…".
      **Decided and scheduled.**
8. **Core-gameplay e2e (decided; scoped)** — a small Playwright suite that
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
      each other; (3) reloading mid-match reconciles the client to a live,
      fair, or lobby state — never a dead view stuck on "Waiting for result…".
      Full flows create real matches by design.
      *Landed: `e2e/gameplay.spec.js` + `playwright.config.cjs` +
      `package.json` (`npm run e2e`, `@playwright/test`). `BASE_URL` is
      required and selects the production origin; it fails fast if unset.
      Keyed off a deterministic in-page probe on `renderResult` rather than
      racing the result banner. The runner is device-agnostic: any
      Chromium-capable host runs it.*

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
- [ ] **Latency compensation — parked (see issues.md)** — one-way delivery
      latency can flatten an on-time reaction into a `400 too late` for
      high-latency players (win/loss stays arrival-time-authoritative; see
      Phase 4 anti-cheat). Cause **unconfirmed** — parked in
      [docs/issues.md](issues.md), entry 3; ships only after the connectivity
      diagnostics slice (item 5) measures real pings.
- [ ] **Stale `state` teardown after a handshake re-pair** — when a PvP ready
      handshake is abandoned, `readyTimeout`/`readyAbandon` re-queue both sides
      and `m.requeue` calls `tryMatch`, which can re-pair the survivor into a
      *new* match before the abandoned match's `m.finish` → `finishMatch` runs.
      `finishMatch` then sends `state {state:"idle"}` to every side of the old
      match **unconditionally**, without re-checking `client.match == m` the way
      it does for the match teardown itself (`server.go:637-642`). The survivor
      can therefore observe `matched` (new match) *then* `state` (stale
      teardown), in either order depending on goroutine interleaving — the two
      frames are emitted within the same millisecond.
      Client impact: the browser reads that trailing `state` as a `stateIdle`
      edge out of `matched` and drops to the lobby while the server still holds
      it in a live match (see the `matched` row in
      [docs/protocol.md](protocol.md)). Self-healing — the next handshake
      timeout re-pairs and re-sends `matched` — so it is a view inconsistency
      rather than a wedge, and it needs no recovery work. **Cause narrowed, fix
      not decided**: the fix is presumably to send the teardown frame only to
      sides still on that match, or to make the frame match-scoped.
      *Observed via the protocol probe suite's `t8` scenario B, roughly 1 run
      in 7 (order-dependent, so a clean pass is not proof it is gone). Not
      filed in [docs/issues.md](issues.md): that register holds symptoms whose
      cause is unconfirmed, and this one's mechanism is traced.*

## Phase 2 — Testing & observability

Make the system testable and debuggable in production.

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
- [x] **Request/response logging** — structured logs for connection,
      matchmaking, match lifecycle, and errors. On hold: Protocol rework Task A
      adds `ts` to the timed frames (lag measurement without a log pipeline);
      revisit only if evidence after the rework still calls for it.
      *Landed (observability slice): a per-request access log
      (`accessLog`, method/path/status/duration), an error log at every
      `handlerError` (`kxp: reject <code> "<msg>"`), and client join/leave
      lines carrying the live count. Still open: structured (JSON) output.
      Exercised by `logging_test.go`.*
- [ ] **Online-count observability & half-open conns — diagnostics (issues.md
      entry 4)** — the +1 ghost is a symptom with an unconfirmed cause, so this
      ships only as *diagnostics*: client join/leave lifecycle logging with the
      live count, plus a bounded SSE connection lifetime (a short rolling
      per-write deadline + TCP keepalive) that reaps vanished devices to test
      the half-open hypothesis. The symptom is described in
      [docs/issues.md](issues.md), entry 4; any count-rule change waits for
      the logs.
      *The join/leave logging half has landed (see Request/response logging
      above); the bounded SSE lifetime reaping has not.*
- [x] **Core-gameplay e2e (decided; scoped)** — see Current priorities item 8
      for the three-flow Playwright scope. Landed (`e2e/gameplay.spec.js` +
      `playwright.config.cjs` + `npm run e2e`). Tests the deployed server over the
      internet via a required `BASE_URL`; runs on any Chromium-capable
      host.
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
      INCONCLUSIVE (link dropped, or self-rate-limited), because the suite is
      run over unreliable links and a suite that cannot tell a transport fault
      from a server defect trains you to ignore it — `tall` exits 1 on a real
      failure and 2 on an inconclusive one.
      *Not a replacement for `npm run e2e`: rendering, CSS and in-browser
      console errors remain Playwright-only. Client state machine and server
      internals stay offline (`npm run unit`, `npm run go`). It already earned
      its keep — it traced the stale-teardown race filed in Phase 1 and
      measured the zero-grace drop behaviour recorded in issues.md entry 5.*
- [x] **Automated test workflow** — `go test ./...` target; `go test -race` is not
      runnable on the arm64 Android dev device ("race is not supported on
      android/arm64"), so wire it into CI whenever a suitable host is
      available. Node unit tests run under `node --test web/*.test.cjs`.
      Playwright e2e (`npm run e2e` with a required `BASE_URL`) runs wherever
      Chromium exists; add it to CI on such a host.

## Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [x] **Pure game engine** — `round.go`'s `match` no longer touches `Hub`,
      `Client`, or SSE; sides are neutral `matchParty` and the hub wires
      `finish`/`requeue` callbacks back to real clients.
- [ ] **Game-mode architecture** — series-aware `run()`/`resolve()`: a match
      becomes a sequence of rounds, first to 3 decisive wins, draws replayed; a
      round that resolves `void` (no valid move, see item 6) counts as a round
      win for the opposing side.
      `result` gains round/series fields (`round`, `youRoundWins`,
      `oppRoundWins`, `roundsTarget`, `seriesOver`); a round result advances
      the client scoreboard and re-enters countdown, a final result ends the
      series. Ships for CPU matches first (ready stays once-per-series); PvP
      re-opens the ready handshake per round afterward. Builds on the Protocol
      rework Task A schedule, which ships first.
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