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
8. ~~**Core-gameplay e2e**~~ — **withdrawn.** The Playwright suite landed and
   was then removed as dead weight: it could not run on the only host this
   project is developed on (no Chromium on arm64 Android/Termux), so it never
   produced a signal in practice, and the browser-free probe suite covers the
   same class of failure. See Phase 2 for the removal note.

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

      → rationale: [decisions/cpu-ready-gate.md](decisions/cpu-ready-gate.md)

- [x] **Tell the player *why* a handshake was cancelled** — an expired readiness
      gate was invisible. The client acked with a fire-and-forget
      `post('/ready')` (`web/app.js`) that discards its error, and the requeue
      arrived as a bare `state idle`, so a player whose link was too slow saw
      "match found" and then silently landed back in the queue with no reason.

      → rationale: [decisions/handshake-cancel-reason.md](decisions/handshake-cancel-reason.md)

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
      the "Connectivity-safe scoring (planned)" section in
      [docs/protocol.md](protocol.md), which records the residual
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

      → rationale: [decisions/stale-teardown-guard.md](decisions/stale-teardown-guard.md)

- [x] **Monotonic PUN deadline** — the announced deadline is held as a
      `time.Time`, not epoch-ns.

      → rationale: [decisions/monotonic-pun-deadline.md](decisions/monotonic-pun-deadline.md)

- [x] **Both ends of the pick window are authoritative** — `resolve` judged only
      the near end, `arrive >= shootAt`, and left the far end to `handleMove`.

      → rationale: [decisions/pick-window-both-ends.md](decisions/pick-window-both-ends.md)

## Phase 2 — Testing & observability

Make the system testable and debuggable in production.

- [x] **A failing probe keeps its evidence** — three separate places discarded
      the reason a run failed, which is why one intermittent live failure took
      three attempts to diagnose.

      → rationale: [decisions/probe-keeps-evidence.md](decisions/probe-keeps-evidence.md)

- [x] **Deploy identity on `/health`** — the live suite now proves *which* build
      it tested. `/health` reports `build {sha, modified, source}`; `t1` asserts
      it against the local HEAD and fails with a fix hint on absent, unknown,
      mismatched, or dirty.

      → rationale: [decisions/deploy-identity-health.md](decisions/deploy-identity-health.md)

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

      → rationale: [decisions/connectivity-diagnostics-traces.md](decisions/connectivity-diagnostics-traces.md)

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
- [x] **Core-gameplay e2e (withdrawn)** — a Playwright suite that drove the real
      browser against the **deployed server** to surface game-breaking
      connectivity failures that resist unit testing. It landed as
      `e2e/gameplay.spec.js` + `playwright.config.cjs` + `npm run e2e`, and was
      then **removed** rather than kept: the only host this project runs on is
      arm64 Android/Termux, where Chromium cannot be installed, so the suite
      never actually ran and could not have caught a regression. Keeping an
      unrunnable suite is worse than not having it — it advertises coverage
      that does not exist, and every future reader has to re-derive that fact.
      The coverage it was scoped for is served by the browser-free probes below,
      which do run here; what is genuinely lost is in-browser rendering, CSS and
      console-error checking, now recorded as an explicit gap rather than an
      absent test.
- [x] **Protocol-level production probes (browser-free)** — the server needs no
      browser to be exercised: every endpoint is a `POST` plus one `GET /events`
      SSE stream, so a plain Node `fetch` client drives real matches directly.
      This is the project's **only** integration path, and the reason the
      Playwright suite was withdrawn: these run on hosts that cannot install a
      browser at all (the arm64 Android/Termux dev device), so unlike a
      Chromium-driven suite they actually execute where the work happens.
      Landed `tools/t1`–`t8` + `tools/lib/harness.mjs` + `tools/README.md`
      (`npm run tall`, `npm run tall -- t5 t6`, `QUICK=1 npm run tall`):
      link characterization, read-only endpoint contracts, character
      round-trip, SSE frame/id/skew contract, a timed CPU match, mid-match
      reconnect + reconciliation, the full rejection-code matrix, and
      self-paired PvP including the abandoned-handshake case.

      → rationale: [decisions/browser-free-probes.md](decisions/browser-free-probes.md)

- [x] **Automated test workflow** — `go test ./...` target; `go test -race` is not
      runnable on the arm64 Android dev device ("race is not supported on
      android/arm64"), so wire it into CI whenever a suitable host is
      available. Node unit tests run under
      `node --test web/*.test.cjs tools/lib/*.test.mjs`. The protocol probes
      (`npm run tall`, browser-free) run on the dev device itself against the
      deployed origin, so they need no extra host; if a browser-level suite is
      ever wanted again it has to be a host that can install Chromium, not this
      one.

- [ ] **Externalised operational settings** — `-addr` (`main.go:23`) is the only
      flag; every other operating value is a compile-time constant or package
      `var` — `shootWindow` (`round.go:11`), `readyTimeout` (`round.go:30`),
      `sseWriteDeadline` (`server.go:43`), `maxBodyBytes` (`server.go:18`), the
      rate-limit defaults (`ratelimit.go:13`). An operator who needs a different
      value therefore has no route to one short of a rebuild and restart, and
      tuning has to be a code change rather than a config change. Carried over
      from the retired review checklist, where it was the only item not already
      implemented, documented elsewhere, or tracked here. Decide flag vs env;
      keep today's values as the defaults; and keep the engine reading one
      authoritative value, since a second source of timing truth is the failure
      the monotonic deadline already had to be fixed for (see "Monotonic PUN
      deadline" above, and "CPU determinism hooks" below).

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