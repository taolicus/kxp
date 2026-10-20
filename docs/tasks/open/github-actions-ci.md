---
phase: 2
depends-on: []
gated-on:
  - in-repo-browser-fixture
---

# GitHub Actions CI: recover the gates the phone cannot run

The phone is the primary dev host and cannot run two of the gates that matter:
`go test -race` refuses on android/arm64 ("race is not supported on
android/arm64"), and there is no Chromium for `npm run e2e`. The probe suite was
the original answer to the second half — it covers the deployed server over a
real network from the phone itself — but it covers the *server*, not the client
in a browser, and it says nothing at all about concurrency. Move that coverage
onto GitHub-hosted runners, the way the sibling [asteroids](https://github.com/taolicus/asteroids)
project did in its `features/continuous-integration.md`.

## Required context

- [verification.md](../../development/verification.md) § the gates, and § "The
  gap probes cannot close" — what is covered today, and exactly which claims a
  browser is required for. Adding a gate means adding it to that table, the run
  list in [AGENTS.md](../../../AGENTS.md) ("Verify"), and the host limits.
- [environment.md](../../development/environment.md) — the two hosts and what
  each cannot do. This task is the third runner, not a replacement for either:
  neither dev host changes.
- asteroid's landed form: `.github/workflows/ci.yml` in that repo
  (`go vet` + `go test -race` on `ubuntu-latest`, plus a `browser` job that
  installs Chromium and runs Playwright) and its `features/continuous-integration.md`
  for why the split is what it is.
- [automated-test-workflow.md](../closed/automated-test-workflow.md) — the
  Phase 2 item that parked exactly this, and why: "wire it into CI whenever a
  suitable host is available".

## Constraints

- **CI adds; it does not move the source of truth.** `AGENTS.md`'s rule that the
  phone is the primary host stands — the same suite still runs there. CI is the
  authority for the two claims the phone cannot make, not for the ones it can.
- **Never point CI at the deployed origin with injected match-making.** `npm run
  tall` creates real matches on the live public server, and `npm run e2e` does
  the same from a browser; a hosted runner running either would be load on
  production and a flaky gate for everyone. What CI can run is the part with no
  deployed server behind it.
- **`-race` is the point of the Go job.** It is the one thing no dev host here
  can produce at all, so a Go job that skips it is not worth the file.
- **Public-repo minutes.** `taolicus/kxp` is public, so hosted minutes are free
  and unbounded; no self-hosted runner, no secrets. `GITHUB_TOKEN` with
  `contents: read` is enough.
- The workflow file is the one deployment-shaped file this repo has ever carried
  and it is not a deploy script: [AGENTS.md](../../../AGENTS.md) forbids deploy
  tooling, systemd units and infra config here, and a workflow is none of those.
  If that read is wrong, fix `AGENTS.md` in the same commit rather than leaving
  two rules disagreeing.

## What the jobs are

1. **`test`** — `ubuntu-latest`, checkout + `actions/setup-go` on
   `go-version-file: go.mod`, `gofmt -l .` (must print nothing), `go vet ./...`,
   `go test -race ./...`. This is the race coverage that has never existed on
   either dev host.
2. **`unit`** — `actions/setup-node` + `npm ci`, `npm run unit` and `npm run
   links`. Both are origin-free by construction (that property is pinned by
   [unit-gate-needs-origin.md](../closed/unit-gate-needs-origin.md)), so they
   run on a runner with no server. `npm run links` costs nothing and catches the
   rename that nothing else here notices.
3. **`browser`** — `npx playwright install --with-deps chromium` + `npm run
   e2e` **against a locally booted server**, not the deployed one. This is the
   job that needs a decision, and it is gated below.

## Acceptance

- A push runs all three jobs on a public repo with no secrets.
- The `test` job fails on a real race and passes when it is removed — proven by
  reintroducing one deliberately in a scratch branch, not assumed.
- The `browser` job renders the lobby in CI without touching production.
- [verification.md](../../development/verification.md)'s gate table,
  [AGENTS.md](../../../AGENTS.md)'s run list and host limits, and
  [README.md](../../../README.md) all name CI and say which claims it now
  carries. A third runner that the docs do not describe is the drift this
  register exists to prevent.
