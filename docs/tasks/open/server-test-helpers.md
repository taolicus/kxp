---
phase: 2
depends-on: []
gated-on: []
---

# Consolidate the Go test helpers

The Go test files each define their own request/connection helpers, and several
are the same function under different names. The suite is the project's main
safety net, so duplicated scaffolding is duplicated maintenance. Pure test
refactor: no production file changes.

## What is duplicated (lines as of the survey; behaviour is the contract)

- **`registerMoveTestClient` ≡ `registerTestClient`** — body-identical
  (`newClient`, set id, insert under `h.mu`). One should call the other.
- **Six POST helpers, two families** — the direct-handler family
  (`postQueue`, `postMove`, `postReady`) and the routes family (`postRoutes`,
  `postReport`, `postWithIP`) all build
  `httptest.NewRequest(POST, …)` + JSON header + `NewRecorder`. The three
  direct-handler helpers can share one routes-based `post(t, h, path, body)`
  (the handlers are registered on the mux); keep `postJSON` for the real-server
  tests.
- **`connectPlayer` / `connectSSE` / `connect`** — three variations of "open
  `/events` and spin until `connected`", differing in the `pid` param and what
  they return. Collapse to one, with the others as thin wrappers.
- **SSE frame parsing** — `sseStream.readOne` and `parseChunk` parse the same
  `event:`/`data:` lines from different sources.
- **`seriesMatchForTest` ≡ `oneRoundMatchForTest`** — identical but for the
  target and the id label.
- **Save/restore-a-package-var** — the pattern repeats in `series_test.go`,
  `challenge_test.go`, and `sse_lifetime_test.go`; a `freeze(t, &v, val)` covers
  the family.
- **Hand-built `&match{id: …}` literals** — six or more sites also wire
  `readyCh`/`now`/`phase` by hand; a `testMatch()` constructor removes the
  repetition (and pairs with the `match.id` removal in
  [engine-dead-state](engine-dead-state.md)).

## Constraints

- **No production edits.** This is scaffolding only.
- One family per commit; each must leave `go test ./...` green.
- Tests are the specification: a helper that changes what a test asserts is not
  a refactor. Where two helpers differ in a way that is *meaningful* (e.g. one
  takes a `pid`), keep the parameter, not a second function.
- `go test ./...` runs as its own step with a generous timeout, per
  [AGENTS.md](../../../AGENTS.md); on the phone hold a wake lock.

## Acceptance

`gofmt -l .` empty, `go vet ./...` clean, `go test ./...` green; a grep for each
duplicated helper shows a single definition plus call sites.
