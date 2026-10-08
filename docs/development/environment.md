# Development environment

**Two hosts develop this project.** The phone below is the primary one: every
change in this repo was first written, built, and verified there. The MacBook
Pro is the second.

This file is the *measured* record of both: what they are, what is installed on
each, and how to re-measure. It deliberately does **not** carry the rules for
verifying a change — the commands to run, and what each host cannot verify, live
in `AGENTS.md` ("Verify"), because those apply to every task and are read far
more often than this page. What is below earns a read only when a task touches
the build, the toolchain, or a claim about what a machine here can do.

The design behind the commands is in [verification.md](verification.md): what
each gate does and does not cover, and why the integration path has both a
browser-free probe suite and a browser-driven suite against the same deployed
origin.

Facts here were measured on these hosts, not inferred from CI config — re-run
the commands in "Verifying" to confirm them on a new machine. Which of the two
a task belongs on, and how a deferral is recorded, is
[device-aware-workflow.md](device-aware-workflow.md).

## Host 1: the phone (primary)

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

## Host 2: the MacBook Pro

An Intel MacBook Pro, added as a second development host. Measured, not
inferred:

| property | value |
| --- | --- |
| model | `MacBookPro16,1` — 16-inch, 2019 (Intel, not Apple silicon) |
| kernel | `Darwin 25.6.0 … RELEASE_X86_64 x86_64` |
| userspace | macOS 26.6.2 (`25G83`) |
| CPU | Intel Core i7-9750H @ 2.60 GHz, 12 logical cores |
| memory | 16 GB total |
| workspace | `/Users/tao/lab/kxp` on APFS local disk |
| storage | 466 GB total, ~42 GB free at time of check |

Unlike the phone, this host has local flash storage (no FUSE), so heavy IO is
not the tax it is on the phone.

Three capability differences matter more than the hardware does:

- **`go test -race` runs here.** It refuses on the phone
  (`race is not supported on android/arm64`); on this host it compiles and runs,
  measured with `go test -race -run TestNothingZZZ ./...` → `ok kxp`. Concurrency
  changes can therefore be race-checked here, even though the phone still cannot.
- **`go test ./...` is timeable here.** The phone's wall time drifts for thermal
  and FUSE reasons; this host does not inherit that, so a duration measured on it
  is a fact about this host only and says nothing about the phone.
- **The browser suite runs here.** `npm run e2e` drives a real Chromium, which
  installs on this host (`npx playwright install chromium`, one time) and cannot
  be installed under Termux. A rendering or in-browser claim is checkable here
  and hand-checked on the phone.

## Toolchain

| tool | phone | MacBook Pro | note |
| --- | --- | --- | --- |
| Go | `go1.27.1` | `go1.26.5` | phone: `GOOS=android`, `GOARCH=arm64`, `CGO_ENABLED=1`; Mac: `GOOS=darwin`, `GOARCH=amd64` |
| Node | `v24.18.0` | `v24.3.0` | both satisfy the `engines.node >= 20` requirement |
| npm | `11.19.1` | `11.4.2` | |

`go.mod` declares `go 1.26.5`, which both toolchains satisfy.

`package.json` declares one dependency: `@playwright/test`, the browser harness
behind `npm run e2e`. It is JavaScript and installs on both hosts, but only this
host can *run* it — running it needs Chromium, and Chromium cannot be installed
under Termux on arm64 Android. That was the entire reasoning behind withdrawing
the earlier suite (`31a0384`,
[core-gameplay-e2e-withdrawn.md](../tasks/closed/core-gameplay-e2e-withdrawn.md)):
one host, and it could not run the suite. There are two hosts now, so the
harness is installed again; `npx playwright install chromium` is the one-time
browser setup on a host that can do it. The probes in `tools/` stay
browser-free, which is what keeps them runnable on the phone.

## Verifying

Cheap re-checks of the facts on this page. The first four work on either host,
the next two are phone-only (macOS has neither `nproc` nor `free`), and the last
is Mac-only — the phone has no way to install Chromium, which is why the browser
suite is a laptop gate:

```sh
uname -a                      # kernel + arch
go version && go env GOOS GOARCH CGO_ENABLED
node -v && npm -v
npx playwright --version      # the harness package; installs on either host
nproc && free -m | head -2    # phone only
go test -race -run TestNothingZZZ ./...   # phone: "race is not supported on android/arm64"; Mac: "ok kxp"
ls ~/Library/Caches/ms-playwright | grep chromium   # Mac only: the browser `npm run e2e` drives
```