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
- [automated-test-workflow.md](./automated-test-workflow.md) — the
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
   [unit-gate-needs-origin.md](./unit-gate-needs-origin.md)), so they
   run on a runner with no server. `npm run links` costs nothing and catches the
   rename that nothing else here notices.
3. **`browser`** — `npx playwright install --with-deps chromium` + `npm run
   e2e` **against a locally booted server**, not the deployed one. This is the
   job that needs a decision, and it is gated below.

## Acceptance

- A push runs the origin-free jobs on a public repo with no secrets.
- The `test` job fails on a real race and passes when it is removed — proven by
  reintroducing one deliberately in a scratch branch, not assumed.
- The `browser` job renders the lobby in CI without touching production.
- [verification.md](../../development/verification.md)'s gate table,
  [AGENTS.md](../../../AGENTS.md)'s run list and host limits, and
  [README.md](../../../README.md) all name CI and say which claims it now
  carries. A third runner that the docs do not describe is the drift this
  register exists to prevent.

## Landed

Jobs 1 and 2 are in `.github/workflows/ci.yml`; job 3 is still gated and is not
in the file. The task moves here with the first two landed because they are
independently useful and independently revertable, and because leaving the whole
item open behind a browser fixture it does not depend on would report scheduled
work as unstarted. The `test` job is red at landing — the `-race` step found a
real defect on its first run (below) — but the job itself is what landed and what
the follow-up task is verified against.

**What landed.** `test` (checkout, `setup-go` on `go-version-file: go.mod`,
`gofmt`, `go vet ./...`, `go test ./...`, `go test -race ./...`) and `unit`
(`setup-node` 22 with npm caching, `npm ci`, `npm run unit`, `npm run links`),
both on `ubuntu-latest`, both with `timeout-minutes: 10`, triggered on push and
pull request with `contents: read`. Public repo, so no secrets and free minutes.

**`gofmt` is the one gate that differs between local and CI.** Locally it is
`gofmt -l .` and a person reading the output; that command exits 0 on an
unformatted tree, so as a CI step it would pass on everything. The step captures
the output and fails on non-empty. Verified to bite: with a deliberately
misformatted file in the tree the wrapper failed and named it, and with the tree
clean it passed — the bare `gofmt -l .` exited 0 in both cases.

**Origin-free was checked, not assumed.** With `tools/.base-url` moved away and
`BASE_URL` unset — a runner's exact situation — `npm run unit` passed 222/222 and
`npm run links` reported 136 documents, 443 links, 0 broken. That is the
property [unit-gate-needs-origin.md](./unit-gate-needs-origin.md) landed, and it
is what lets the `unit` job exist without a server.

**`go test -race` is the one gate this slice cannot claim green, and the first CI
run is why.** `-race` refuses on android/arm64, so the step exists only to be run
by the runner — and it failed there, on a real race in the *test harness*
(`noSeriesBreak` writing the package-level `seriesBreak` while another test's
match goroutine reads it in `round.go:921`). That is precisely the class of defect
no dev host here could have found, and it is filed as
[test-helper-package-var-race.md](../../tasks/open/test-helper-package-var-race.md)
rather than fixed here: it is a test-harness concern with its own build, not CI
wiring, and widening this slice to include it would make the CI commit
unrevertable on its own. **`go test -race ./...` is therefore failing in CI at the
time this landed, and the `test` job is red until that task lands.** Saying so is
the point: a red gate that everyone knows about is a queue of work, while a green
one silently skipped is a lie.

What the first run *did* prove about the wiring: `gofmt`, `go vet` and plain `go
test ./...` (206s) all passed on the runner, and the `unit` job passed in full.
The mechanics of the job are sound — it is the suite it runs that has the defect.

**`go1.26.5`, the version `go-version-file: go.mod` resolves, exists in the Go
release index**, so `setup-go` will not fail on an unknown toolchain.

**Not done, and why.** The `browser` job is absent rather than stubbed: `npm run
e2e` resolves its origin through `playwright.config.mjs` → `tools/lib/base.mjs`,
which requires a real origin, and the only origin in existence is production —
which a runner must not use. That is
[in-repo-browser-fixture.md](../../issues/in-repo-browser-fixture.md), still open.
The three acceptance items above that name all three jobs or the browser job
remain unmet on purpose; they belong to whoever answers that issue, and the
verification docs say so rather than implying a browser is covered.
