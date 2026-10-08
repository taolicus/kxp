# Registers

The directories under `docs/` are not folders for tidiness. Each one answers a
different question, and putting a file in the wrong one is how a reader ends up
reading a plan as a description of the system.

| directory | holds | answered by |
| --- | --- | --- |
| [features/](features/) | durable knowledge about the implemented system, one file per subject | "how does this work?" |
| [development/](development/) | the hosts, how a change is verified on each, and when to defer work to the other device | "how do I check this here — and is this the device to do it on?" |
| [tasks/open/](tasks/open/) | specified builds that have not landed | "what is scheduled?" |
| [tasks/closed/](tasks/closed/) | what has landed, kept for history | "was this done, and why?" |
| [issues/](issues/) | symptoms and open questions with no confirmed cause | "what is wrong, and what would prove it?" |

[docs/roadmap.md](roadmap.md) is not a sixth register. It holds the phase
structure and one link per landed item, and no status of its own, which is why it
can be read without being able to contradict a file. The README tracks no status
either: it points at the registers and at this file, which is where their rules
live.

**The directory is the status.** There is no checkbox to tick anywhere in this
tree, and nothing per-entry restates its own state — a reader must never be able
to find two copies of a status and choose between them. To record that something
landed, move it; do not annotate it as done.

The reason is not tidiness: when the same slice was tracked in three places, they
disagreed about whether the bounded SSE connection lifetime had landed, and the
copy a reader hit first was the stale one. Four separate copies have since been
caught — `review.md` against the roadmap, `review.md` against `protocol.md`,
"Leaderboard identity" recorded twice at different levels of progress, and
`tools/README.md` still calling the stale-teardown fix "Phase 1, unchecked" long
after it landed.

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

## What makes a task specified

The line between an issue and a task is not urgency, it is whether the next
action is a build. So a task in [tasks/open/](tasks/open/) has to carry enough to
be picked up without a conversation: the **required context, the constraints, and
the acceptance criteria** for the slice. If a task is under-specified, the answer
is to investigate it and update the file, not to open the code and assume — an
assumption made there is invisible to whoever picks the task up next.

An issue need not be actionable at all. "A match sometimes stalls after the
opponent is found" is a complete entry precisely because nobody yet knows what to
build.

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
| `phase` | the roadmap phase this came from. Provenance and coarse
  sequencing, not a rank. |
| `depends-on` | other open tasks that must land first. Empty list, not omitted. |
| `gated-on` | *issues* that must be resolved first. Empty list, not omitted. |

`depends-on` and `gated-on` are different on purpose. A dependency names work that
is already specified, so the ordering is scheduling. A gate names evidence or a
decision that does not exist yet, so the thing it waits on is an issue — see
[latency-profile-visibility](tasks/open/latency-profile-visibility.md) for the
shape of one.

There is no priority field and no band, and that is a decision rather than an
omission. An integer ordering written into a file at rest is a snapshot of one
moment's judgement that looks like current information, and it went stale the
way such things always do: it was set once when the tasks were created, never
revised, and the five tasks it ranked last were exactly the five
[docs/roadmap.md](roadmap.md) describes in prose as *unscheduled rather than
low-priority*. The tree said both things at once and only one was true.

It was also never load-bearing. Nothing read it, and the work that actually
happened was not drawn from it. A rank in the tree invites an agent to defer to a
stale ordering instead of deriving urgency from the issue register, from what is
unblocked, and from what the owner wants today — all of which change, and none of
which a number can.

Urgency is therefore a per-session judgement made from current state, and the
fields that survive are the ones that change when their subject changes.
`depends-on` and `gated-on` are the live signal: the useful question is which tasks
have no unmet dependency and no gate, and it is answerable without a rank.
[latency-profile-visibility](tasks/open/latency-profile-visibility.md) waits on two
unconfirmed issues — a fact about the world, whereas "priority 11" would only have
been a fact about a list.

There is deliberately no index file for the open tasks either. It would be a
second copy of the frontmatter, and a second copy is the one thing in this tree
that can silently drift. The titles are a screen's worth; print them or read
them.

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
[tasks/open/](tasks/open/) and add the frontmatter. When a task lands, `git mv`
it to [tasks/closed/](tasks/closed/) and drop the frontmatter. Both are the same
move — the content travels with it, so the context recorded when the task was
scheduled is still there when someone asks why it was done that way.

Landing is additive, not a rewrite. The moved file keeps its own text — the plan
and its acceptance criteria exactly as they were scheduled — and the outcome is
**appended** as a `Landed` record (what was verified and how, and the negative
proof). The record never names the landing commit's hash, and cannot: that hash
is the digest of the very content the record sits in, so it does not exist when
the record is written — `git log --follow` on the moved file answers "which
commit landed this?". A `Landed in \`…\`` line is only ever added once the cited
commit exists. A closed file rewritten into a report after the fact has lost the
plan it was written to hand on.

**Do not park a bug in `issues/` whose mechanism you traced.** That is a fix, not
a symptom, and the register is specifically for symptoms. The stale-teardown race
was the worked example: observed roughly 1 run in 7 through probe `t8`, traced to
an unconditional teardown frame, and therefore filed as a fix rather than parked.