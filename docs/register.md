# Registers

The directories under `docs/` are not folders for tidiness. Each one answers a
different question, and putting a file in the wrong one is how a reader ends up
reading a plan as a description of the system.

| directory | holds | answered by |
| --- | --- | --- |
| [features/](features/) | durable knowledge about the implemented system, one file per subject | "how does this work?" |
| [development/](development/) | the host, and how a change is verified on it | "how do I check this here?" |
| [tasks/open/](tasks/open/) | specified builds that have not landed | "what is scheduled?" |
| [tasks/closed/](tasks/closed/) | what has landed, kept for history | "was this done, and why?" |
| [issues/](issues/) | symptoms and open questions with no confirmed cause | "what is wrong, and what would prove it?" |

[docs/roadmap.md](roadmap.md) is not a sixth register. It holds the phase
structure and one link per landed item, and no status of its own, which is why it
can be read without being able to contradict a file.

**The directory is the status.** There is no checkbox to tick anywhere in this
tree, and nothing per-entry restates its own state — a reader must never be able
to find two copies of a status and choose between them. To record that something
landed, move it; do not annotate it as done.

## Telling them apart

The test is in [AGENTS.md](../AGENTS.md) under **Which register is it?**, because
it is a working agreement applied on every task rather than a reference consulted
when the tree looks confusing. In short: an entry you could hand to someone with
no further conversation and have them start is a task; one where you would have to
ask a question first is an issue; knowledge about how the system now behaves is
neither.

A work item is not the only kind of thing recorded here. `features/` holds
durable knowledge about the implemented system, which is not a work item and never
becomes one: when completed work establishes durable knowledge, the knowledge goes
in `features/` and the work record stays in `tasks/closed/`.

## Why there is no `decisions/` register

The rationale for how something works belongs **in** the file that describes it,
not beside it. A rejected alternative you would otherwise re-litigate — why the
round deadline is a `time.Time`, why there is no fixed `Ready?` step, why
`state` carries fields rather than being replaced by a new event type — is a
paragraph under the invariant it constrains, in the present tense, closing with
the commit that landed it.

That is the same **file** as the knowledge, not a second copy of it, and the
closed task file keeps a pointer to the section so a reader who starts at the
work item is routed to the reasoning. There was a separate `decisions/` register
until this was folded in: every decision in it was cited by exactly one file — its
own closed task — so the reasoning was reachable from the plan and invisible from
the system docs that encode the constraint.

## Frontmatter

Only [tasks/open/](tasks/open/) files carry frontmatter, and only what scheduling
needs:

| Field | Meaning |
| --- | --- |
| `priority` | integer, lower is more urgent. Contiguous from 1. |
| `phase` | the roadmap phase this came from; provenance, not priority. |
| `depends-on` | other open tasks that must land first. Empty list, not omitted. |
| `gated-on` | *issues* that must be resolved first. Empty list, not omitted. |

`depends-on` and `gated-on` are different on purpose. A dependency names work that
is already specified, so the ordering is scheduling. A gate names evidence or a
decision that does not exist yet, so the thing it waits on is an issue — see
[latency-profile-visibility](tasks/open/latency-profile-visibility.md) for the
shape of one.

Priority is metadata rather than a directory, so that moving a file between
`open/` and `closed/` is the only lifecycle act and can never imply a priority
change. [tasks/closed/](tasks/closed/) files have no frontmatter at all: priority
is meaningless once something has landed, and `phase` is recorded by the ordering
of the table of contents in [docs/roadmap.md](roadmap.md), which groups them the
way the work was actually sequenced.

## Seeing what is scheduled, in priority order

There is deliberately no index file for the open tasks. It would be a second copy
of the `priority` fields, and the one thing in this tree that can silently drift.
Print it instead:

```sh
for f in docs/tasks/open/*.md; do
  printf '%s\t%s\n' "$(sed -n 's/^priority: //p' "$f")" "$(sed -n 's/^# //p' "$f")"
done | sort -n
```

## How an entry graduates

An issue becomes a task when its next action is **build X**, and a written
decision or a measured number is all that stands between it and the work items.
A symptom whose cause is still unconfirmed cannot make that transition: the whole
point is that nobody yet knows what to build. So an entry leaves
[issues/](issues/) when its "proves the cause" line is satisfied, or when what it
needs is a decision rather than evidence — in which case the decision is recorded
as its own entry, the way
[player-identity](issues/player-identity.md) carries the blast radius of the
tasks it gates.

Entries move out when the diagnostics supply the confirming evidence, never on a
timer.

## Moving a task

When an issue's cause is confirmed, `git mv` the file to
[tasks/open/](tasks/open/), add the frontmatter, and give it the next free
`priority`. When a task lands, `git mv` it to [tasks/closed/](tasks/closed/) and
drop the frontmatter. Both are the same move — the content travels with it, so the
context recorded when the task was scheduled is still there when someone asks why
it was done that way.

**Do not park a bug in `issues/` whose mechanism you traced.** That is a fix, not
a symptom, and the register is specifically for symptoms. The stale-teardown race
was the worked example: observed roughly 1 run in 7 through probe `t8`, traced to
an unconditional teardown frame, and therefore filed as a fix rather than parked.