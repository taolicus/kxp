# AGENTS.md — how to work in this repo

KACHIPUN TOURNAMENT (`kxp`): a single-binary Go RPS game with an embedded web
UI, SSE push, and POST actions. Server-authoritative rules; the browser renders.

**The house rule: one small slice at a time, and each slice leaves the tree
green.** A slice is one concern — one fix, one field, one probe, one doc
paragraph — that can be read, reviewed, tested, deployed, and reverted on its
own. Anything larger gets split before it gets written. Every slice in this
repo's history is one commit that a reader can hold in their head.

Read what the task touches, not the whole repo. A full sweep of the text here is
~453KB; the engine, hub, client, and the two files that apply to most tasks are
~95KB of it — 21%. Those are `round.go` (the engine), `server.go` (which holds
both the hub and the client type), `web/app.js`, and
[docs/features/architecture.md](docs/features/architecture.md) +
[docs/features/protocol.md](docs/features/protocol.md). Almost all the difference
is the probe suite (24%) and the test bodies (27%), and neither is needed to change
behaviour: the docs and the commit that landed a change name the one test or probe
that is relevant.

**Every task:** [docs/features/architecture.md](docs/features/architecture.md) (engine, timing
model, matchmaking, SSE lifecycle).

**When the task reaches them:**

- which device the work belongs on —
  [docs/development/device-aware-workflow.md](docs/development/device-aware-workflow.md):
  the phone is always to hand and the laptop is not, and some work (race
  detection, long or IO-heavy builds) only fits one of them. Read it before
  starting a task, not when one is already stuck halfway.
