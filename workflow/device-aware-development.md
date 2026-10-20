# Device-aware development

Which device a slice is done on is part of picking it up. The phone is the
primary host and always to hand; the laptop is better suited to some work and
unavailable some of the time. What each host *is*, measured, is
[docs/development/environment.md](../docs/development/environment.md); what each
gate covers is [docs/development/verification.md](../docs/development/verification.md).

## Assess once, up front

Assess device suitability once at the start, from the required tools, the task's
risk, and how the result can be verified — not again at every step. Reassess only
when the requirements change or a concrete limitation is hit.

Record a device constraint in a task file only when it materially affects
execution or verification. Not every task needs a device note.

## Do not assume a coding task must wait for the laptop

This is the rule that gets misapplied, so it is stated flatly: the phone runs the
whole loop. On it, favour **inspection, planning, review, research, documentation,
and small changes** — work that is mostly reading and reasoning, plus slices that
build and test quickly. It is only slower and noisier at the heavy end.

**The two gates the phone cannot run are CI's job, not the laptop's.** CI is the
third runner ([docs/development/verification.md](../docs/development/verification.md#the-third-runner)),
and it runs exactly the claims no dev host here can make: `go test -race` (which
refuses on `android/arm64`) and the browser suite (`npm run e2e`, which needs
Chromium). That changes what the phone can *finish*:

- **Concurrency work is not deferred.** A change to `h.mu`, `c.mu` or the match
  phase atomics is written and argued on the phone, then pushed — CI's `-race`
  step is the verdict. The ordering still wants arguing in a comment, because CI
  reads the code only after the push while a reviewer reads it before; but "wait
  for the laptop to race-check it" is not the workflow, and the laptop being
  unavailable does not block the slice.
- **The browser suite is not deferred**, for the same reason: push and CI's
  `browser` job runs it. The laptop remains the nicer place to *iterate* on a
  spec — a browser locally is a faster loop than a CI round trip — but that is a
  convenience, not a requirement.

## What is left for the laptop

Iteration speed, not capability: long or IO-heavy jobs (shared FUSE storage and
thermal load make them slow to run on the phone, and slower still to repeat),
substantial debugging, and hands-on browser work.

Where a slice genuinely needs the device you are not on, **defer it rather than
starting it**, and record the deferral in the task file. The phone is capable of
almost everything, which is what makes half-doing it the failure mode: a slice
left mid-branch with the reason living in a conversation that has since ended.

A deferral is recorded in the task file — never in `docs/issues/`, which is for
symptoms whose cause is not confirmed. "Cannot run `-race` here" is not a symptom;
it is a known property of the host, and it is already written down.

## Cross-device handoff

For a handoff, record in the task file: the findings and decisions, the changes
made and the open questions, the next concrete action, and which step needs the
other device. Preserve uncommitted work, and never assume changes are available
on another device until the push has been verified.
