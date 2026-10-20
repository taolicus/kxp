# Testing

Four gates, and a fifth runner in CI. Each covers something the others cannot,
which is why none of them is optional:

```sh
npm run links     # internal doc paths resolve, and each #fragment names a heading
go test ./...     # Go suite
npm run unit      # web/*.test.cjs + tools/lib/*.test.mjs
npm run e2e       # browser suite — boots its own server; needs Chromium
```

`npm run unit` is the catch-all for the client and harness tests; the files it
globs are not a list to reproduce by hand, and every `web/app.*.test.cjs` runs
the real `app.js` against a stubbed context, which nothing else covers. Pass a
subset to check part of the doc tree: `npm run links -- AGENTS.md docs/features`.

Run `go test ./...` as its own step with a generous timeout, never chained
behind another gate: a buffered pipe turns a working-but-slow run into an
apparent hang. On the phone, hold a wake lock around it.

## What no single host covers

`go test -race` is unsupported on the arm64-Android dev device and the phone has
no Chromium, so two gates cannot run there. **CI is the third runner** and adds
exactly those: `.github/workflows/ci.yml` runs `gofmt`, `go vet`, `go test` plain
and `-race`, `npm run unit`, `npm run links` and the browser suite on a
GitHub-hosted runner for every push and pull request. It never touches the
deployed server, and it does not replace the local gates — it is where the two
claims no dev host can make get made.

## The production probe suite

The browser-free probes (`tools/t1`–`t8`) are the integration path. They target
the **deployed server directly over the internet**, never boot the app locally,
need only Node >= 20, and take the production origin through a required
`BASE_URL`:

```sh
npm install
npm run t1                                   # measures the link first
BASE_URL=https://your-server.example npm run tall
```

`t1` asserts `/health`'s `build.sha` against local `HEAD`, so a green run against
a stale binary fails rather than reading as verification. See
[tools/README.md](../../tools/README.md) for what each probe proves and why the
origin is required rather than defaulted; the flows create real (short-lived)
matches by design. `npm run e2e` adds a Playwright suite that renders the lobby
in a real Chromium — against a server it boots itself, or against the origin
`BASE_URL` names.

What each gate does and does not cover is in
[verification.md](verification.md), and the host limits are in
[AGENTS.md](../../AGENTS.md).
