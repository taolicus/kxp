# KACHIPUN TOURNAMENT

A real-time online Rock-Paper-Scissors game in Go, with a web UI. Tap your move
the moment **PUN!** appears — too early and you're disqualified, just like the
original terminal game.

## Features

- **Single-binary web app** — the UI is embedded in the executable.
- **Play Online** — matchmaking pairs you with another player, synced countdown
  and a shared **PUN!** instant.
- **Play vs CPU** — a bot picks a random move after a random reaction delay.
- **Timing rules** — picks outside the shoot window are rejected with `400`
  (a second pick with `409`); no pick within 2s of PUN is a timeout loss.
- Server-sent events (SSE) for push, plain `POST` for player actions — no
  WebSocket dependency.

## Run

```sh
go run .
```

The server auto-picks the first available port in the 8000–8999 range. The
chosen port is printed on startup.

To bind a specific address (e.g. behind nginx):

```sh
go run . -addr :8080
```

Or build and run the binary:

```sh
go build -o kxp .
./kxp
```

Then open `http://localhost:<port>`.

## Play

1. Open the app in two browser tabs (one per player) and hit **Play Online** in
   both to face each other, or hit **Play vs CPU** for a solo match.
2. A **KA–CHI** countdown leads to **PUN!**.
3. Tap ✊ ✋ ✌️ right on PUN — results are shown with your reaction timing.

## Deploy (makefile)

```sh
make deploy
```

Builds a `linux/amd64` binary, uploads it to the VPS, and restarts the `kxp`
systemd service. Run it as a daemon (no terminal needed):

```ini
# /etc/systemd/system/kxp.service
[Unit]
Description=KACHIPUN TOURNAMENT online RPS
After=network.target

[Service]
ExecStart=/var/www/kxp/kxp -addr :8080
Restart=always

[Install]
WantedBy=multi-user.target
```

If you put an nginx reverse proxy in front, make sure streaming isn't buffered
for the `/events` endpoint, otherwise the countdown arrives in a single blob:

```nginx
location /events {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;
    proxy_cache off;
}
```

(You can also set the response header `X-Accel-Buffering: no` — the server
already sends it.)

## Technical Scope

The server is a single Go binary with zero external dependencies. It serves an
embedded web UI, uses SSE for server→client push and plain JSON POSTs for
player→server actions. All game rules are enforced server-side — the browser is
a renderer only.

**Game state machine** — matches progress through four phases: `idle` →
`countdown` → `shoot` (PUN) → `done`, tracked via an `atomic.Int32` on the
`match` struct. Every phase change goes through `advance(from, to)`, which
rejects illegal edges (see `allowedPhaseEdge`) and uses `CompareAndSwap` so a
stale goroutine can never clobber a newer phase.

**Timing model** — the server records `shootAt = time.Now()` when the shoot
phase begins. Reaction time is calculated as `arrival.Sub(shootAt)` where
`arrival` is `time.Now()` captured at POST receipt. Picks outside the 2s shoot
window are rejected with `400`; failing to pick within it is a timeout loss.
Displayed reaction times use the client's own click timestamps when provided
(network-neutral); win/loss remains server-authoritative on arrival time.

**Matchmaking** — a single global FIFO queue pairs players under the hub mutex.
Anonymous clients receive server-issued random IDs on first SSE connection.

**SSE lifecycle** — connections are guarded by a `connID` freshness check so a
newer connection survives an overlapping reconnection. A 20-second keepalive
comment frame prevents idle-proxy disconnection. Disconnect cancels the client's
`alive` context, which triggers match abandonment and notifies the opponent. If
a client's event backlog ever overflows its send buffer, the server logs the
dropped push (`send backlog full`) instead of dropping it silently. The client
arms a stall watchdog while a round is live and, if no result arrives within a
few seconds, forces a reconnect so the `connected` snapshot reconciles it back
out; snapshots for a finished (`done`) or already-expired (`shoot`) match route
straight to the lobby rather than a dead end.

