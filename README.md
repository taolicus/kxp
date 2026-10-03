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
two players share. See [architecture](docs/features/architecture.md) for the internals.

## Docs

- [features/](docs/features/) — durable knowledge about the system as it now
  stands. [architecture](docs/features/architecture.md) (engine, timing model,
  matchmaking, SSE lifecycle, testing),
  [protocol](docs/features/protocol.md) (the full wire format: events, endpoints,
  the client state table, clock handling),
  [character selection](docs/features/character-selection.md),
  [backgrounds](docs/features/backgrounds.md) (asset pipeline).
- [environment.md](docs/environment.md) — the measured development host
  (Android/Termux), its toolchain, and how to re-measure both. What it can and
  cannot verify, and the working loop, live in [AGENTS.md](AGENTS.md).
- [tasks/](docs/tasks/) — work items: what is specified and not yet landed
  ([open/](docs/tasks/open/), `priority` integer in the frontmatter) and what has
  landed ([closed/](docs/tasks/closed/)).
- [roadmap.md](docs/roadmap.md) — why the phases are ordered as they are, with a
  link per landed item.
- [issues/](docs/issues/) — observed reliability symptoms parked until
  their cause is confirmed, one file per symptom.

## Testing

```sh
go test ./...              # Go suite
node --test web/kxp.test.cjs web/machine.test.cjs
```

(`go test -race` isn't supported on the arm64-Android dev device; see the
[automated-test-workflow.md](docs/tasks/closed/automated-test-workflow.md)
if you add CI.)

The browser-free probe suite (`tools/t1`–`t8`) is the integration path. It
targets the **deployed (production) server directly over the internet**; it
never boots the app locally, needs only Node >= 20, and takes the production
origin through a required `BASE_URL`:

```sh
npm install
npm run t1                                   # measures the link first
BASE_URL=https://your-server.example npm run tall
```

See [tools/README.md](tools/README.md) for what each probe proves and why the
origin is required rather than defaulted. The flows create real (short-lived)
matches by design. Rendering, CSS and in-browser console errors have no
automated coverage — see the host limits in [AGENTS.md](AGENTS.md).

## Status

Core hardening, testability, and the pure-engine refactor are done, including
per-IP rate limiting and resource caps — live on the public server.

This file deliberately does not track what is left. Each of those lives in
exactly one place, so there is one status to keep true:

- [tasks/open/](docs/tasks/open/) — decided and scheduled work, one file per
  item.
- [tasks/closed/](docs/tasks/closed/) — what has landed.
- [issues/](docs/issues/) — live symptoms parked until their cause is
  confirmed.

The live server is kept at the current build by an ops script kept **outside**
this repo (`git pull` + build + `systemctl restart`); the repository itself
carries no deployment tools.
