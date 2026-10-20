# Commit and push policy

One slice = one commit = one push. **A finished task is pushed when it is
finished** — not batched with the next one, not held for the end of the session.
Push each slice as soon as it is green; never accumulate a stack of slices to
push at the end. The code, the test that pins it, the register move, and the
roadmap link all belong in that one commit.

## Why pushing is not optional

A push is the only durable copy of the work, and it is what makes every other
rule here hold. A pushed slice is independently reviewable, independently
revertable, and independently deployable — and it survives a dead session, a lost
context, or an interrupted machine. An unpushed slice is a claim; a pushed one is
a fact.

Batching also makes the failure worse when it comes: three unpushed slices that
all need the same fix is one `git bisect` and one revert, not three.

Never force-push `main`, rewrite published history, or skip hooks. If a push
fails, report the reason — do not guess the remote or change remote settings.

## One concern per commit

A commit is the unit of work a task in [docs/tasks/open/](../docs/tasks/open/)
describes: a meaningful completed increment, not an arbitrary step through an
implementation. Never combine unrelated work into one commit to reduce the number
of commits — one concern per commit, so a reader, a revert, or a `git bisect`
lands on exactly one thing.

## Message format

```
Area: imperative one-line summary

What changed and why, in prose: the intent, the mechanism if a bug was
involved, and what you considered and rejected where that stops a future reader
re-litigating it. Keep it short — a line and a paragraph; more only when the
mechanism genuinely needs it.
```

Areas in use: `Fix`, `Protocol`, `Testing`, `Observability`, `Probes`, `Docs`,
`Client`, `Countdown`, `Characters`/`Roster`, `Game screen`. Bodies are real
prose — a message whose body only restates the diff is a missed chance.

**The detail stays out of the message.** Implementation notes, validation results
(which gates ran, what failed, what a host could not verify) and task history
belong in the task file: in `docs/tasks/open/` while the work is scheduled and in
`docs/tasks/closed/` once it lands, which is where a reader looks for them
anyway. A message that quotes test counts or narrates the edit is a second copy
of that file, and a second copy is the one thing in this tree that can silently
drift. What you verified is reported in
[AGENTS.md](../AGENTS.md#reporting-back) instead.

## Before each commit and push

```sh
git status                     # only intended files staged; no secrets, no origin
git diff --cached
git log --oneline -10          # match the area/summary style
```

Stage only the intended changes, and verify the staged diff before committing. If
existing changes have unclear ownership or purpose, do not stage, amend, discard,
or include them: continue only if your changes can be isolated, otherwise report
the blocker.

## Register commits are additive

A task file moves as it is: the plan, its required context and its acceptance
criteria travel unchanged — only the frontmatter is dropped — and what changed
when the work landed is **appended** as a `Landed` record (what was verified and
how, and the negative proof), never woven back into the task's own text.
Rewriting a once-open task into a report after the fact is how a plan stops being
readable as the plan it was; the closed file is the plan plus its outcome, not a
replacement for it.

The `Landed` record names no commit hash, and cannot: the landing commit's own
hash is the digest of the very content the record sits in, so it never exists at
write time. Provenance is git's job — `git log --follow` on the moved file lands
on exactly the landing commit. A "Landed in `…`" line in a features file is a
different case: it cites a commit that already exists, and is written in a later
docs slice or points at an already-pushed commit.

## Deploy before starting the next slice

**A finished slice is deployed before the next one starts**, and the deploy is
verified rather than assumed: `sh deploy.sh` ends by checking that `/health`
reports the commit it just built, and probe `t1` re-checks the same value against
local `HEAD`. A green probe run against a stale binary reads as verification and
is not — that negative case is the point.

## Never commit

The `kxp` binary, `node_modules/`, `web/img/sources/`, and `tools/.base-url` (the
address of a public unauthenticated server). All already gitignored — keep it
that way.

The repo carries **no deployment tooling** beyond `deploy.sh`, the one script that
copies the built binary to the VPS: nginx vhosts, systemd units, TLS and the rest
live on the host and outside this repo. Do not add deploy scripts, systemd units,
or infra config here. The script and the layout it assumes are documented in
[docs/development/deployment.md](../docs/development/deployment.md).

## Only commit when asked

If asked to commit, commit the slice you just verified — not whatever else the
tree picked up.