**Testing** — `go test ./...`; client state machine: `node --test web/machine.test.cjs`

**Protocol contract** — the full wire format (events, endpoints, the client
state table, and clock handling) is specified in [`docs/protocol.md`](docs/protocol.md).

## Roadmap

### Phase 1 — Core hardening

Fix correctness and safety issues that affect reliability on a public server.

- [x] **Latency-fair reaction timing** — the reported reaction time is
      `arrive − shootAt`, which includes full network RTT, so a high-latency
      player always appears slower and gets a smaller effective window. Have
      the client send its click timestamp so the *displayed* reaction is
      network-neutral, while win/loss stays server-authoritative on arrival
      time. Spoofed client times are cosmetic only and don't affect ranking
      (see Phase 4 anti-cheat).
- [x] **Server-sent PUN window** — send `windowMs` in each `shoot` event so
      the client uses the authoritative window for its input lock (replacing
      the hard-coded 1500ms in `app.js`, which disagrees with the server's
      1200ms) and can surface `400`/`409` rejections inline instead of
      silently reporting a "Timed out" result.
- [x] **State machine for screen transitions** — extract a pure, table-driven
      transition machine (`web/machine.js`) so every screen change is a legal
      `[state][event]` edge with centralized enter-effects in `app.js`; invalid
      edges no-op silently (log under `?debug`) instead of drifting state. The
      Go match phases route through `advance(from, to)` with an explicit edge
      table. Validated by `web/machine.test.cjs` (`node --test`) plus Go tests.
- [x] **Mode-aware rematch** — results carry the match `mode` (`cpu`/`online`),
      and the result screen's "Play Again" branches on it: online re-enters the
      queue, CPU starts the next match immediately. A "Change mode" button
      returns to the lobby to pick a different mode or fighter.
- [x] **Phase-aware move validation** — `handleMove` must check
      `c.match.phase` before buffering; reject with `400` if the match is in
      countdown, done, or if the shoot deadline has passed
- [x] **Move channel lifecycle** — drain `c.moves` in both `endMatch` and
      `start` so a leftover pick never pre-fills the next match
- [x] **Full-channel drop must error** — when `c.moves` is full,
      `handleMove` must return `409 conflict` instead of `200 {}` so the
      client knows the move was not accepted
- [x] **Snapshot phaseDone vs phaseIdle** — `phaseName()` currently returns
      `"idle"` for both `phaseIdle` and `phaseDone`; return `"done"` for
      `phaseDone` so `snapshot()` can distinguish "no match" from "match
      just finished"
- [x] **Graceful server shutdown** — add signal handling, use
      `http.Server.Shutdown`, drain SSE connections cleanly
- [x] **Request timeouts** — add `ReadTimeout`/`WriteTimeout` to
      `http.Server`; enforce request body size limits via
      `http.MaxBytesReader`
- [ ] **Rate limiting** — basic per-IP token-bucket or fixed-window limiter
      on POST endpoints
- [ ] **Resource limits** — cap concurrent clients, active matches, and
      queue length; reject with `503` when full
- [ ] **Anonymous abuse prevention** — enforce a max number of anonymous
      clients per IP or time window
- [x] **Deterministic deadline enforcement** — a move accepted before the
      deadline is now always counted: when the shoot-window timer fires, the
      run loop drains each side's channel (`drainPending`) instead of leaving
      the outcome to a scheduler coin-flip between the channel read and the
      timer. Moves that arrive after the deadline are still rejected by
      `handleMove` (`400 too late`), so an on-time tap never silently drops as
      a timeout.
- [x] **Ready-handshake countdown** — after pairing, a two-player match does
      not start KA/CHI until **both** clients advertise readiness (`POST
      /ready`, re-sent every 2s while in the `matched` state); a `matched`
      that reaches a client still on the result screen now routes to a healthy
      "match found" state instead of an already-expired window. If a pair
      never acks (timeout or disconnect), the pending match is cancelled and
      the surviving side(s) re-queued. CPU matches skip the handshake. A
      `shootAt` field in the `shoot` event lets the client measure how much of
      the PUN window actually remains: it still lets the player act for that
      remaining time whenever any is left (only a fully closed window shows
      "Waiting for result…"), so client clock skew or delivery lag can never
      rob a player of a still-open server window.
