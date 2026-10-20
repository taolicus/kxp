# Incremental slice scoping

**The house rule: one small slice at a time, and each slice leaves the tree
green.** A slice is one concern — one fix, one field, one probe, one doc
paragraph — that can be read, reviewed, tested, deployed, and reverted on its
own. Anything larger gets split before it gets written. Every slice in this
repo's history is one commit a reader can hold in their head.

## The test for "too big"

Ask: *could this commit be reverted without stranding the repo?* If reverting
leaves a feature half-wired, a test asserting behaviour that no longer exists, or
docs describing code that is gone — it is too big. Split it.

This is why the connectivity work landed as a series of single-trace commits
(`5694980`, `7eec97c`, `a50628d`, `02047ff`, …) rather than one observability
rewrite: each produces evidence, and each is independently deployable.

## When to split

Split when:

- a meaningful outcome can be implemented and verified independently;
- distinct outcomes have different acceptance criteria;
- a step resolves significant uncertainty before further implementation;
- separation materially reduces regression risk or simplifies diagnosis;
- dependencies require a clear execution order.

**Do not** split merely because the work touches multiple files, layers, or
technical steps. Keep tightly coupled changes together when splitting adds
artificial boundaries, scaffolding, or coordination without benefit. A small,
routine change stays one task.

## Size and acceptance criteria

Make each slice small enough for a focused review but large enough to deliver
something meaningful. Each should define: one coherent outcome, its scope and
constraints, observable acceptance criteria, the relevant verification, and any
genuine dependencies.

Do not create tasks for trivial edits, routine substeps, or every file touched.

## Stop decomposing

Once each slice has a coherent outcome, clear acceptance criteria, and a safe
implementation path, stop decomposing and begin. Reassess only when new
information materially changes scope, risk, dependencies, or feasibility.

If implementation reveals independent work outside scope, record it separately
([docs/issues/](../docs/issues/) or the task file, if it is a named prerequisite)
rather than silently widening the slice. Quiet widening is how one commit stops
being independently revertable.

## Do not park a half-finished refactor

Structural work that is deliberately unscheduled belongs in a roadmap note — the
reasoning written down, the code left alone — not as a partial refactor in the
tree. [docs/roadmap.md](../docs/roadmap.md) is where such an item lives.

## Keep the session small too

Slice size is not only a review concern: a slice small enough to finish, test,
document, commit, and push is what keeps a long session from losing its own
thread. There is deliberately no rule here about when to compact context — no
rule about a tool's behaviour can be verified on this repo, and one nobody can
re-derive is worse than none.

What is left is not about tooling: **finish the slice — verified, documented,
committed, pushed — before starting the next one.** Then the state that matters
lives in git rather than in the conversation, and a new session starts from a
clean tree, a pushed commit, and only the intent to carry forward.
