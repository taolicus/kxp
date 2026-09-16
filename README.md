# KACHIPUN TOURNAMENT

A real-time online Rock-Paper-Scissors game in Go, with a web UI. Tap your move
the moment **SHOOT!** appears — too early and you're disqualified, just like the
original terminal game.

## Features

- **Single-binary web app** — the UI is embedded in the executable.
- **Play Online** — matchmaking pairs you with another player, synced countdown
  and a shared **SHOOT!** instant.
- **Play vs CPU** — a bot picks a random move after a random reaction delay.
- **Timing rules** — picks arriving before SHOOT are disqualified; no pick
  within 1.2s of SHOOT is a timeout loss.
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
2. A 3–2–1 countdown leads to **SHOOT!**.
3. Tap ✊ ✋ ✌️ right on SHOOT. Results are shown with your reaction timing.

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

## Roadmap

- [x] Web server with SSE + matchmaking (PvP and CPU)
- [ ] Player names / lobby rooms
- [ ] Best-of-N matches and rematches
- [ ] Game history / stats