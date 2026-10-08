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

On the laptop, take the work the phone is bad at or cannot do at all:
**substantial coding, debugging, builds, extensive testing**. Two cases are not
a matter of degree:

- `go test -race` refuses on `android/arm64`, so any concurrency change
  race-checks only on the laptop ([environment.md](environment.md#host-2-the-macbook-pro)).
- Long or IO-heavy jobs belong there for the same reason heavy IO is slow on the
  phone: shared FUSE storage and thermal load make them slow to run, and slower
  still to repeat ([environment.md](environment.md#host-1-the-phone-primary)).

Where a task needs the laptop and you are on the phone, **defer it rather than
starting it**. The phone is capable of almost everything, which is what makes
half-doing it the failure mode: a slice left mid-branch with the reason living
in a conversation that has since ended.

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
