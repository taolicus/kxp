# Deployment

How to build, push, and run KACHIPUN TOURNAMENT on a public server. The game
itself (architecture, wire protocol) is in [architecture.md](architecture.md)
and [protocol.md](protocol.md).

## Deploy with the makefile

```sh
make deploy
```

Builds a `linux/amd64` binary (`CGO_ENABLED=0`), uploads it to the VPS via
`scp`, and restarts the `kxp` systemd service. The target host and directory
are `makefile` variables:

```make
VPS_HOST = tao
TARGET_DIR = /var/www/kxp
```

## Run as a daemon

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

## Behind nginx

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

## Port binding

The server auto-picks the first available port in the 8000–8999 range when
started without flags, and prints the chosen port on startup. To bind a
specific address (e.g. behind nginx):

```sh
go run . -addr :8080
```

Or build and run the binary directly:

```sh
go build -o kxp .
./kxp
```