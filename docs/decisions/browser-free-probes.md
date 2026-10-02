# Protocol-level production probes (browser-free)

Landed. Status and summary live in the roadmap entry under
**Phase 2 — Testing & observability** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

The design constraint that matters: verdicts are split into PASS / FAIL /
INCONCLUSIVE, and an inconclusive verdict always names its reason — link
dropped, self-rate-limited, or a readiness gate that expired because the
link was too slow to deliver a `/ready` ack in time — because the suite is
run over unreliable links and a suite that cannot tell a transport fault
from a server defect trains you to ignore it. `tall` exits 1 on a real
failure and 2 on an inconclusive one.
*Known gap: rendering, CSS and in-browser console errors have no
automated coverage anywhere in this repo, since the Playwright suite was
withdrawn. Client state machine and server internals stay offline
(`npm run unit`, `npm run go`). It already earned its keep — it traced the stale-teardown race filed in Phase 1 and
measured the zero-grace drop behaviour recorded in
[docs/issues/drop-loss.md](../issues/drop-loss.md).*
