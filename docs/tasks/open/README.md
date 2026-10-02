# Open tasks

Work whose next action is a specified build. Priority lives in each file's
`priority` frontmatter field as an integer — lower is more urgent — because
`workflow.md` puts scheduling in metadata rather than in a directory, so that
moving a file between `open/` and `closed/` is the only lifecycle act and can
never imply a priority change.

## Fields

| Field | Meaning |
| --- | --- |
| `priority` | integer, lower is more urgent. Contiguous from 1. |
| `phase` | the roadmap phase this came from; provenance, not priority. |
| `depends-on` | other open tasks that must land first. Empty list, not omitted. |
| `gated-on` | *issues* that must graduate first. Empty list, not omitted. |

`depends-on` and `gated-on` are different on purpose. A dependency names work that
is already specified, so it is a task and the ordering is scheduling. A gate names
evidence or a decision that does not exist yet, so it is an issue — see
[latency-profile-visibility](latency-profile-visibility.md), the only entry with a
non-empty `gated-on` today.

## Index

1. [Character roster & portraits](character-roster-portraits.md) — Phase 3
2. [Game-mode architecture](game-mode-architecture.md) — Phase 3
3. [Connectivity-safe scoring](connectivity-safe-scoring.md) — Phase 1
4. [Busy affordances](busy-affordances.md) — Phase 3
5. [Externalised operational settings](externalised-operational-settings.md) — Phase 1
6. [CPU determinism hooks](cpu-determinism-hooks.md) — Phase 2
7. [One owner for match termination](match-termination-owner.md) — Phase 3
8. [Dedicated cancellation event instead of additive `state idle` fields](dedicated-cancellation-event.md) — Phase 1
9. [Anonymous abuse prevention](anonymous-abuse-prevention.md) — Phase 1
10. [Structured (JSON) log output](structured-json-log-output.md) — Phase 2
11. [Latency profile visibility](latency-profile-visibility.md) — Phase 2
12. [Player names](player-names.md) — Phase 3
13. [Multiple-tab handling](multiple-tab-handling.md) — Phase 3
14. [Lobby / room architecture](lobby-rooms.md) — Phase 4
15. [Send challenge](send-challenge.md) — Phase 4
16. [Solo campaign](solo-campaign.md) — Phase 4
17. [Leaderboard](leaderboard.md) — Phase 4
18. [Tournament model](tournament-model.md) — Phase 4

## Regenerating the index

The order below is a copy of the `priority` fields, so it is the one thing here
that can drift. Rebuild it with:

```sh
python3 - <<'EOF'
import pathlib, re
rows = []
for p in sorted(pathlib.Path("docs/tasks/open").glob("*.md")):
    fm = p.read_text().split("---", 2)[1]
    rows.append((int(re.search(r"^priority:\s*(\d+)", fm, re.M).group(1)),
                 re.search(r"^# (.+)", p.read_text(), re.M).group(1), p.stem))
for i, (_, t, s) in enumerate(sorted(rows), 1):
    print(f"{i}. [{t}]({s}.md)")
EOF
```
