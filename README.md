# KACHIPUN TOURNAMENT

A real-time online Rock-Paper-Scissors game in Go, with a web UI. Tap your move
the moment **PUN!** appears — too early and you're disqualified, just like the
original terminal game.

## Features

- **Single-binary web app** — the UI is embedded in the executable.
- **Play Online** — opens an invite screen: it reserves you at the mode the
  lobby's control is showing (one round or first to 3, the control naming the
  draw rule) and hands you a code to share, beside a field for pasting a friend's
  code. Share it through the browser's own share sheet where there is one, or the
  copy button; either way the link is live while it waits and is spent when its
  match ends, so it pairs exactly two players once. **Search for anyone** instead
  leaves the reservation and joins the global matchmaker at the same length. A
  series keeps the score as pips under each fighter and re-opens the ready
  handshake between rounds. Synced countdown and a shared **PUN!** instant either
  way.
- **Play vs CPU** — a bot picks a random move after a random reaction delay, in
  a series you pick in the lobby: one round (a draw is the result) or first to 3
  (a draw replays). One round is the default, and the lobby remembers the mode
  you last chose — its length and what a draw does. A series is scored as pips
  under each fighter; a 1-off has no score to keep.
- **Arcade Mode** — one floor per character in a random order, your own
  character as the final mirror, the same stock bot on every floor. A floor is
  first-to-1 at a lobby length of one — a drawn round replays, so a draw never
  costs the run — and first to 3 at a length of three. A win climbs a
  floor, a loss sends you back to the bottom, and progress is remembered in this
  browser (`localStorage`). The mode opens on the tower and each floor starts from
  its Fight button: the whole order drawn bottom-up with your fighter standing on
  the floor you have reached, beside the one you are about to fight — after a win,
  climbing into place.
- **Match History** — every match this browser finished, one row per match and
  expandable to the rounds inside it: the two fighters, the score, the stage and
  how long ago it was. The record is kept in this browser (`localStorage`), capped
  at fifty and cleared with the site — a record of what you played, not a ranking.
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

Run `go run . -h` for the operational flags: `-shoot-window` and
`-ready-timeout` (round timing), `-sse-write-deadline`, `-max-body-bytes`, and
the `-rl-*` rate limits. Each defaults to the value the game ships with, so an
install can pin them and be recorded rather than running whatever the build
compiled in.

Then open `http://localhost:<port>`.

## Play

1. Open the app in two browser tabs (one per player). Hit **Play Online** in one
   to reserve that player and get an invite code, then paste it into the other
   tab's invite screen to pair them. For a solo match hit **Play vs CPU**, or hit
   **Arcade Mode** to climb the roster one floor at a time.
2. When a match is found, the round waits for you. **Both sides do** — keep the
   app in the foreground and a round never fires at someone who wasn't looking at
   the screen.
3. A **READY – KA – CHI** countdown leads to **PUN!**.
4. Tap ✊ ✋ ✌️ right on PUN — results are shown with your reaction timing.

If the countdown is missing on your network — you go straight from *MATCH FOUND*
to *PUN!* — open **`/diag.html`** on the same origin. It plays one throwaway
match against itself and reports how many of the countdown beats your connection
can actually deliver. The countdown is announced exactly as long before PUN as it
lasts, so it has no slack to spare and each second of delay costs a beat.

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
  [characters](docs/features/characters.md) (who is playable, and what happens to
  a selection or a saved ladder when the list changes),
  [backgrounds](docs/features/backgrounds.md) (asset pipeline).
- [development/](docs/development/) — how this repo is built and verified, and
  which device a task belongs on:
  [environment.md](docs/development/environment.md) (the two measured hosts —
  the Android/Termux phone and the MacBook Pro — their toolchains, and how to
  re-measure both),
  [device-aware-workflow.md](docs/development/device-aware-workflow.md) (match
  the work to the device, and record a deferral where it belongs) and
  [verification.md](docs/development/verification.md) (what each gate does and
  does not cover, the browser-free probe suite, and the verdicts it reports).
  What each host can and cannot verify, and the working loop, live in
  [AGENTS.md](AGENTS.md).
- [register.md](docs/register.md) — what each of the directories below is for,
  and the rules that keep them separate.
- [tasks/](docs/tasks/) — work items: what is specified and not yet landed
  ([open/](docs/tasks/open/), with `phase` and dependencies in the frontmatter) and
  what has landed ([closed/](docs/tasks/closed/)).
- [roadmap.md](docs/roadmap.md) — why the phases are ordered as they are, with a
  link per landed item. Not a register, and carries no status.
- [issues/](docs/issues/) — observed reliability symptoms parked until
  their cause is confirmed, one file per symptom.

## Testing

```sh
npm run links     # internal doc paths resolve, and each #fragment names a heading
go test ./...     # Go suite
npm run unit      # web/*.test.cjs + tools/lib/*.test.mjs
npm run e2e       # browser suite — needs an origin and Chromium, so the laptop only
```

`npm run unit` is the way to run the client and harness tests; the files it
globs are not a list to reproduce by hand, and every `web/app.*.test.cjs`
(`web/app.countdown.test.cjs` and `web/app.reconnect.test.cjs` among them) runs
the real `app.js` against a stubbed context, which nothing else covers. Pass a
subset to check part of the doc tree: `npm run links -- AGENTS.md docs/features`.

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
matches by design. `npm run e2e` adds a Playwright suite that renders the lobby
in a real Chromium against the same origin — laptop only, because the phone
cannot install Chromium. Styling and layout are asserted nowhere on either
host. What each gate does and does not cover is in
[docs/development/verification.md](docs/development/verification.md), and the
host limits are in [AGENTS.md](AGENTS.md).

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
