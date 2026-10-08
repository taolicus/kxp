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
each gate does and does not cover, and why the integration path is a
browser-free probe suite against a deployed origin rather than an e2e run.

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

Two capability differences matter more than the hardware does:

- **`go test -race` runs here.** It refuses on the phone
  (`race is not supported on android/arm64`); on this host it compiles and runs,
  measured with `go test -race -run TestNothingZZZ ./...` → `ok kxp`. Concurrency
  changes can therefore be race-checked here, even though the phone still cannot.
- **`go test ./...` is timeable here.** The phone's wall time drifts for thermal
  and FUSE reasons; this host does not inherit that, so a duration measured on it
  is a fact about this host only and says nothing about the phone.

## Toolchain

| tool | phone | MacBook Pro | note |
| --- | --- | --- | --- |
| Go | `go1.27.1` | `go1.26.5` | phone: `GOOS=android`, `GOARCH=arm64`, `CGO_ENABLED=1`; Mac: `GOOS=darwin`, `GOARCH=amd64` |
| Node | `v24.18.0` | `v24.3.0` | both satisfy the `engines.node >= 20` requirement |
| npm | `11.19.1` | `11.4.2` | |

`go.mod` declares `go 1.26.5`, which both toolchains satisfy.

`package.json` declares **no dependencies**, and nothing browser-based is
installed: there is no Playwright and no Chromium. That is a decision, not an
omission — the Playwright e2e suite was withdrawn, and the browser-free probe
suite is the integration path on this host. The reasoning, and what a
browser-level suite would require, is in
[automated-test-workflow.md](../tasks/closed/automated-test-workflow.md).

## Verifying

Cheap re-checks of the facts on this page. The first four work on either host;
the last two are phone-only (macOS has neither `nproc` nor `free`):

```sh
uname -a                      # kernel + arch
go version && go env GOOS GOARCH CGO_ENABLED
node -v && npm -v
ls node_modules/@playwright 2>/dev/null || echo "no browser harness, as expected"
nproc && free -m | head -2    # phone only
go test -race -run TestNothingZZZ ./...   # phone: "race is not supported on android/arm64"; Mac: "ok kxp"
```