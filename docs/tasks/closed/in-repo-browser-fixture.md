# `npm run e2e` has no origin it is allowed to use in CI

**Symptom** — the browser suite (`npm run e2e`, three specs in `e2e/`) cannot run
in CI as it stands, and there is no version of it that can.

Every spec resolves its base URL through `playwright.config.mjs` →
`tools/lib/base.mjs`, which requires a real origin (`BASE_URL` or the gitignored
`tools/.base-url`) and exits 3 when it has none. The only origin any of them is
currently pointed at is the deployed server, and driving that from a hosted
runner means creating real matches on the live public server
([protocol.md](../../features/protocol.md) — the specs queue, ack and play).

**What would change it** — nothing on the phone. This is not a task waiting on
effort; it is waiting on an artifact: a way to serve the UI to a runner without
the production server behind it.

**Proves the cause** — a boot of the app on a runner that `/events` and the POST
endpoints answer on, with the browser pointed at it. Concretely, one of:

- `main.go` already serves the whole UI and API from one `http.ServeMux` with
  `-addr` (no external dependencies, `CGO_ENABLED=0`), so a runner can
  `go build -o kxp .` and run `./kxp -addr 127.0.0.1:18080` —
  `BASE_URL=http://127.0.0.1:18080 npm run e2e`. **Unverified here.** The phone
  cannot run Chromium, so this has not been tried; whether the specs depend on
  the production origin's nginx layer (headers, SSE buffering — see the nginx
  section of the sibling komikan deployment notes) is exactly what a first
  attempt would find out. `-addr` accepts an explicit address, so no port
  auto-pick is in the way.
- or the specs are made origin-injectable with a fixture the runner supplies.

**Why this gates the CI task** — [github-actions-ci.md](github-actions-ci.md)
schedules the browser job only behind this. Until there is an origin a runner may
use, the honest CI shape is the Go and unit jobs alone, and the browser gap stays
what it already is: closed on the laptop, open on the phone.

**Not the same as** the probe suite. `t1`–`t8` also need a deployed origin, and
they are *meant* to — their vantage is a real device over a real link
([tools/README.md](../../../tools/README.md)). This issue is only about the browser
suite, whose product is a render, not a link measurement.

## Landed

The first hypothesis proved out: the specs needed no part of the production
nginx layer, so a locally booted server satisfies every one of them. They drive
relative paths (`page.goto('/')`) against Playwright's `baseURL` and never
request `/health` — that is referenced only in comments — so `baseURL` was the
sole origin dependency, one line in the config.

**What was built.** `playwright.config.mjs` now has two modes. With no origin it
adds a `webServer` block that builds the app and runs it on `127.0.0.1:18080`,
and `baseURL` defaults to that; Playwright boots and tears it down with the run.
With `BASE_URL` or `tools/.base-url` set, the block is omitted entirely and the
suite drives that origin instead — the real-link run a human wants.

The config reads those two sources directly rather than through `resolveBase()`,
and that is the one subtle change. `resolveBase()` treats a missing origin as a
configuration error and exits 3; a missing origin is now the *common* case
(local mode selecting itself), so calling it would break the default path. The
probes keep that rule unchanged — they measure a link and are meaningless
without an origin; these specs produce a render and are better served by a
server they control.

**Verified on the phone** (no Chromium here, so the suite itself was not run —
see the gap below):

- `go build -o … .` succeeds; the binary boots with `-addr 127.0.0.1:18080`;
  `GET /` is 200 and carries `id="online"`; `/app.js` is 200; `/events` streams
  `text/event-stream` with `Cache-Control: no-cache` and `X-Accel-Buffering: no`.
  That last header is set by the app, not nginx, which is the concrete reason
  the production proxy layer is not needed behind the fixture.
- No port auto-pick is relied on: `-addr` pins 18080, and since `main.go` only
  *logs* a taken port and then scans 8000–8999, the `webServer` `url` probe —
  not the bind — is what proves the server answered.
- `gofmt -l .` clean, `go vet ./...` clean, `go test -count=1 ./...` ok (226s),
  `npm run unit` 222/222, `npm run links` 137 docs / 460 links / 0 broken.

**Not verified here, and this is the honest gap:** Playwright and Chromium
cannot run on the phone, so the config's two modes, the `webServer` boot, and
the CI `browser` job are verified by the first CI run and not before it. The
local boot above is what makes that run's success expected rather than hoped
for, but it is not the same claim as a green browser job.

**And that run has now happened.** CI run `39409579853` on the landing commit
reported `test`, `unit` and `browser` all `success`, with the browser job's
`Install Chromium` and `Browser suite` steps green. Read against the paragraph
below, production's `/health` was `activeMatches: 0` immediately after it, so
the match the suite played was created on the runner and not on the public
server. That is the whole claim this fixture makes, and it is now machine-checked
rather than argued.

**That claim is about the `browser` job, and the `browser` job is green.** The
`test` job is a separate matter: the next run (`39410641914`, a docs-only commit
that touched no Go test) failed its `-race` step on a pre-existing, intermittent
race in `sse_lifetime_test.go` — a leaked match goroutine, filed with its
diagnosis in
[test-helper-goroutine-leak.md](../open/test-helper-goroutine-leak.md) and deferred to
the laptop, which is the only host that can run `-race`. So the browser fixture
is verified and CI as a whole is not durably green until that race is fixed; the
two claims are separate and this record does not conflate them.

**The negative proof for "local mode really is local"** is the same one the CI
task already relies on: `npm run tall` is deliberately absent from CI because it
creates matches on the live server, and this suite is only admissible here
because it does not. If the fixture were wrong and the suite still pointed at
production, the browser job would be creating matches on a public server on
every push — so the run must be confirmed green *and* production's
`/health.activeMatches` observed at rest alongside it.

**Resolution of the sibling task.** [github-actions-ci.md](github-actions-ci.md)
specified this job as "against a locally booted server, not the deployed one"
(its acceptance item 3) and then recorded it absent rather than stubbed, because
this fixture did not exist. The job now exists as that item described, so the
CI task's browser portion is complete and this file is its confirming record.
