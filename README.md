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
  (a second pick with `409`); no pick in time is a timeout loss.
- Server-sent events (SSE) for push, plain `POST` for player actions — no
  WebSocket dependency.

## Run

```sh
go run .
```

The server auto-picks the first available port in the 8000–8999 range and
prints it on startup. To bind a specific address (e.g. behind nginx):

```sh
go run . -addr :8080
```

Then open `http://localhost:<port>`.

## Play

1. Open the app in two browser tabs (one per player) and hit **Play Online** in
   both to face each other, or hit **Play vs CPU** for a solo match.
2. A **KA–CHI** countdown leads to **PUN!**.
3. Tap ✊ ✋ ✌️ right on PUN — results are shown with your reaction timing.

## How it works

A single Go binary serves an embedded web UI and enforces every game rule
server-side — the browser is a renderer only. Matches progress
`idle → countdown → shoot (PUN) → done`; the server judges every pick by
arrival time relative to `shootAt`, so the client can't game the result the
two players share. See [architecture](docs/architecture.md) for the internals.

## Docs

- [architecture.md](docs/architecture.md) — engine, timing model, matchmaking,
  SSE lifecycle, testing.
- [protocol.md](docs/protocol.md) — the full wire format: events, endpoints,
  the client state table, and clock handling.
- [backgrounds.md](docs/backgrounds.md) — match background asset pipeline.
- [roadmap.md](docs/roadmap.md) — planned work by phase.
- [issues.md](docs/issues.md) — observed reliability symptoms parked until
  their cause is confirmed.

## Testing

```sh
go test ./...              # Go suite
node --test web/kxp.test.cjs web/machine.test.cjs
```

(`go test -race` isn't supported on the arm64-Android dev device; see the
roadmap's "Automated test workflow" note if you add CI.)

## Status

Core hardening, testability, and the pure-engine refactor are done, including
per-IP rate limiting and resource caps — live on the public server. The
protocol rework's Task A (announced round deadline + per-frame `ts`) has
landed; the remaining reliability slices (stream seq + replay, `/ping` probe,
latency compensation, reconnect recovery, ghost online count) are **parked as
symptom descriptions** in [docs/issues.md](docs/issues.md) until their cause
is confirmed. Decided and scheduled next are **connectivity diagnostics**
(client join/leave lifecycle logging + a bounded SSE connection lifetime, as a
surgical incremental slice that produces the evidence), **connectivity-safe
scoring** — a no-valid-move timeout resolves `void`, scored like a draw (no
streak break, the opponent still wins, "No contest" shown) — and **busy
affordances** (a pending affordance while a request awaits its SSE reply).
Still open are best-of-N modes and the identity/leaderboard features. See
[roadmap.md](docs/roadmap.md).

The live server is kept at the current build by an ops script kept **outside**
this repo (`git pull` + build + `systemctl restart`); the repository itself
carries no deployment tools.
