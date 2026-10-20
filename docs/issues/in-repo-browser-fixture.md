# `npm run e2e` has no origin it is allowed to use in CI

**Symptom** — the browser suite (`npm run e2e`, three specs in `e2e/`) cannot run
in CI as it stands, and there is no version of it that can.

Every spec resolves its base URL through `playwright.config.mjs` →
`tools/lib/base.mjs`, which requires a real origin (`BASE_URL` or the gitignored
`tools/.base-url`) and exits 3 when it has none. The only origin any of them is
currently pointed at is the deployed server, and driving that from a hosted
runner means creating real matches on the live public server
([protocol.md](../features/protocol.md) — the specs queue, ack and play).

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

**Why this gates the CI task** — [github-actions-ci.md](../tasks/closed/github-actions-ci.md)
schedules the browser job only behind this. Until there is an origin a runner may
use, the honest CI shape is the Go and unit jobs alone, and the browser gap stays
what it already is: closed on the laptop, open on the phone.

**Not the same as** the probe suite. `t1`–`t8` also need a deployed origin, and
they are *meant* to — their vantage is a real device over a real link
([tools/README.md](../../tools/README.md)). This issue is only about the browser
suite, whose product is a render, not a link measurement.
