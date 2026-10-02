# Deploy identity on `/health`

Landed. Status and summary live in the roadmap entry under
**Phase 2 — Testing & observability** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

**The gap this closed.** The suite points at a deployed origin, and the
origin reported no version of itself. Every live result was therefore
conditional on an assumption nobody could check — that the deploy had
actually happened and restarted. A green suite against a stale binary is
*worse* than no suite, because it reads as verification. This is the same
failure shape as the probe origin defaulting to the wrong host earlier in
Phase 2: a suite that looks authoritative while measuring the wrong thing.
The suite cannot detect its own misconfiguration, so the check had to be
explicit and had to run first.

**No build script.** The identity comes from Go's automatic VCS stamping,
so a plain `go build -o kxp .` inside the work tree identifies itself with
no deploy-time discipline to forget. `modified` is reported separately from
`sha` so a dirty tree cannot masquerade as its commit. `buildSHA` is a
`-ldflags -X` escape hatch for builds outside a work tree; `go test` does
not stamp test binaries, so the parser is unit-tested from synthetic
settings instead, and only a real binary on the deployed origin exercises
the stamped path end to end.

**Verified** by building locally and confirming the served sha equals
`git rev-parse HEAD` byte for byte, and by running `t1` against the
then-deployed binary — which predates this change — and watching it fail
with `ABSENT` instead of passing. That negative case is the real proof: the
check reports a stale build rather than green-lighting it.
