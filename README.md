# KACHIPUN TOURNAMENT

A real-time online Rock-Paper-Scissors game in Go, with a web UI. Tap your move
the moment **PUN!** appears — too early and you're disqualified, just like the
original terminal game.

## Features

- **Single-binary web app** — the UI is embedded in the executable.
- **Play Online** — matchmaking pairs you with another player, synced countdown
  and a shared **PUN!** instant.
- **Play vs CPU** — a bot picks a random move after a random reaction delay.
- **Timing rules** — picks arriving before PUN are disqualified; no pick within
  1.2s of PUN is a timeout loss.
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
`countdown` → `shoot` (PUN) → `done`. Each phase is tracked via an
`atomic.Int32` on the `match` struct. Transition enforcement is implicit in the
`run()` goroutine flow rather than via an explicit transition validator.

**Timing model** — the server records `shootAt = time.Now()` when the shoot
phase begins. Reaction time is calculated as `arrival.Sub(shootAt)` where
`arrival` is `time.Now()` captured at POST receipt. Picks arriving before PUN
are disqualified; no pick within 1.2 seconds of PUN is a timeout loss. Displayed
reaction times include client→server network latency.

**Matchmaking** — a single global FIFO queue pairs players under the hub mutex.
Anonymous clients receive server-issued random IDs on first SSE connection.

**SSE lifecycle** — connections are guarded by a `connID` freshness check so a
newer connection survives an overlapping reconnection. A 20-second keepalive
comment frame prevents idle-proxy disconnection. Disconnect cancels the client's
`alive` context, which triggers match abandonment and notifies the opponent.

**Testing** — 9 tests covering PvP outcomes, early-pick disqualification,
timeout losses, CPU matches, and character selection. Tests exercise the match
engine directly via `Client` channels without a live HTTP listener but depend on
real wall-clock timing. The race detector is not available on the current
android/arm64 host.

## Roadmap

### Phase 1 — Core hardening

Fix correctness and safety issues that affect reliability on a public server.

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
- [ ] **Request timeouts** — add `ReadTimeout`/`WriteTimeout` to
      `http.Server`; enforce request body size limits via
      `http.MaxBytesReader`
- [ ] **Rate limiting** — basic per-IP token-bucket or fixed-window limiter
      on POST endpoints
- [ ] **Resource limits** — cap concurrent clients, active matches, and
      queue length; reject with `503` when full
- [ ] **Anonymous abuse prevention** — enforce a max number of anonymous
      clients per IP or time window

### Phase 2 — Testing & observability

Make the system testable and debuggable in production.

- [ ] **Timing edge-case tests** — exactly-at-PUN, just-after-PUN,
      at-deadline, and after-deadline boundary cases
- [ ] **Disconnect tests** — disconnect before PUN, after PUN, during match,
      and after result; verify `opponent-left` in each
- [ ] **Simultaneous-move tests** — both players submit moves concurrently
      via goroutines
- [ ] **Game-state transition tests** — verify every valid transition and
      reject invalid ones
- [ ] **CPU determinism hooks** — inject a deterministic clock and move
      picker for automated tests
- [ ] **Request/response logging** — structured logs for connection,
      matchmaking, match lifecycle, and errors
- [ ] **Automated test workflow** — Makefile test target + `go test -race`
      in CI when a suitable host is available

### Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [ ] **Pure game engine** — extract the state machine from `round.go` so
      it depends only on interfaces, not on `Hub`/`Client`/SSE
- [ ] **Game-mode architecture** — refactor `run()`/`resolve()` to support
      best-of-N and multi-round modes
- [ ] **Player names** — defined model for assignment, validation, and
      display
- [ ] **Multiple-tab handling** — deduplicate or isolate sessions from the
      same browser

### Phase 4 — Public features

Features that depend on identity, persistence, or ranking.

- [ ] **Leaderboard** — server-authoritative with anti-cheat (reject
      client-submitted timestamps, cap CPU streaks)
- [ ] **Leaderboard identity** — persistent player identity model (account,
      token, or anonymous persistent ID)
- [ ] **Lobby / room architecture** — private room creation, joining,
      discovery, and access control
- [ ] **Tournament model** — bracket/round structure for multi-match
      competition
- [ ] **Solo campaign** — Mortal Kombat–style tower climbing with
      progression
- [ ] **Random fight backgrounds** — display a random background scenario
      (arena/stage) for each fight, chosen server-side and sent to clients
      via SSE