- [ ] **Latency compensation** — the ready handshake removes the stale/remote
      burst, but one-way delivery latency can still shrink the *effective*
      window for high-latency players: an on-time reaction can be dropped as
      `400 too late` if its HTTP request lands just after the server deadline.
      Revisit a small server-side acceptance grace and/or a `clickedAt`-based
      cutoff once real pings are known (win/loss must stay
      arrival-time-authoritative; see Phase 4 anti-cheat).

### Phase 2 — Testing & observability

Make the system testable and debuggable in production.

- [x] **Timing edge-case tests** — exactly-at-PUN, just-after-PUN,
      at-deadline, and after-deadline boundary cases
- [ ] **Disconnect tests** — disconnect before PUN, after PUN, during match,
      and after result; verify `opponent-left` in each
- [ ] **Simultaneous-move tests** — both players submit moves concurrently
      via goroutines
- [x] **Game-state transition tests** — `TestAllowedTransitionTable` walks the
      full valid/invalid edge set, with `TestAdvanceRejectsWrongFrom` and
      `TestAdvanceWinsOnlyOnce` covering rejection and idempotency
- [ ] **CPU determinism hooks** — inject a deterministic clock and move
      picker for automated tests
- [ ] **Request/response logging** — structured logs for connection,
      matchmaking, match lifecycle, and errors
- [ ] **Automated test workflow** — Makefile test target + `go test -race`
      in CI when a suitable host is available

### Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [x] **Pure game engine** — `round.go`'s `match` no longer touches `Hub`,
      `Client`, or SSE. Each side is a neutral `matchParty` (emit callback +
      move/left channels + name/character), and the hub wires the engine's
      `finish`/`requeue` callbacks back to real clients when it builds a match,
      so the whole lifecycle, timing, and resolve logic is testable and
      reusable without a hub or a wire.
- [ ] **Game-mode architecture** — refactor `run()`/`resolve()` to support
      best-of-N and multi-round modes
- [ ] **Player names** — defined model for assignment, validation, and
      display
- [ ] **Multiple-tab handling** — deduplicate or isolate sessions from the
      same browser

### Phase 4 — Public features

Features that depend on identity, persistence, or ranking.

- [ ] **Leaderboard** — server-authoritative with anti-cheat (ignore
      client-submitted timestamps for ranking, cap CPU streaks)
- [ ] **Leaderboard identity** — persistent player identity model (account,
      token, or anonymous persistent ID)
- [ ] **Lobby / room architecture** — private room creation, joining,
      discovery, and access control
- [ ] **Send challenge** — a player creates a match and gets a shareable
      link (`/play?challenge=...` or similar) that any guest can open to
      join that specific match directly, bypassing the global queue; the
      host side shows a waiting + cancel state until the challenger joins
- [ ] **Tournament model** — bracket/round structure for multi-match
      competition
- [ ] **Solo campaign** — Mortal Kombat–style tower climbing with
      progression
- [ ] **Reconnection (re-evaluate later)** — a match lasts ~3.2s and today a
      TCP drop instantly forfeits via `opponent-left`, with the dropped
      player seeing no result. Options for later: resume a live match plus a
      short (2–3s) forfeit grace, vs. accepting forfeits for such a quick
      game. Revisit once public play shows how often drops actually occur.
- [x] **Random fight backgrounds** — each match picks one of five stages at
      random. Implemented client-side: `app.js` keeps a `BGS` roster and
      `randomizeBg()` sets `--bg-anim`/`--bg-static` on the document (the
      animated WebP plus its reduced-motion static frame), so the stage
      changes between fights with no server round-trip.