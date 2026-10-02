# Roadmap

The phase structure of KACHIPUN TOURNAMENT, and what has landed in each phase.
**Open work does not live here.** It is in [docs/tasks/open/](tasks/open/), one
file per item, ordered by the `priority` integer in that file's frontmatter — so
the next thing to pick up is a sort of that directory, not a list held in prose
here.

A checkbox in this file therefore means only one thing: this landed. That is a
deliberate narrowing. The file previously carried unchecked entries too, which
made it claim to schedule work whose next action was unknown, and once priority
moved into task frontmatter it was also a second, hand-maintained priority list.
The "Current priorities" section it carried is gone for that reason; the ordering
it expressed is now the `priority` field, and the prose explaining each item's
urgency moved with the item. Symptoms, questions, and decisions stay in
[docs/issues/](issues/); the reasoning behind each landed entry stays in
[docs/decisions/](decisions/).

Every phase below is complete. That is not a claim that the project is finished —
it is what moving 18 open entries out of the file looks like, and a reader who
knows that will not mistake an empty phase for an abandoned one. Phase 4 in
particular has no entries left at all: its planned work is six files in
[docs/tasks/open/](tasks/open/) carrying `phase: 4`.

## Protocol rework (active)

The reaction opportunity must not depend on burst delivery of a single `shoot`
frame over one unacknowledged SSE stream. Task A shipped and landed that
removal. The remaining B/C slices are recorded as prospective fixes on the
symptom they would address in [docs/issues/](issues/) until the diagnostics
slice confirms a cause; their draft specs remain in protocol.md, "Rework",
marked parked. There is no B/C checkbox here on purpose: the work is not
scheduled, and a box to tick would say it was.

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

## Phase 1 — Core hardening

Correctness and safety issues that affect reliability on a public server.

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
- [x] **Connectivity diagnostics — the landed traces** — one slice per trace,
      each independently deployable, producing the evidence the parked
      connectivity symptoms need before any of them can be scheduled against a
      confirmed cause ([docs/issues/](issues/)). The causes are
      deliberately **UNCONFIRMED; the slice produces the evidence.** That is the
      whole design — a suite that cannot tell a transport fault from a server
      defect trains you to ignore it, so every trace here exists to make the next
      judgement possible.

      → rationale: [decisions/connectivity-diagnostics-traces.md](decisions/connectivity-diagnostics-traces.md)

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

## Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [x] **Pure game engine** — `round.go`'s `match` no longer touches `Hub`,
      `Client`, or SSE; sides are neutral `matchParty` and the hub wires
      `finish`/`requeue` callbacks back to real clients.

## Phase 4 — Public features

Features that depend on identity, persistence, or ranking.

- [x] **Random fight backgrounds** — each match picks one of five stages at
      random. Implemented client-side: `app.js` keeps a `BGS` roster and
      `randomizeBg()` sets `--bg-anim`/`--bg-static` on the document (the
      animated WebP plus its reduced-motion static frame), so the stage changes
      between fights with no server round-trip.