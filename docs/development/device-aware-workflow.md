# Device-aware workflow

The general rule — assess once up front, do not assume a task must wait for the
laptop, and why the two gates the phone cannot run are CI's — is
[workflow/device-aware-development.md](../../workflow/device-aware-development.md).
This page is the kxp-specific companion: what the two hosts actually are, what
the phone is good at here, and how a deferral is recorded.

Two hosts develop this project, they are not equally able, and they are not
always both available. What each host is, measured, is
[environment.md](environment.md); what each gate covers is
[verification.md](verification.md).

## Match the work to the device

On the phone, favour **inspection, planning, review, research, documentation,
and small changes** — work that is mostly reading and reasoning, plus slices
that build and test quickly. The phone runs the whole loop; it is only slower
and noisier at the heavy end.

On the laptop, take the work the phone is bad at: **substantial coding,
debugging, builds, extensive testing**. The one case that is a matter of degree
rather than kind is long or IO-heavy jobs: heavy IO is slow on the phone, where
shared FUSE storage and thermal load make them slow to run and slower still to
repeat ([environment.md](environment.md#host-1-the-phone-primary)). That is a
speed difference, not a capability one — a long run finishes on the phone too,
it just takes longer and wants a wake lock.

Concurrency work and the browser suite are **not** deferred to the laptop: CI
runs both on every push, which is what
[workflow/device-aware-development.md](../../workflow/device-aware-development.md)
sets out. What is left for the laptop, then, is iteration speed rather than
capability: long test runs, IO-heavy builds, and hands-on browser debugging.
Where a slice genuinely needs that and you are on the phone, defer it rather
than starting it — the phone is capable of almost everything, which is what
makes half-doing it the failure mode: a slice left mid-branch with the reason
living in a conversation that has since ended.

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
