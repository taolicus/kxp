# Split the reusable workflow rules out of `AGENTS.md`

`AGENTS.md` carries every rule the repo has, in one 26 KB file: how to pick a
device, how big a slice may be, the commit format, what to read before editing.
Most of that is not specific to kxp at all — it is the same rule the sibling
projects (asteroids, komikan) keep in a `workflow/` directory beside a 632 B
`AGENTS.md`, as bootstrap by `bootstrap/bootstrap.sh`. This slice adopts that
shape *proportionately*: it moves the rules that genuinely generalise into
`workflow/`, rewrites `AGENTS.md` as the kxp-specific entry point that points at
them, and leaves every kxp-specific rule — the invariants, the gate list, the
register rules, the commit areas — where their links are.

## Required context

- [AGENTS.md](../../../AGENTS.md) itself, in full — the file being split. Every
  rule must survive the move.
- The sibling projects' `workflow/` directories (asteroids, komikan) and the
  `bootstrap/bootstrap.sh` that generates them — the target shape and the
  wording worth adopting. These live outside this repo; this slice was written
  on the host that also holds them, and reading them is not required to review
  the result, which is self-contained in `workflow/`.
- [docs/register.md](../../register.md) — the level-1 register rules, which are
  kxp-specific and must **not** be flattened into the bootstrap model.
- [docs/development/device-aware-workflow.md](../../development/device-aware-workflow.md)
  — the kxp-specific host doc that overlaps the general device rule.
- [tools/check-links.mjs](../../../tools/check-links.mjs) — walks the whole tree
  and validates every link and `#fragment`, which is what makes a move like this
  verifiable.

## Constraints

- **Nothing is deleted, only relocated.** Every rule in the old `AGENTS.md` must
  be reachable from the new one, directly or through `workflow/`.
- **The kxp-specific rules stay in `AGENTS.md`.** The invariants, the gates, the
  register rules and the commit areas all cite kxp paths; detaching them from
  those links would make them harder to follow, not easier.
- **No rename of `docs/`.** The five registers under `docs/` are load-bearing
  (the directory *is* the status). Conformance to the sibling layout is not a
  reason to move them.
- Additive only for anything already linked: existing `docs/...` references in
  the tree must not break.

## Acceptance criteria

1. `workflow/` exists with a `README.md` index and one file per generalised
   rule: device-aware development, incremental slice scoping, commit policy,
   execution and stopping.
2. `AGENTS.md` is materially smaller and reads as a kxp-specific entry point
   that points at `workflow/` for the general rules.
3. Every rule that was in the old `AGENTS.md` is still reachable.
4. `npm run links` reports 0 broken, and the anchors `AGENTS.md#verify` and
   `AGENTS.md#reporting-back` still resolve (they are linked from elsewhere).
5. The `docs/development/device-aware-workflow.md` doc no longer duplicates the
   general device rule; it points at the workflow file for it and keeps only the
   host-specific material.

## Verification

- `npm run links` — every link and fragment in the moved and rewritten files.
- The Go and unit suites are unaffected (docs only), but run them to confirm the
  tree is green.

## Landed

Split the reusable rules out of `AGENTS.md` into `workflow/`: `README.md` (index
and work-item lifecycle), `device-aware-development.md`,
`incremental-slice-scoping.md`, `commit-policy.md`, and
`execution-and-stopping.md`. `AGENTS.md` now opens by pointing at `workflow/` and
keeps what is specific to kxp — what to read, the gate list, where knowledge
lives, the invariants, and the commit areas — with the general rule bodies
replaced by links.

**Nothing was dropped.** A rule-by-rule sweep against the pre-change file
confirmed every rule still resolves: "Pick the slice size" and "Keep the session
small too" now live in `incremental-slice-scoping.md`; "Match the task to the
device", "force-push", "Only commit when asked" and "Register commits are
additive" are in the files named above. The one heading that changed name, "Pick
the slice size" → "The test for 'too big'", kept its content verbatim.

**The overlap was resolved, not duplicated.**
[docs/development/device-aware-workflow.md](../../development/device-aware-workflow.md)
was trimmed to the kxp-specific companion — the two measured hosts, the FIO and
thermal detail, and the deferral rule — and now points at
`workflow/device-aware-development.md` for the general rule (assess once up
front; do not assume a task must wait for the laptop; why `-race` and the browser
suite are CI's). The two files no longer state the same contract twice.

**Verified.** `npm run links` — 143 documents, 509 internal links, 59 fragments,
0 broken. `gofmt -l .` clean, `go vet ./...` clean, `go test -count=1 ./...` ok,
`npm run unit` 222/222. The change is docs-only, so the Go suite was expected
green; it was run anyway to leave the tree verified. No browser or `-race` claim
is made here — neither file is code, and both remain CI's to run on the push.

**Not adopted.** The bootstrap's `work-item-metadata.md` (optional frontmatter
rules) and its `use features/ tasks/ issues/` root layout: kxp's registers are
already defined, with `phase`/`depends-on`/`gated-on` frontmatter and a
`register.md` the siblings do not have. Flattening them would trade a working
invariant for a cosmetic match. The remaining question — whether the accumulated
knowledge can be trimmed at all — is a separate, unscheduled decision, filed as
[context-size-and-register-trim.md](../../issues/context-size-and-register-trim.md).
