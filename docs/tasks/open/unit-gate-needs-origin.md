---
phase: 2
depends-on: []
gated-on: []
---

# `npm run unit` should not need a deployed origin

`npm run unit` is listed in
[verification.md](../../development/verification.md) as a local gate with no
origin behind it — the whole point of that column is that it runs without a
server. On a host with no `tools/.base-url` and no `BASE_URL` in the
environment it does not run at all: `tools/lib/verdict.test.mjs` dies as a
single file (`pass 0, fail 1`) after printing the "No origin for the probes to
target" guidance, and the run exits 3 rather than reporting a test result.

## Mechanism (traced, not hypothesised)

`tools/lib/harness.mjs:24` is `export const BASE = resolveBase();` — a
module-scope call. `resolveBase()` (`tools/lib/base.mjs:78`) throws
`ConfigError` when there is no origin, and `base.mjs`'s `uncaughtException`
handler turns that into `process.exit(3)` with guidance. Any importer of
harness therefore exits before a single test body runs, and `verdict.test.mjs`
imports harness for `makeReporter`.

The exit-3-on-missing-origin behaviour is deliberate and worth keeping —
`base.mjs`'s comment says a missing origin is a configuration mistake, not a
test failure, and a probe running against an empty origin would read as a pass
against an untested server. `tools/run-all.mjs:26-28` already resolves the
origin itself, before anything else runs.

## The build

Resolve the origin lazily so importing harness costs nothing: a `base()`
accessor (or an equivalent) called on first use, with the three call sites that
read `BASE` today (`harness.mjs:77`, `:149`, `:409`) going through it. Probe
entry points must still fail loudly *at startup* with the same guidance rather
than mid-run — `run-all.mjs` already does, and a single-probe entry
(`npm run t1`) should resolve once before its first fetch.

Pin it with a test that imports `verdict.test.mjs`'s dependencies, or runs the
unit suite, with neither `BASE_URL` nor `tools/.base-url` present and asserts
the tests actually run. Until that lands, the honest state of a host without an
origin is that one of the four documented gates cannot be run at all.
