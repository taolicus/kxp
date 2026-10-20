# Device-aware workflow

Two hosts develop this project, they are not equally able, and they are not
always both available. Which device a task is done on is therefore part of
picking it up: the phone is the primary host and always to hand, the laptop is
better suited to some work and unavailable some of the time. What each host is,
measured, is [environment.md](environment.md); what each gate covers is
[verification.md](verification.md).

## Match the work to the device

On the phone, favour **inspection, planning, review, research, documentation,
and small changes** — work that is mostly reading and reasoning, plus slices
that build and test quickly. The phone runs the whole loop; it is only slower
and noisier at the heavy end.

On the laptop, take the work the phone is bad at: **substantial coding,
debugging, builds, extensive testing**. One case is a matter of degree rather
than kind, and one is not:

- Long or IO-heavy jobs belong there because heavy IO is slow on the phone:
  shared FUSE storage and thermal load make them slow to run, and slower still
  to repeat ([environment.md](environment.md#host-1-the-phone-primary)). This is
  a speed difference, not a capability one — a long run finishes on the phone
  too, it just takes longer and wants a wake lock.

**The two gates the phone cannot run are CI's job now, not the laptop's.** CI is
the third runner ([verification.md](verification.md#the-third-runner)), and it
runs exactly the claims no dev host here can make: `go test -race` (which refuses
on `android/arm64`) and the browser suite (`npm run e2e`, which needs Chromium).
That changes what the phone can *finish*:

- **Concurrency work is not deferred any more.** A change to `h.mu`, `c.mu` or
  the match phase atomics is written and argued on the phone, then pushed — CI's
  `-race` step is the verdict. The ordering still wants arguing in a comment,
  because CI reads the code only after the push and a reviewer reads it before;
  but "wait for the laptop to race-check it" is no longer the workflow, and the
  laptop being unavailable does not block the slice.
- **The browser suite is not deferred any more**, for the same reason: push the
  branch and CI's `browser` job runs it. The laptop remains the nicer place to
  *iterate* on a spec — a browser locally is a faster loop than a CI round trip
  — but it is a convenience, not a requirement.

What is left for the laptop, then, is iteration speed rather than capability:
long test runs, IO-heavy builds, and hands-on browser debugging. Where a slice
genuinely needs that and you are on the phone, **defer it rather than starting
it**; the phone is capable of almost everything, which is what makes half-doing
it the failure mode — a slice left mid-branch with the reason living in a
conversation that has since ended.

## Deferring

A deferral is recorded **in the task file**, in
[docs/tasks/open/](../tasks/open/): enough context to resume on the right
device without reconstructing the reasoning — what was decided, what is blocked,
and where you stopped. The file does not move, because the directory already
says "specified and not landed" and a note inside the file is context rather
than a second status. Nothing outside the file records the deferral: a status
stated twice is a status that can be read twice and disagree.

Device availability is **not** an issue. Do not open an entry in
[docs/issues/](../issues/) because work had to wait for the laptop — that
register holds symptoms whose cause is unconfirmed, and "the laptop was not
there" has nothing to confirm. Defer the existing task instead. Only a
discovery that is genuinely separate work becomes its own entry, per the rule in
[AGENTS.md](../../AGENTS.md) under **The loop**.
