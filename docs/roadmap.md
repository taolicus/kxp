# Roadmap

Why KACHIPUN TOURNAMENT is built in this order, and where every work item lives.

**No work item is recorded in this file.** Each is a single file whose location is
its only status:

| Register | Holds | Status is |
| --- | --- | --- |
| [tasks/open/](tasks/open/) | specified builds, not yet landed | the directory |
| [tasks/closed/](tasks/closed/) | what has landed | the directory |
| [issues/](issues/) | symptoms, questions, and decisions with no confirmed cause | the directory |

The lists below are tables of contents — phase, then title, then a link. They
carry no status word and no priority. Priority is the `priority` integer in an
open task's frontmatter, so the next thing to pick up is a sort of
[tasks/open/](tasks/open/), not a list maintained here. The reasoning behind any
landed item is in [docs/decisions/](decisions/), linked from the item itself.

This file used to carry the item bodies as checkboxes, which was wrong twice
over and both errors surfaced as stale text before anyone noticed they were
errors. A checkbox says "landed" and "not yet scheduled" in the same syntax, so
seven entries blocked on unconfirmed causes read as scheduled work. And once
priority moved into task frontmatter, the ordered list here became a second copy
of that ordering. The bodies moved to [tasks/closed/](tasks/closed/); the phase
structure stayed, because why these phases in this order is worth more than the
absence of the work that ran.

## Protocol rework

The reaction opportunity must not depend on burst delivery of a single `shoot`
frame over one unacknowledged SSE stream. Task A shipped and landed that removal.

Tasks B (stream seq + replay) and C (`/ping` health probe) were never scheduled.
They were defined from unconfirmed connectivity symptoms and are recorded as
prospective fixes on the symptom each would address in [docs/issues/](issues/),
with their draft specs parked in [protocol.md](features/protocol.md). There is no entry for
either here or in [tasks/open/](tasks/open/), on purpose: naming the work is not
the same as knowing what to build, which is what an issue is.

- [A. Announced deadline + `ts` (v1.1)](tasks/closed/announced-deadline-ts-v1-1.md)

## Phase 1 — Core hardening

Correctness and safety issues that affect reliability on a public server.

- [Latency-fair reaction timing](tasks/closed/latency-fair-reaction-timing.md)
- [Server-sent PUN window](tasks/closed/server-sent-pun-window.md)
- [State machine for screen transitions](tasks/closed/state-machine-screen-transitions.md)
- [Mode-aware rematch](tasks/closed/mode-aware-rematch.md)
- [Phase-aware move validation](tasks/closed/phase-aware-move-validation.md)
- [Move channel lifecycle](tasks/closed/move-channel-lifecycle.md)
- [Full-channel drop must error](tasks/closed/full-channel-drop-errors.md)
- [Snapshot phaseDone vs phaseIdle](tasks/closed/snapshot-phase-done-vs-idle.md)
- [Graceful server shutdown](tasks/closed/graceful-server-shutdown.md)
- [Request timeouts](tasks/closed/request-timeouts.md)
- [Rate limiting](tasks/closed/rate-limiting.md)
- [Resource limits](tasks/closed/resource-limits.md)
- [Deterministic deadline enforcement](tasks/closed/deterministic-deadline-enforcement.md)
- [Ready-handshake countdown](tasks/closed/ready-handshake-countdown.md)
- [CPU ready gate](tasks/closed/cpu-ready-gate.md)
- [Tell the player *why* a handshake was cancelled](tasks/closed/handshake-cancel-reason.md)
- [Stale `state` teardown after a handshake re-pair](tasks/closed/stale-teardown-guard.md)
- [Monotonic PUN deadline](tasks/closed/monotonic-pun-deadline.md)
- [Both ends of the pick window are authoritative](tasks/closed/pick-window-both-ends.md)

## Phase 2 — Testing & observability

Make the system testable and debuggable in production.

- [A failing probe keeps its evidence](tasks/closed/probe-keeps-evidence.md)
- [Deploy identity on `/health`](tasks/closed/deploy-identity-health.md)
- [Timing edge-case tests](tasks/closed/timing-edge-case-tests.md)
- [Disconnect tests](tasks/closed/disconnect-tests.md)
- [Simultaneous-move tests](tasks/closed/simultaneous-move-tests.md)
- [Game-state transition tests](tasks/closed/game-state-transition-tests.md)
- [Connectivity diagnostics — the landed traces](tasks/closed/connectivity-diagnostics-traces.md)
- [Core-gameplay e2e (withdrawn)](tasks/closed/core-gameplay-e2e-withdrawn.md)
- [Protocol-level production probes (browser-free)](tasks/closed/browser-free-probes.md)
- [Automated test workflow](tasks/closed/automated-test-workflow.md)

## Phase 3 — Architecture & features

Build on a stable foundation without rewriting the core.

- [Pure game engine](tasks/closed/pure-game-engine.md)

## Phase 4 — Public features

Features that depend on identity, persistence, or ranking.

- [Random fight backgrounds](tasks/closed/random-fight-backgrounds.md)

One item has landed. The rest of this phase is unstarted, and it is
deliberately the last phase: every item in it needs an identity primitive
that has not been chosen yet ([player-identity](issues/player-identity.md)),
so scheduling any of them now would mean scheduling work whose first step
is still an open question. They are specified, so they are tasks rather
than issues, and they are unscheduled rather than low-priority — six
files in [tasks/open/](tasks/open/) carrying `phase: 4`.
