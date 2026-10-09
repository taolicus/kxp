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

## Landed

The origin is resolved on first use, so importing the harness costs nothing and
`npm run unit` runs on an origin-less host; a probe still fails loudly before
its first fetch.

**What changed.** `tools/lib/harness.mjs` no longer calls `resolveBase()` at
module scope; a lazy `base()` accessor resolves once and caches, and the three
old `BASE` reads (`request`, `Sse.open`, `script`'s header) go through it. The
`ConfigError` a probe hits is thrown from `script()`'s first statement, so it
reaches `base.mjs`'s `uncaughtException` handler through the probe's top-level
`await` — the same guidance and exit 3 as the module-scope form produced. The
exit-3 policy is untouched and stays in `base.mjs`. `base.mjs`'s comment and
`run-all.mjs`'s now describe resolution as first-use rather than import-time,
and [verification.md](../../development/verification.md) records the gate as
origin-free and names the pin.

**Why a lazy accessor rather than each entry point resolving its own origin.**
`run-all.mjs` already resolves up front and keeps that; the single-probe scripts
do not, and eight copies of a resolve-and-report block is eight copies that can
drift. Resolving inside `script()`, which every probe already funnels through,
keeps it in one place.

**Verified to fail against the old code.** `tools/lib/harness.test.mjs` runs
three children — importing the harness, running `verdict.test.mjs`, and running
`t1` — all with `BASE_URL=not-a-url`. An invalid env value wins over
`tools/.base-url` in `resolveBase()`, so resolution would be rejected if it
happened, whatever the local file says; that is why the pin does not merely
unset `BASE_URL`, which would prove nothing on the dev host where
`tools/.base-url` is present. Against the pre-change harness the two laziness
children failed (the import exited 3; the suite reported "pass 0, fail 1") and
the loud-failure child passed; after the change all three pass. The first two
therefore cannot silently rot, and the third pins the negative direction.

**Verified green.** `npm run unit` — 189 tests, 189 pass (the 186 before plus
the three new). `npm run links` — 101 documents, 350 links, 0 broken. Go
untouched, so `gofmt`/`go vet`/`go test` are unaffected.
