# KACHIPUN TOURNAMENT

Play it at **[kxp.pifia.net](https://kxp.pifia.net)**.

A real-time online Rock-Paper-Scissors game in Go, with a web UI. Tap your move
the moment **PUN!** appears.

## Features

- **Play Online** — invite-first: you reserve a slot, share the code (or the
  browser's share sheet), and the first pairing spends it. **Search for anyone**
  joins the global matchmaker instead.
- **Play vs CPU** — a bot that picks at a random moment, in a one-round or
  first-to-3 series.
- **Arcade Mode** — climb one floor per character, your own fighter as the final
  mirror. A loss sends you back to the bottom; progress is remembered in this
  browser.
- **Match History** — every match this browser finished, expandable to its
  rounds. Kept locally, capped at fifty — a record of what you played, not a
  ranking.
- **Server-side rules** — the browser renders; the server judges every pick by
  arrival time. No clock or UI state on the client can change a result.
- **Single binary, no dependencies** — the UI is embedded in the executable;
  push is SSE, actions are plain `POST`, and there is no WebSocket to keep alive.

## Run

Needs Go 1.26 or newer.

```sh
go run .
```

The server picks the first free port in the 8000–8999 range and prints it; open
`http://localhost:<port>`. To bind a specific address (e.g. behind nginx):

```sh
go run . -addr :8080
```

`go run . -h` lists the operational flags — round timing
(`-shoot-window`, `-ready-timeout`), `-sse-write-deadline`, `-max-body-bytes`
and the `-rl-*` rate limits. Each defaults to what the game ships with, so an
install can pin them rather than run whatever the build compiled in.

## Play

1. Open the app in two browser tabs (one per player). Hit **Play Online** in one
   to reserve that player and get a code, then paste it into the other tab's
   invite screen to pair them. For a solo match hit **Play vs CPU**, or hit
   **Arcade Mode** to climb the roster one floor at a time.
2. When a match is found, the round waits for you. **Both sides do** — keep the
   app in the foreground and a round never fires at someone who wasn't looking at
   the screen.
3. A **READY – KA – CHI** countdown leads to **PUN!**.
4. Tap ✊ ✋ ✌️ right on PUN — results are shown with your reaction timing.

The lobby's length control (one round, or first to 3) decides whether a drawn
round ends the match or replays; it rides with the length because the length
alone does not say what a draw does.

If the countdown is missing on your network — you go straight from *MATCH FOUND*
to *PUN!* — open **`/diag.html`** on the same origin. It plays one throwaway
match against itself and reports how many of the countdown beats your connection
can actually deliver. The countdown is announced exactly as long before PUN as it
lasts, so it has no slack to spare and each second of delay costs a beat.

## How it works

A single Go binary serves an embedded web UI and enforces every game rule
server-side — the browser is a renderer only. Matches progress
`idle → countdown → shoot (PUN) → done`; the server judges every pick by
arrival time relative to `shootAt`, so the client can't game the result the two
players share. See [architecture](docs/features/architecture.md) for the
internals.

## Docs

Durable knowledge about the system as it stands lives in
[features/](docs/features/): [architecture](docs/features/architecture.md)
(engine, timing model, matchmaking, SSE lifecycle, testing),
[protocol](docs/features/protocol.md) (the full wire format — events, endpoints,
the client state table, clock handling),
[characters](docs/features/characters.md) (who is playable, and what happens to a
selection or a saved ladder when the list changes),
[character selection](docs/features/character-selection.md) and
[backgrounds](docs/features/backgrounds.md) (asset pipeline).

For working on the repo — the gates, the host limits, and what each device can
verify — start at [AGENTS.md](AGENTS.md), which points into
[development/](docs/development/), [workflow/](workflow/README.md) and
[deployment.md](docs/development/deployment.md).

Work in flight is a file per item, and its directory is its only status:
[tasks/open/](docs/tasks/open/) (decided, not landed),
[tasks/closed/](docs/tasks/closed/) (landed) and
[issues/](docs/issues/) (symptoms parked until their cause is confirmed).
[roadmap.md](docs/roadmap.md) carries the phase structure and no status; the
rules behind the split are in [register.md](docs/register.md). This file
deliberately tracks none of it — one status to keep true is one place to look.

## Deploying

`sh deploy.sh` cross-builds the linux/amd64 binary, copies it to the VPS,
restarts the service, and checks `GET /health` reports the commit it just built —
the same value probe `t1` holds against local `HEAD`, which is what tells a real
deploy from a stale binary. Override the host, directory or health URL with
`DEPLOY_HOST`, `DEPLOY_DIR` and `HEALTH_URL`. The layout it fits is in
[deployment.md](docs/development/deployment.md).
