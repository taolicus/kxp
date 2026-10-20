# Execution and stopping

## Start with relevant context

- Start from the requested outcome.
- Read what the task touches, not the whole repo: the docs the task reaches, the
  code those docs name, and the work item itself. **AGENTS.md** says which files
  most tasks need and which are deliberately not read as a sweep.
- Investigate further only to resolve a concrete implementation or verification
  question.
- Use the best available evidence. Do not re-litigate a settled decision — a
  landed item keeps its reasoning in [docs/features/](../docs/features/), under
  "why not" — without new evidence.
- Do not inspect unrelated files or history without a specific reason.

## Plan proportionately

- A routine, low-risk change needs no separate planning phase.
- For a substantial change, establish scope, acceptance criteria, and a practical
  order, then split it only as
  [`incremental-slice-scoping.md`](incremental-slice-scoping.md) says.
- If an uncertainty survives reasonable, targeted investigation, record what is
  known and the next action. Ask when the uncertainty prevents a safe decision.

## Control scope

- Implement the requested outcome without unrelated cleanup or speculative
  improvements.
- An unrelated discovery becomes a new issue, not extra scope: record it in
  [docs/issues/](../docs/issues/) — or the task file, if it is a named
  prerequisite — and leave the current slice alone. Quietly widening a slice is
  how one commit stops being independently revertable.
- Update documentation only where it adds durable knowledge or a rule that will
  outlive the slice, in the home named by "Document in the right place" in
  [AGENTS.md](../AGENTS.md).
- Do not repeat a check, recreate an artifact, or reopen a settled decision
  without new evidence.

## Verify and stop

- Verify against the slice's acceptance criteria with the gates named in
  [AGENTS.md](../AGENTS.md#verify). Do not try to prove the absence of every
  possible defect.
- If a gate fails, make targeted attempts to diagnose and fix it within scope.
- If blocked, record the evidence, the limitation, and the next concrete action
  rather than repeating a failed attempt or claiming completion.
- Stop when the acceptance criteria are met, the relevant gates have run to the
  extent the device allows, the documentation is updated, and the commit and push
  steps are done. Say plainly what the device could not verify — the limits in
  [AGENTS.md](../AGENTS.md) are part of the report, not an excuse to omit it.