- a claim about this host — [docs/development/](docs/development/): the
  measured hosts, their toolchains, and the commands to re-measure them. Read it
  when the task touches the build, the toolchain, or a claim about what a
  machine here can do — not every task, because the per-task verification rules
  it used to carry live in [Verify](#verify) below instead.
- wire changes — [docs/features/protocol.md](docs/features/protocol.md): events,
  endpoints, the client state table, clock handling
- the internals, or a feature that already ships —
  [docs/features/](docs/features/): durable knowledge about the system as it now
  stands; one file per subject ([architecture](docs/features/architecture.md),
  [protocol](docs/features/protocol.md),
  [character selection](docs/features/character-selection.md),
  [backgrounds](docs/features/backgrounds.md))
- scheduling or picking up work — [docs/tasks/open/](docs/tasks/open/): one file
  per specified build, `phase` and dependencies in the frontmatter
- what a phase was for, and what landed in it —
  [docs/roadmap.md](docs/roadmap.md): the phase structure and a link per landed
  item, which is why the phases are ordered as they are
- why a landed item is the way it is —
  [docs/tasks/closed/](docs/tasks/closed/): one file per landed item, each linking
  the section of [docs/features/](docs/features/) holding its rationale
- a symptom that looks familiar — [docs/issues/](docs/issues/): entries are
  **unconfirmed** by definition
- re-litigating a landed decision — the feature file that owns the invariant it
  constrains, under "why not"; see
  [docs/features/](docs/features/)

**Deliberately not read as a sweep.** `tools/` is ~24% of the text in this repo
and earns a read only when changing the probes or the verdict logic — then read
`tools/lib/harness.mjs` and the one probe involved. Test bodies (21
`*_test.go`, plus `web/*.test.cjs` and `tools/lib/*.test.mjs`) are another ~27%,
and the landing commit names the one that matters. `web/style.css` and
`web/img/` have no coverage on either host (see "Verify" below), so reading them
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

Three rules govern what you pick up and how far you take it:

- **Check [docs/tasks/open/](docs/tasks/open/) and the feature docs before
  implementing.** If the task is under-specified, investigate and update the task
  file rather than opening the code and assuming. An assumption made here is
  invisible to whoever picks it up next.
- **Match the task to the device before starting it.** The phone cannot run
  `go test -race` and is slow at long or IO-heavy work; if the slice needs the
  device you are not on, defer it in the task file rather than opening it — see
  [device-aware-workflow.md](docs/development/device-aware-workflow.md), which
  is also where a deferral is recorded and why it is not an issue.
- **An unrelated discovery becomes a new issue, not extra scope.** Record it in
  [docs/issues/](docs/issues/) — or the task file, if it is a named prerequisite —
  and leave the current slice alone. Quietly widening a slice is how one commit
  stops being independently revertable.

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
document, commit, and push is what keeps a long working session from losing its own
thread.

There is deliberately nothing here about when to compact. That guidance used to
assert that a mid-slice summary is lossy "exactly where a slice cannot afford", and
that a keybind belongs here — and the assertion was wrong by measurement, since
several sessions hit the context limit repeatedly with no meaningful loss. Keeping
a confident rule about a tool's behaviour that the repo cannot verify is the same
mistake as keeping a stale claim in a comment: it ages into a rule nobody can
re-derive and nobody dares contradict. A keybind is worse still, being wrong for
every agent that does not run that tool.

What is left is the part that is not about tooling: **finish the slice — verified,
documented, committed, pushed — before starting the next one.** At that point there
is nothing to lose, because the state that matters lives in git rather than in the
conversation, so a new session starts from a clean tree and a pushed commit and
only the intent needs carrying forward. That was the real argument for a boundary,
and it does not depend on how the context window behaves.

### Test first, and prove the test bites

- Add or extend a test **in the same commit** as the change. A behaviour change
  with no test is not finished.
- **Check the new test fails against the pre-change code** before you believe
  it. Record that you did, where the slice's detail lives — the task file
  ("Verified to fail against the old handler", "checked to *fail* against the
  old wall-only form, so it cannot silently rot"). A test that passes both
  before and after pins nothing.
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
npm run links       # internal doc links and #fragments; sub-second, run it every time
gofmt -l .          # must print nothing
go vet ./...
go test ./...       # the one gate the phone cannot time: ALONE, generous timeout (below)
npm run unit        # web/*.test.cjs + tools/lib/*.test.mjs
npm run tall        # probes t1–t8 — requires an origin (see below), creates real matches
```

`npm run unit` is the catch-all for client and harness tests (the README's
shorter `node --test web/kxp.test.cjs web/machine.test.cjs` misses
`web/app.countdown.test.cjs`). `npm run links` is first because it is the only
gate that costs nothing and catches a rename immediately: the documentation is
the largest surface in this repo and nothing else here would notice a link left
pointing at nothing. It checks that internal paths resolve and that each
`#fragment` names a heading that exists — not that what a document says is still
true, which needs a reader. What each gate does and does not cover, and why
the integration path is a browser-free probe suite, is in
[docs/development/verification.md](docs/development/verification.md) — read it
when adding a test or deciding whether something is verifiable here.

`go test ./...` is the gate the phone cannot put a number on. There it is a
phone under variable load — thermal, other apps, FUSE shared storage, and a
moving network ([environment.md](docs/development/environment.md)) — so its wall
time drifts from a minute to many even warm, run to run; any figure added here
would be measured one day and a lie the next. Run it as its own step with a
generous tool timeout, never chained behind `&&` with another gate, and never
piped through a pager: a buffered pipe turns a working-but-slow run into an
apparent hang, and a killed run restarts the compile while the machine is
already loaded. If it looks hung, wait out Go's own per-package `-timeout` (10
minutes by default) before believing it — on the phone, slow is the explanation
more often than a hang is, and a genuinely stuck test still gets killed by Go
itself. Batch Go edits and run the full suite once at the end;
`go test -run <Name> ./...` covers a slice in the meantime.

**What no gate here covers** — state these limits in any report and in the
slice's task file, rather than implying coverage that does not exist. The first
is a property of the phone alone; run the slice on the laptop and it goes away:

1. **Race detector** — `go test -race` refuses on the phone: `race is not
   supported on android/arm64`. Not configurable there, and no other gate
   substitutes for it, so a concurrency change made on the phone is hand-checked
   and argued in a comment: when it touches shared state (`h.mu`, `c.mu`, the
   match phase atomics), name that state in the comment and say why the ordering
   holds. `finishMatch`'s per-side teardown is the worked example — the decision
   is taken under `h.mu` and pinned by `finish_test.go`, which drives the
   pointer states directly instead of racing two goroutines. The laptop runs
   `-race` normally, so prefer that device for concurrency work
   ([device-aware-workflow.md](docs/development/device-aware-workflow.md)).
2. **Rendering / CSS / console errors** — No automated coverage on either host.
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

- **Wire format / events / state table** → [docs/features/protocol.md](docs/features/protocol.md).
- **Internals, invariants, mechanisms** → [docs/features/architecture.md](docs/features/architecture.md).
- **How a shipped feature works, or how to add one to it** → [docs/features/](docs/features/), one file per subject. Durable knowledge about the system as it stands; per [docs/register.md](docs/register.md) it is never moved in from a task.
- **A work item's status** — its own file in [docs/tasks/open/](docs/tasks/open/)
  if the next action is a specified build, [docs/issues/](docs/issues/) if the
  next action is to find out or decide, and [docs/tasks/closed/](docs/tasks/closed/)
  once it has landed. The directory *is* the status; see "One home per work item"
  below.
- **A landed item** → [docs/tasks/closed/](docs/tasks/closed/), one file per item.
  The file keeps the phase it ran in by its position under
  [docs/roadmap.md](docs/roadmap.md), which holds the phase structure and a link
  per item and no status of its own.
- **The reasoning behind a landed item** — what you considered and rejected, and how it was verified → the section of the owning file in [docs/features/](docs/features/) (or [docs/development/](docs/development/)) that documents the invariant the decision constrains, written as present-tense prose and closed with the landing commit. The closed task file links to that section, so a reader who starts at the work item is routed to the reasoning.
- **A symptom whose cause you cannot confirm** → [docs/issues/](docs/issues/): describe what was observed and the hypothesis, and state what evidence would graduate it. Do **not** park a bug here whose mechanism you traced — that is a fix, not a symptom.
- **User-visible feature, or a changed command** → [README.md](README.md) (including the docs list).
- **Host capability claims** → [docs/development/environment.md](docs/development/environment.md), re-measured rather than assumed.

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

**Which register is it?** The test is whether you could hand the file to someone
with no further conversation and have them start. If you would have to ask a
question first, it is an issue. "Add a `cancelled` event so `state` means one
thing" is a task even though nothing about it is urgent and even though it is
blocked until the deploy can guarantee clients refresh — naming the work is
enough. "A match sometimes stalls after the opponent is found" is not, because
nobody knows what to build. And durable knowledge about the system as it now
stands is none of these: it belongs in `docs/features/`, and per
[docs/register.md](docs/register.md) it is never moved in from a task.

Two consequences worth stating because they look like exceptions and are not. A
landed item's *reasoning* is **in** the feature file rather than beside it —
that is the same **file** as the invariant, not a second copy of anything, and
the closed task file keeps the pointer so the copy a reader hits first is still
the only copy of the status. (It was a separate `docs/decisions/` register until
it was folded in: every decision there was cited by exactly one file — its own
closed task — so the reasoning was reachable from the plan and invisible from the
system docs that encode the constraint.) And a
there is no third directory for scheduling, because a task is not "unimportant"
because it has not landed yet — it stays in `open/` until it does. The README tracks no status at all — it points at the registers and
at [docs/register.md](docs/register.md), which is where their rules live.
`docs/roadmap.md` is not one of them: it is a table of contents by
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
push at the end.

A commit is the unit of work a task in [docs/tasks/open/](docs/tasks/open/)
describes: a meaningful completed increment, not an arbitrary step through an
implementation. Never combine unrelated work into one commit to reduce the
number of commits — one concern per commit, so a reader, a revert, or a
`git bisect` lands on exactly one thing.

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

What changed and why, in prose: the intent, the mechanism if a bug was
involved, and what you considered and rejected where that stops a future reader
re-litigating it. Keep it short — a line and a paragraph; more only when the
mechanism genuinely needs it.
```

The **detail stays out of the message.** Implementation notes, validation
results (which gates ran, what failed, what a host could not verify) and task
history belong in the task file: in `docs/tasks/open/` while the work is
scheduled and in `docs/tasks/closed/` once it lands, which is where a reader
looks for them anyway. A message that quotes test counts or narrates the edit is
a second copy of that file, and a second copy is the one thing in this tree that
can silently drift. What you verified is reported in
[Reporting back](#reporting-back).

Areas in use: `Fix`, `Protocol`, `Testing`, `Observability`, `Probes`, `Docs`,
`Client`, `Countdown`, `Characters`/`Roster`, `Game screen`.
Bodies are real prose — a message whose body only restates the diff is a missed
chance.

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

Say what you verified, how, and what remains unverified on the device you used
(the limits above). Name the device — the two hosts do not have the same limits.
Quote the actual counts (`go test ./...` ok, `npm run unit` 69/69)
rather than "tests pass". If you parked or deferred something, say where you
recorded it and why — a deferred decision with no written reasoning comes back
as an argument three commits later.
