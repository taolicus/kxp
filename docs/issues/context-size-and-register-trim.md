# The agent-facing context is large enough to be a cost, and no one has decided what to trim

**Provenance** — from the conformance review against the sibling projects'
`bootstrap.sh` workflow, which found kxp's `AGENTS.md` at 26 KB against a 632 B
sibling file, and `docs/` at ~440 KB across 133 register files. The workflow
rules were split out in the same review (the slice that landed
[workflow/](../../workflow/README.md)); what remains is the accumulated
knowledge, not the rule text.

**Symptom** — every session that works here pays an entry tax. The rules are
readable now, but the *knowledge* bases are not screened: any agent asked to
touch, say, the countdown has `docs/features/` (98 KB), `docs/development/`
(34 KB), 24 issue files (50 KB), 20 open tasks (30 KB) and 80 closed tasks
(253 KB) available and no rule that says which of them are dead weight. The
closed-task register is the largest single body of prose in the repo and is read
only when something already points at it.

**Where it shows** — the first read of any non-trivial task, and cost per
session rather than per commit.

**Working hypothesis** — the rule text and the knowledge text have different
lifetimes and are now separated, but only the rules were reviewed. Two distinct
questions are still open and are easy to conflate:

1. **Is any closed-task record redundant** because its durable knowledge now
   lives in `docs/features/`? The register's own rule says the closed file keeps
   the *plan and its outcome* and the reasoning lives in the features file; a
   closed task whose whole substance has been absorbed by a features section may
   be safely summarised down to a pointer, or not.
2. **Should the docs tree stay flat as it grows?** All five registers are
   level-1 under `docs/`, defined by `docs/register.md`, and the sibling layout
   is instead `issues/ tasks/ features/` at the repository root with no
   `register.md` at all. Conforming would trade a working invariant ("the
   directory is the status") for a cosmetic match, so the open question is
   whether there is a *reader-cost* argument for moving, not a conformance one.

**What would resolve it** — a measured read of the closed-task register: for
each file, whether its reasoning is already reachable from `docs/features/`, and
what a reader loses if it is replaced by a pointer. That is the evidence, and it
is the same shape as the register rule the tree already enforces.

**Prospective fix (not scheduled)** — one or more of: a `Landed`-record audit
that collapses a closed file to its plan plus a features pointer once the
features file owns the rationale; a single index mapping "subject → the one file
that owns it" so a session can skip the sweep without reading the tree; or
nothing, if the read shows the register is already lean. Explicitly **not** a
rename of `docs/` to match the siblings — see hypothesis 2.

*Deliberately unscheduled: this is a decision about how much context to carry,
taken against measured read cost, not against a target file size.*
