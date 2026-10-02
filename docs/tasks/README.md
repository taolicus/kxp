# Tasks

Two registers, one transition between them. The directory a task file sits in is
its status; there is no checkbox to tick anywhere.

- [open/](open/) — specified builds, not yet landed.
- [closed/](closed/) — what has landed, kept for history.

## What makes something a task

The next action has to be a build. "Add a `cancelled` event so `state` means one
thing" is a task even though nothing about it is urgent, and even though it is
blocked until the deploy can guarantee clients refresh — naming the work is
enough. "A match sometimes stalls after the opponent is found" is not: nobody
knows what to build, so it is an [issue](../issues/), and it becomes a task when
its cause is confirmed.

The test is whether you could hand the file to someone with no further
conversations and have them start. If you would have to ask a question first, it
is an issue.

## Metadata

Only [open/](open/) tasks carry frontmatter, and only what scheduling needs:

| Field | Meaning |
| --- | --- |
| `priority` | integer, lower is more urgent. Contiguous from 1. |
| `phase` | the roadmap phase this came from; provenance, not priority. |
| `depends-on` | other open tasks that must land first. Empty list, not omitted. |
| `gated-on` | *issues* that must be resolved first. Empty list, not omitted. |

`depends-on` and `gated-on` are different on purpose: a dependency names work
that is already specified, so ordering it is scheduling, while a gate names
evidence or a decision that does not exist yet.

[closed/](closed/) files have no frontmatter. Priority is meaningless once
something has landed, and `phase` is recorded by the ordering of the table of
contents in [docs/roadmap.md](../roadmap.md), which groups them the way the work
was actually sequenced. Keeping a field that only the index uses would make the
index and the files disagreeable; keeping a field that nothing uses would be a
second thing to maintain.

## Moving a task

When an issue's cause is confirmed, move the file to `open/`, add the frontmatter,
and give it the next free `priority`. When a task lands, move the file to
`closed/` and drop the frontmatter. Both are the same `git mv` — the content
travels with it, so the context recorded when the task was scheduled is still
there when someone asks why it was done that way.

## Indices

- [open/README.md](open/README.md) — the open tasks in priority order.
- [docs/roadmap.md](../roadmap.md) — phase structure, with a link per landed item
  under the phase it ran in.

Neither index carries a status word or a priority. Both are generated from the
files; if you change a `priority`, rebuild the open index with the command it
documents.
