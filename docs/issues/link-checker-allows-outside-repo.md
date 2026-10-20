# The link checker resolves links outside the repository, so a pass depends on the host

**Provenance** — found by CI on the workflow-split push: `npm run links` passed
on the phone and failed on the GitHub runner, because a doc linked to a sibling
project directory that exists on the phone but not on the runner.

**Symptom** — `tools/check-links.mjs` resolves every link with
`existsSync(resolve(dirname(file), rel))` and nothing constrains the result to
the repository root. A link written as `../../../../asteroids/workflow/`
therefore *passes* locally whenever `/storage/emulated/0/lab/asteroids/` happens
to exist, and fails on any host that does not have the siblings checked out. The
gate's verdict depends on who runs it, which is the one thing a gate must not
do.

**Where it shows** — any doc that links to a path escaping the repo, which is
most likely in a task file written while reading a sibling for reference (exactly
how the workflow split produced one).

**Working hypothesis** — the checker was written for the "does this path exist"
question and the "is this path inside the repo" question was never asked,
because until a doc linked outward no case needed it. The fix is to resolve the
destination and reject anything that does not sit under `repoRoot`, reported the
same way a missing file is — so `../../../../asteroids/...` fails everywhere,
including on the host that has the siblings.

**What would prove the cause** — a `web/links.test.cjs` (or the existing
`tools/lib/links.test.mjs` suite) case that feeds the resolver an escaping link
and asserts it is rejected; and the current tree passing with the stricter check,
since nothing legitimately escapes the root today.

**Prospective fix (not scheduled)** — constrain `check-links.mjs`'s destination
resolution to `repoRoot` and cover it with a unit test, so the phone and CI can
no longer disagree about a link that leaves the tree. Separable from, and
revertable independently of, any doc that prompted it.
