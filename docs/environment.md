# Development environment

**This is the primary development environment for the project.** Every change
here is written, built, and first verified here; anything that cannot be
exercised here (see "What this host cannot verify") is verified against the
deployed server instead. Facts below were measured on this host, not inferred
from CI config — re-run the commands in "Verifying" if you need to confirm them
on a new machine.

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
| Playwright | `@playwright/test` installed in `node_modules` | browser binaries live outside the repo |

### Consequences

- **`go test -race` does not work here.** The toolchain refuses immediately:
  `race is not supported on android/arm64`. This is not a project setting and
  cannot be worked around. Every concurrency change is therefore hand-checked
  rather than race-checked, which is why `finishMatch`'s per-side teardown
  decision is taken under `h.mu` and pinned by tests that drive the pointer
  states directly (`finish_test.go`). When a change touches shared state
  (`h.mu`, `c.mu`, the match phase atomics), assume it needs that kind of
  deliberate argument, and say so in the code comment.
- **Locally built binaries are not the deployed artifact.** With
  `GOOS=android`, `go build -o kxp .` produces a binary for this phone. The
  server builds its own on its own host (an ops script kept outside this repo
  does `git pull` + build + `systemctl restart`). Only the *source* is shared,
  so "it works here" is never sufficient evidence that a change is live.
- **Playwright cannot run here.** The npm package is installed but Chromium's
  browser binaries and Linux dependencies are unavailable on this platform
  (recorded in the roadmap, Phase 2, protocol-probe entry). `npm run e2e` must
  run on a Chromium-capable host with `BASE_URL` pointed at the deployed
  origin.
- **The browser-free probe suite (`tools/t1`–`t8`) is the on-device
  integration path.** It needs only Node and talks to a real server over real
  SSE, so it runs here — and it is designed to run against the *deployed*
  origin rather than a local boot (see `tools/README.md` and the gitignored
  `tools/.base-url`). Treat it as the first integration gate for anything
  touching the wire format.

## The working loop

```sh
go test ./...                                   # Go suite (~60s here; passes)
node --test web/kxp.test.cjs web/machine.test.cjs web/app.countdown.test.cjs
npm run tall                                    # probes t1-t8 against the deployed origin
npm run e2e                                     # Playwright — NOT here; needs a Chromium host
```

`go test ./...` takes roughly a minute on this hardware, so batch Go edits
before running it rather than re-running per change. `npm run unit` is the
catch-all for the client and probe-harness tests (`web/*.test.cjs`,
`tools/lib/*.test.mjs`); the README's shorter `node --test web/kxp.test.cjs
web/machine.test.cjs` omits `web/app.countdown.test.cjs`, so prefer `npm run
unit` when you want the full client set.

## What this host cannot verify

State these limits in code comments and in any report you give, rather than
implying coverage that does not exist:

1. **Race-detector findings** — unavailable (see above).
2. **Rendering, CSS, in-browser console errors** — Playwright-only, so a
   client-side change can be unit-tested here but not visually confirmed.
3. **Deployment** — whether a change is actually live on the public server.
   `/health`'s `build.sha` and probe `t1` exist for exactly this; use them
   before believing any live result.
4. **Real mobile radio behaviour** — the ready-handshake budget, the PUN-window
   latency profile, and drop frequency are all things this host cannot
   reproduce. `docs/issues.md` keeps them as unconfirmed for that reason;
   answering them needs measurements from real links, not a faster loop.

## Verifying

Cheap re-checks of the facts on this page:

```sh
uname -a                      # kernel + arch
go version && go env GOOS GOARCH CGO_ENABLED
node -v && npm -v
go test -race -run TestNothingZZZ ./...   # prints "race is not supported on android/arm64"
nproc && free -m | head -2
```