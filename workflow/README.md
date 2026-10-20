# Workflow

Read the rules relevant to the task. Apply them proportionately; do not turn a
routine change into unnecessary planning, investigation, or administration.

The rules here are the ones that generalise across projects. What is *specific*
to this repo — the invariants, the gate list, the register rules, the commit
format's areas — stays in [AGENTS.md](../AGENTS.md), because every one of them
cites a path in this tree and reads worse detached from it.

## Work item lifecycle

- [docs/issues/](../docs/issues/): unresolved observations, problems, questions,
  and investigations — a symptom whose cause is not confirmed.
- [docs/tasks/open/](../docs/tasks/open/): actionable work, specified and not
  landed. `phase` and dependencies live in the frontmatter.
- [docs/tasks/closed/](../docs/tasks/closed/): completed tasks retained for
  history, with the `Landed` record appended.
- [docs/features/](../docs/features/): durable knowledge about the implemented
  system and the reasons behind it.

The directory *is* the status, and a work item has exactly one home; see
"One home per work item" in [AGENTS.md](../AGENTS.md) and
[docs/register.md](../docs/register.md), which holds the rules and the incident
behind them. Never restate a status somewhere else — no checkbox, no "done", no
"planned".

Move an issue to `docs/tasks/open/` when it becomes actionable. Move a completed
task to `docs/tasks/closed/`, preserving its filename and the plan it carried.
Update the relevant feature documentation when work establishes durable
knowledge. Do not duplicate information already documented.

Create follow-up issues for material, actionable work outside the current scope.
Do not create issues for trivial observations, speculative improvements, or work
already tracked elsewhere.

## Workflow rules

- [`device-aware-development.md`](device-aware-development.md) — which host a
  slice belongs on, and why the two gates the phone cannot run are CI's job.
- [`incremental-slice-scoping.md`](incremental-slice-scoping.md) — the house
  rule: one small slice at a time, each leaving the tree green.
- [`commit-policy.md`](commit-policy.md) — one slice = one commit = one push,
  the message format, and what never gets committed.
- [`execution-and-stopping.md`](execution-and-stopping.md) — what to read before
  editing, how much to plan, and when a slice is done.
