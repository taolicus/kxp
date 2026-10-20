#!/bin/sh
# Build the server binary and deploy it to the production VPS.
#
# Deployment is deliberately just "copy the binary": systemd (kxp.service) and
# nginx (kxp.tao.cl) are already set up on the host. The binary embeds the whole
# web UI (main.go's `//go:embed web`), so the client ships with the server and
# there is nothing else to copy.
#
# buildSHA is stamped from `git rev-parse HEAD` because the binary is cross-built
# in a work tree that is not the one serving it, and the probe suite (t1) holds
# what it finds on /health against local HEAD to prove the deployed build is the
# one that was just written. `go build` would stamp VCS metadata on its own, but
# -trimpath is passed for a reproducible path-free binary, so the identity is set
# explicitly rather than left to a stamp that has to be reasoned about per build.
#
# POSIX sh only: works with sh, dash, bash, or ash.
set -eu

HOST="${DEPLOY_HOST:-tao}"
REMOTE_DIR="${DEPLOY_DIR:-/home/dev/kxp}"
SERVICE="kxp"
HEALTH_URL="${HEALTH_URL:-https://kxp.tao.cl/health}"

cd "$(dirname "$0")"

sha="$(git rev-parse HEAD)"

bin="$(mktemp)"
trap 'rm -f "$bin"' EXIT

echo "==> building for linux/amd64"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w -X main.buildSHA=$sha" -o "$bin" .

echo "==> copying to $HOST:$REMOTE_DIR"
scp -q "$bin" "$HOST:$REMOTE_DIR/kxp.new"
# Replace by rename so a running binary is never written in place.
ssh "$HOST" "chmod 0755 '$REMOTE_DIR/kxp.new' && mv -f '$REMOTE_DIR/kxp.new' '$REMOTE_DIR/kxp' && systemctl restart $SERVICE"

echo "==> checking $HEALTH_URL"
# /health, not the site root: the probe target is the endpoint that reports the
# build identity, so the deploy's own check compares the same value t1 does.
health="$(curl -fsS --retry 10 --retry-delay 1 --retry-all-errors "$HEALTH_URL")"
case "$health" in
  *"\"sha\":\"$sha\""*) echo "==> deployed $sha" ;;
  *) echo "deploy failed: $HEALTH_URL reports $health" >&2; exit 1 ;;
esac
