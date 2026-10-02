# AGENTS.md — how to work in this repo

KACHIPUN TOURNAMENT (`kxp`): a single-binary Go RPS game with an embedded web
UI, SSE push, and POST actions. Server-authoritative rules; the browser renders.

**The house rule: one small slice at a time, and each slice leaves the tree
green.** A slice is one concern — one fix, one field, one probe, one doc
paragraph — that can be read, reviewed, tested, deployed, and reverted on its
own. Anything larger gets split before it gets written. Every slice in this
repo's history is one commit that a reader can hold in their head.

Read what the task touches, not the whole repo. A full sweep of the text here is
~452KB; the engine, hub, client, and the three files that always apply are
~122KB of it — 27%. Almost all the difference is the probe suite and the test
bodies, and neither is needed to change behaviour: the docs and the commit that
landed a change name the one test or probe that is relevant.

**Every task:** [docs/architecture.md](docs/architecture.md) (engine, timing
model, matchmaking, SSE lifecycle).

**When the task reaches them:**

- a claim about this host — [docs/environment.md](docs/environment.md): the
  measured host, toolchain, and the commands to re-measure them. Read it when
  the task touches the build, the toolchain, or a claim about what this machine
  can do — not every task, because the per-task verification rules it used to
  carry live in [Verify](#verify) below instead.
- wire changes — [docs/protocol.md](docs/protocol.md): events, endpoints, the
  client state table, clock handling
- scheduling or picking up work — [docs/tasks/open/](docs/tasks/open/): one file
  per specified build, `priority` integer in the frontmatter, lower is more urgent
- what a phase was for, and what landed in it —
  [docs/roadmap.md](docs/roadmap.md): the phase structure and a link per landed
  item, which is why the phases are ordered as they are
- why a landed item is the way it is —
  [docs/tasks/closed/](docs/tasks/closed/): one file per landed item, each linking
  its rationale in [docs/decisions/](docs/decisions/)
- a symptom that looks familiar — [docs/issues/](docs/issues/): entries are
  **unconfirmed** by definition
- re-litigating a landed decision — [docs/decisions/](docs/decisions/): one file
  per decision

**Deliberately not read as a sweep.** `tools/` is ~24% of the text in this repo
and earns a read only when changing the probes or the verdict logic — then read
`tools/lib/harness.mjs` and the one probe involved. Test bodies (21
`*_test.go`, plus `web/*.test.cjs` and `tools/lib/*.test.mjs`) are another ~27%,
and the landing commit names the one that matters. `web/style.css` and
`web/img/` have no coverage on this host (see "Verify" below), so reading them
cannot be validated here either.

## The loop

```sh
# 1. read the relevant docs + the code they name, end to end, before editing
# 2. make the smallest change that fully fixes one thing
# 3. add the test that pins it (see "Test first" below)
# 4. verify (below), 5. document (below), 6. commit, 7. push
```

Steps 3–5 belong to the same commit as the code. Docs are not a follow-up
commit; a documented-later change is a change nobody can verify. Step 7 happens
before the next task starts, not at the end of the session — see
[Commit and push](#commit-and-push).

### Pick the slice size

Ask: *could this commit be reverted without stranding the repo?* If reverting
leaves a feature half-wired, a test asserting behaviour that no longer exists,
or docs describing code that is gone — the slice is too big. Split it. This is
why the connectivity work landed as a series of single-trace commits
(`5694980`, `7eec97c`, `a50628d`, `02047ff`, …) rather than one observability
rewrite: each one produces evidence, and each is independently deployable.

Do **not** park a half-finished refactor in the tree. Roadmap items exist for
structural work that is deliberately unscheduled ("One owner for match
termination") — write the reasoning there, leave the code alone.

### Keep the session small too

Slice size is not only a review concern. A slice small enough to finish, test,
document, commit, and push inside one context window is what keeps a long
working session from losing its own thread.

**Compact between tasks, never mid-slice.** `/compact` (alias `/summarize`,
keybind `ctrl+x c`) frees context by summarising the conversation, and that
summary is lossy in exactly the place a slice cannot afford: which files are
staged, what the new test asserts and what it was checked to fail against, which
line of reasoning ruled out the alternative you rejected, what the commit body
was going to say. A compacted mid-slice resumes with a paraphrase of work whose
entire value is that it is exact.

So the boundary is the slice: **finish the slice — verified, documented,
committed, pushed — and only then compact.** At that point there is nothing to
lose, because the state that matters lives in git rather than in the
conversation: the next task starts from a clean tree and a pushed commit, and
the summary only has to carry the intent forward. `/new` (alias `/clear`) is
the blunter version of the same move, for when a fresh session is worth more than
a summary.

Two corollaries. If compaction feels imminent *during* a slice, that slice is
too big — split it now rather than after the fact. And never let a slice
straddle a compaction boundary: park it first, committed if it is verified or
reverted if it is not, so nothing in the tree depends on context that is about
to be summarised away.

### Test first, and prove the test bites

- Add or extend a test **in the same commit** as the change. A behaviour change
  with no test is not finished.
- **Check the new test fails against the pre-change code** before you believe
  it. This repo does this and says so in the commit body ("Verified to fail
  against the old handler", "checked to *fail* against the old wall-only form,
  so it cannot silently rot"). A test that passes both before and after pins
  nothing.
- Also pin the **negative direction** when you fix a bug, so an over-correction
  is caught: `finish_test.go` asserts both "the re-paired side gets no frame"
  and "the normal path still tells both sides to go idle".
- Deterministic tests only. No sleeps to sequence goroutines, no reliance on
  wall-clock luck. Inject the clock or drive the state pointers directly — that
  is how order-dependent races are tested here, since `-race` cannot run on this
  host (below).
- When a test cannot be written (the bug is a clock step, a rare interleave),
  pin the **structural property** instead and say in the comment which live
  signal remains the canary (`monotonic_test.go`, `t5`).

### Verify

```sh
gofmt -l .          # must print nothing
go vet ./...
go test ./...       # ~60s on this host; batch Go edits, don't re-run per edit
npm run unit        # web/*.test.cjs + tools/lib/*.test.mjs
npm run tall        # probes t1–t8 — requires an origin (see below), creates real matches
```

`npm run unit` is the catch-all for client and harness tests (the README's
shorter `node --test web/kxp.test.cjs web/machine.test.cjs` misses
`web/app.countdown.test.cjs`).

**This host cannot verify** — state these limits in the commit body and in any
report, rather than implying coverage that does not exist:

1. **Race detector** — `go test -race` refuses: `race is not supported on
   android/arm64`. Not configurable. Concurrency changes are hand-checked and
   argued in a comment: when a change touches shared state (`h.mu`, `c.mu`, the
   match phase atomics), name that state in the comment and say why the
   ordering holds. `finishMatch`'s per-side teardown is the worked example — the
   decision is taken under `h.mu` and pinned by `finish_test.go`, which drives
   the pointer states directly instead of racing two goroutines.
2. **Rendering / CSS / console errors** — No automated coverage on this host.
3. **Deployment** — a local build is not the deployed binary, and "it works
   here" is never evidence a change is live. `GET /health` reports `build.sha`;
   probe `t1` asserts it against local `HEAD` and fails loudly on a stale build.
   That negative case is the point — a green probe run against a stale binary
   reads as verification and is not.
4. **Real radio behaviour** — ready-gate budget, PUN-window latency, drop
   frequency. Unmeasurable here; `docs/issues/` stays honest because of it.

**Probing the deployed server** (never a local boot for the integration gate):

```sh
echo 'https://your-host' > tools/.base-url   # gitignored, required, never committed
BASE_URL=https://your-host npm run tall
npm run tall -- t5 t6                       # subset
QUICK=1 npm run tall                        # creates no matches
```

`npm run t1` first, always: it measures the link, so every later number can be
read against it. Verdicts are PASS / FAIL / **INCONCLUSIVE**, and an
inconclusive verdict always names its reason — a suite that cannot tell a
transport fault from a server defect trains you to ignore it. Do not "fix" an
INCONCLUSIVE into a FAIL.

### Document in the right place

- **Wire format / events / state table** → [docs/protocol.md](docs/protocol.md).
- **Internals, invariants, mechanisms** → [docs/architecture.md](docs/architecture.md).
- **A work item's status** — its own file in [docs/tasks/open/](docs/tasks/open/)
  if the next action is a specified build, [docs/issues/](docs/issues/) if the
  next action is to find out or decide, and [docs/tasks/closed/](docs/tasks/closed/)
  once it has landed. The directory *is* the status; see "One home per work item"
  below.
- **A scheduled item's urgency** → the `priority` integer in that task's
  frontmatter. Never in a directory name and never in a prose list.
- **A landed item** → [docs/tasks/closed/](docs/tasks/closed/), one file per item.
  The file keeps the phase it ran in by its position under
  [docs/roadmap.md](docs/roadmap.md), which holds the phase structure and a link
  per item and no status of its own.
- **The reasoning behind a landed item** — what you considered and rejected, and how it was verified → [docs/decisions/](docs/decisions/), one file per decision, linked from the closed task file.
- **A symptom whose cause you cannot confirm** → [docs/issues/](docs/issues/): describe what was observed and the hypothesis, and state what evidence would graduate it. Do **not** park a bug here whose mechanism you traced — that is a fix, not a symptom.
- **User-visible feature, or a changed command** → [README.md](README.md) (including the docs list).
- **Host capability claims** → [docs/environment.md](docs/environment.md), re-measured rather than assumed.

Write the *why*, not the *what* — the diff already says what. If a decision had
a rejected alternative that a future reader would otherwise re-litigate (the
fixed 2s `Ready?` step; swapping `state` for a `cancelled` event), record it
where the decision lives.

**One home per work item.** A work item has exactly one home, and the home
*is* its status: a file in `docs/tasks/open/` means specified and not landed, a
file in `docs/issues/` means the cause is not confirmed, a file in
`docs/tasks/closed/` means it landed. Nothing is recorded in two of the three,
and no item carries a status word anywhere else — no checkbox, no "done", no
"planned". That is the invariant, and the stale-copy incident below is what it
protects against.

Two consequences worth stating because they look like exceptions and are not. A
landed item's *reasoning* lives in `docs/decisions/` — that is a second **file**
about the item, not a second **status**; the closed task file keeps the pointer,
so the copy a reader hits first is still the only copy of the status. And a
task's `priority` is metadata, not a place: a task is not "unimportant" because
it sits at priority 17, so it stays in `open/` and gets no third directory to
reflect that. The README tracks no status at all — it points at the three
registers. `docs/roadmap.md` is not one of them: it is a table of contents by
phase and carries no status word, which is why it can be read without being able
to contradict a file.

The reason is not tidiness: when the same slice was tracked in three places, they
disagreed about whether the bounded SSE connection lifetime had landed, and the
copy a reader hit first was the stale one. Four separate copies have since been
caught — `review.md` against the roadmap, `review.md` against `protocol.md`,
"Leaderboard identity" recorded twice at different levels of progress, and
`tools/README.md` still calling the stale-teardown fix "Phase 1, unchecked" long
after it landed. To land something, `git mv` its task file to
`docs/tasks/closed/`; to schedule something, create the task file; to park
something, create the issue file. Never restate a status somewhere else.

## Invariants to know before you edit

These are load-bearing. Breaking one is a bug even if the tests pass.

- **The server judges; the browser renders.** No rule may be enforced from
  client-supplied timestamps or UI state. Displayed reaction times are
  cosmetic (network-neutral, client click times); win/loss is arrival-time
  authoritative.
- **Keep the monotonic reading.** The round deadline is a `time.Time` that
  carries `m=+`, never epoch-ns. `Sub` silently falls back to wall arithmetic
  when either operand lacks one, so a mid-round clock step mis-times the round.
- **Wire changes are additive.** A tab open across a deploy must survive: add
  fields to an existing event rather than introducing a new event type, which
  an older client drops silently. If a new type is genuinely needed, say why
  the deploy can guarantee refresh — it currently cannot (ops lives outside
  this repo).
- **All game rules server-side; `GET /events` is exempt from rate limiting**;
  POST endpoints are per-IP token-bucketed; existing clients are never evicted
  by the resource caps.
- **The engine (`round.go`) does not know about HTTP.** Sides are neutral
  `matchParty`; the hub wires callbacks to real clients. Don't leak `Hub`,
  `Client`, or SSE into the engine.
- **Phase changes go through `advance(from, to)`** — the edge table plus CAS is
  what stops a stale goroutine clobbering a newer phase.
- **Reading `Client.match` needs `h.mu`.** It is plain state; an unlocked read
  is a race, and `-race` will not catch it for you here.
- **Protocol probes verify frames on the wire, not client behaviour.** A bug in
  `app.js` re-arming a timer is invisible to both `go test` and `t1`–`t8`; that
  gap is why `web/app.countdown.test.cjs` runs the real `app.js` source against
  a stubbed context. Add a client-behaviour test when you touch client logic.

## Commit and push

One slice = one commit = one push. **A finished task is pushed when it is
finished** — not batched with the next one, not held for the end of the session.
Push each slice as soon as it is green; never accumulate a stack of slices to
push at the end, and never mix an unrelated change into a slice already in
flight.

The reason is that a push is the only durable copy of the work, and it is what
makes every other rule in this file hold. A pushed slice is independently
reviewable, independently revertable, and independently deployable — and it
survives a dead session, a lost context, or an interrupted machine. An unpushed
slice is a claim; a pushed one is a fact. Batching also makes the failure worse
when it comes: three unpushed slices that all need the same fix is one
`git bisect` and one revert, not three.

**Message format** (the repo's convention, used throughout history):

```
Area: imperative one-line summary

What changed and why, in prose. The mechanism if a bug was involved. What you
considered and rejected, if it stops a future reader re-litigating it. How it
was verified — including the negative cases (which test fails against the old
code) and, explicitly, what could NOT be verified on this host.
```

Areas in use: `Fix`, `Protocol`, `Testing`, `Observability`, `Probes`, `Docs`, `Client`, `Countdown`, `Characters`/`Roster`, `Game screen`.
 Bodies are
real prose — a message whose body only restates the diff is a missed chance.

Before each commit and push:

```sh
git status                     # only intended files staged; no secrets, no origin
git diff --cached
git log --oneline -10          # match the area/summary style
```

- Never commit: the `kxp` binary, `node_modules/`, `web/img/sources/`,
  `tools/.base-url` (the address of a public unauthenticated server). All
  already gitignored — keep it that way.
- The repo carries **no deployment tooling**: the live server is kept current by
  an ops script outside the repo (`git pull` + build + `systemctl restart`). Do
  not add deploy scripts, systemd units, or infra config here.
- Do not force-push `main`, rewrite published history, or skip hooks.
- Only commit when asked. If asked to commit, commit the slice you just
  verified — not whatever else the tree picked up.

## Reporting back

Say what you verified, how, and what remains unverified on this host (the four
limits above). Quote the actual counts (`go test ./...` ok, `npm run unit` 69/69)
rather than "tests pass". If you parked or deferred something, say where you
recorded it and why — a deferred decision with no written reasoning comes back
as an argument three commits later.
