# Deployment

How the live server at `https://kxp.tao.cl` is kept at the current build, and
why the pieces are shaped the way they are. The host pattern is shared with the
sibling projects (asteroids, komikan) and was documented for it there; this file
is the kxp instance of it.

## The shape

`deploy.sh` is the whole mechanism, run from the phone:

1. cross-build `linux/amd64` with `CGO_ENABLED=0` and `-trimpath -ldflags="-s -w"`;
2. `scp` the binary to `/home/dev/kxp/kxp.new`;
3. `mv` it over `kxp` and `systemctl restart kxp.service`;
4. check `GET /health` reports the SHA that was just built.

There is no remote build and no `git pull` on the host. The VPS keeps no source
checkout: `/home/dev/kxp` holds the binary and nothing else, like
`/home/dev/komikan` and `/home/dev/asteroids`.

**Why copy a binary rather than build on the host.** Go is not installed on the
VPS (komikan's deployment notes record the cross-compile as the pattern), so a
remote build would need a toolchain there or a checkout plus one. Copying one
~5 MB file is the smaller surface: nothing to keep in sync, nothing to leave
half-pulled, and a rollback is the previous binary.

**Why a single binary can carry the whole app.** `main.go` embeds the client
with `//go:embed web`, and serves it and the API from one `http.ServeMux`
(`hub.routes()` plus the file server). So `web/` needs no separate web root on
the host and no nginx `root` — nginx only reverse-proxies to
`127.0.0.1:18080`, and SSE needs `proxy_buffering off` there. This is the
property that makes "copy the binary" sufficient rather than a simplification
that drops assets.

**Why the `.new` + rename.** `mv` over a running binary's path is a rename, so
the inode the running process has open is untouched and the replacement is
atomic. Writing the file in place would fault a running process mid-write.

## Build identity

`deploy.sh` stamps `-X main.buildSHA=$(git rev-parse HEAD)`. That is deliberate:

- `/health` reports `build.sha`, and probe `t1` asserts it against local `HEAD`
  ([protocol.md](../features/protocol.md) § the identity on `/health`). It is
  the only thing that distinguishes a green probe run against the new binary
  from one against a stale one, so the deploy produces that value rather than
  leaving the probe to infer it.
- `-trimpath` is passed, which is what makes the binary reproducible and
  path-free; with it, the toolchain's own VCS stamp is not something to lean on
  per build. `-X` supplies the same value explicitly, so identity does not
  depend on whether the build tree happened to be a git work tree.
- `version.go` already supported the override (`buildID.Source` becomes
  `"ldflags"`), so this is the production path for a field that was written for
  exactly this case.

The deploy's health check compares the reported `sha` against the local one, so
a stale binary or a service that failed to come up is a deploy failure rather
than a silent success. `HEALTH_URL` defaults to `/health` and not the site root
for that reason.

## Host facts

From komikan's deployment notes, and re-checkable there:

- SSH: `ssh tao` (root). `/home/dev/<name>` is `dev:dev`; the binary is
  root-owned 0755 because the deploy copies it as root.
- Port allocation on localhost: 18080 kxp, 18081 asteroids, 18082 komikan. Next
  free: 18083.
- systemd: `/etc/systemd/system/kxp.service`, `User=dev`,
  `WorkingDirectory=/home/dev/kxp`, `ExecStart=/home/dev/kxp/kxp -addr
  127.0.0.1:18080`.
- nginx + certbot: `kxp.tao.cl` (TLS via certbot, auto-renewal configured).

## Rejected: pulling and building on the VPS

The earlier flow was `ssh tao 'su - dev -c "cd /home/dev/kxp && git pull && go
build kxp"'`, i.e. the VPS held a checkout and built from it. It was dropped for
the source copy it kept on the host and the two toolchains it implied — the
identity of the deployed binary then depended on that checkout being clean, up
to date, and built with the same flags, none of which the deploy itself
verified. A stale remote checkout built on a `git pull` that silently failed
looks exactly like a successful deploy. The stamped-SHA health check is the
thing that makes the difference visible, and it is why the current form is not
merely fewer steps.
