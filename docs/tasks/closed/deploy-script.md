# Move deployment to the sibling `deploy.sh` flow

Deployment was the one thing in this project that did not match its siblings.
asteroids and komikan ship a `deploy.sh` that cross-builds the binary, copies it
to the VPS, restarts the service and health-checks the public URL; kxp instead
kept a full source checkout on the host and built there over SSH, through an ops
script that lived outside this repo. This slice adopts the sibling flow and drops
the remote checkout.

## Required context

- The sibling scripts: `~/lab/asteroids/deploy.sh`, `~/lab/komikan/deploy.sh`.
  kxp's closest sibling is komikan's — same binary-only remote — but its target
  is a single root-level `package main` (`.`) rather than `./cmd/server`, and its
  health endpoint is real JSON rather than a liveness page.
- [protocol.md](../../features/protocol.md) § the identity on `/health` and the
  t1 note: `build.sha` is what lets a probe run prove it measured the build that
  was just written.
- [version.go](../../../version.go) — `buildID.Source` has an `"ldflags"` case
  already, written for a build outside a work tree.
- [AGENTS.md](../../../AGENTS.md) § Verify, § Commit and push: the old rule was
  that the repo carries *no* deployment tooling. Adopting a script means
  amending that rule rather than quietly breaking it.

## Acceptance

- `deploy.sh` at the repo root, POSIX `sh`, no bashisms, runnable as
  `sh deploy.sh` from the phone (shared storage is noexec).
- Cross-builds `linux/amd64` with `CGO_ENABLED=0` and `-trimpath
  -ldflags="-s -w"`, copies to `$HOST:$REMOTE_DIR/kxp.new`, renames over `kxp`,
  restarts `kxp.service`.
- Checks `GET /health` and **fails** if the reported `sha` is not the local
  `HEAD` — a successful-looking deploy of a stale binary is the failure this
  guards.
- `/home/dev/kxp` no longer holds a source checkout.
- `AGENTS.md`, `README.md` and a `docs/development/` file describe the flow; the
  reasoning (why a binary copy, why `-X main.buildSHA`, why the old remote build
  was dropped) is recorded where the constraint lives.

## Out of scope

The `-race`/browser coverage the phone cannot produce. That is a separate item —
[github-actions-ci.md](../open/github-actions-ci.md) — and this slice does not
touch it.

## Landed

`deploy.sh` is at the repo root and follows the sibling shape: cross-build
`linux/amd64`, `scp` to `/home/dev/kxp/kxp.new`, rename over `kxp`, `systemctl
restart kxp.service`, then check `GET /health` reports the SHA just built. The
remote source checkout was removed and the old out-of-repo command with it.

**Identity is stamped, not inferred.** The script passes `-X
main.buildSHA=$(git rev-parse HEAD)`. Two reasons, and both are recorded in
[deployment.md](../../development/deployment.md): the probe's stale-build detector
(t1 asserting `/health` against local `HEAD`) needs the value to exist, and
`-trimpath` means the toolchain's own VCS stamp is not something to depend on per
build. `version.go` already had the `"ldflags"` source case, so the production
path is one the type was written for rather than a new mechanism.

**The health check compares the SHA rather than pinging the root.** `HEALTH_URL`
defaults to `https://kxp.tao.cl/health`; the script greps the JSON for the
expected `sha` and exits non-zero otherwise. A deploy that copies the wrong file,
or restarts into a service that then fails, is caught here instead of at the next
probe run.

**Verified.** The deploy was run end to end on the phone (termux aarch64 →
`linux/amd64`) against the live host. `sh deploy.sh` built, copied, restarted and
reported `deployed 019779068f0cdc8b12d701d01fd5287c271c79b5`; the deployed
`/health` then reported that SHA with `source` flipped from `"vcs"` to
`"ldflags"`, which is the stamp landing rather than the toolchain's own. The
remote was checked before and after the checkout was removed: `git status
--porcelain` was empty (nothing untracked to lose), `kxp.service` stayed active
across the removal, and `/home/dev/kxp` now holds the binary alone.

Gates, all on the phone: `gofmt -l .` printed nothing; `go vet ./...` clean;
`go test ./...` ok (197.4s); `npm run unit` 222/222; `npm run links` 136
documents, 443 links, 0 broken; `npm run tall` 8 passed, 0 failed, 0
inconclusive, with t1 confirming production runs local `HEAD`.

**Not verified on this host.** `go test -race` remains unavailable on the phone,
which is exactly what the CI item is for; the deploy flow itself was run, as
above, rather than argued for. The one thing no gate covers is `deploy.sh`
itself: it is a deploy artifact with no harness here, so its SHA check is
unpinned. Its two directions were exercised by hand against the live endpoint —
the deployed SHA is accepted, and a deliberately wrong one is rejected — but
nothing re-runs that on the next change to the script.
