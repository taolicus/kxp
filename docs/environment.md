# Development environment

**This is the primary development environment for the project.** Every change
here is written, built, and first verified here.

This file is the *measured* host: what it is, what is installed on it, and how
to re-measure both. It deliberately does **not** carry the rules for verifying a
change — the commands to run, and the four things this host cannot verify, live
in `AGENTS.md` ("Verify"), because those apply to every task and are read far
more often than this page. What is below earns a read only when a task touches
the build, the toolchain, or a claim about what this machine can do.

Facts here were measured on this host, not inferred from CI config — re-run the
commands in "Verifying" to confirm them on a new machine.

## The host

A phone running Android 14 under **Termux**, not a Linux workstation. That
single fact drives most of the constraints in the rest of this document, so it
is worth internalising before optimising for a desktop workflow.

| property | value |
| --- | --- |
| kernel | `Linux localhost 6.1.162-android14-11-… aarch64` |
| userspace | Termux (Android 14); shell tools are Termux builds, not glibc/Linux distro builds |
| CPU | 8 cores, `aarch64` |
| memory | ~11.5 GB total, ~4.4 GB available at time of check |
| workspace | `/storage/emulated/0/lab/kxp`, which resolves to the Termux home directory (`/data/data/com.termux/files/home/lab/kxp`) |
| storage | Android **emulated shared** storage, FUSE-backed `/storage/emulated` — 110 GB total, ~74 GB free |

`/storage/emulated/0/lab/kxp` is therefore FUSE shared storage, not internal
flash: heavy IO (large builds, `node_modules`, the ~50 MB `kxp` binary) is
noticeably slower than it would be on internal storage, and other apps on the
device can see the tree. Treat the built binary as a disposable local artifact —
it is gitignored.

## Toolchain

| tool | version | note |
| --- | --- | --- |
| Go | `go1.27.1` | `GOOS=android`, `GOARCH=arm64`, `CGO_ENABLED=1` |
| Node | `v24.18.0` | satisfies the `engines.node >= 20` requirement |
| npm | `11.19.1` | |

`package.json` declares **no dependencies**, and nothing browser-based is
installed: there is no Playwright and no Chromium. That is a decision, not an
omission — the Playwright e2e suite was withdrawn (`31a0384`), and the
browser-free probe suite is the integration path on this host. The reasoning,
and what a browser-level suite would require, is recorded against the
"Automated test workflow" roadmap item.

## Verifying

Cheap re-checks of the facts on this page:

```sh
uname -a                      # kernel + arch
go version && go env GOOS GOARCH CGO_ENABLED
node -v && npm -v
go test -race -run TestNothingZZZ ./...   # prints "race is not supported on android/arm64"
nproc && free -m | head -2
ls node_modules/@playwright 2>/dev/null || echo "no browser harness, as expected"
```