# Monotonic PUN deadline

Landed. Status and summary live in the roadmap entry under
**Phase 1 — Core hardening** — [roadmap.md](../roadmap.md). This file holds the
rationale: what was considered, what was rejected, and why.

**Found as a flake, not a reading.** `TestCountdownCarriesAnnouncedPlan`
failed once across ~9 full runs with `youTimingMs = 13299` — a move that
arrived ~300ms after the deadline reported as 13.3s late, inside a test
whose own wall time was 1.21s. That internal contradiction is the
fingerprint: the test's duration is measured monotonically, so the two
numbers could not both be right.

**Mechanism.** `m.shootAt` was stored as `UnixNano` and rebuilt with
`time.Unix`, which has no monotonic reading. Three judgements in one round
compare it against a `time.Now()` that *does* have one — arrival timing in
`resolve`, the KA/CHI/PUN sleeps in `run`, and the `too late` cutoff in
`handleMove`. `time.Time.Sub` uses the monotonic reading only when both
operands carry it and **silently falls back to wall arithmetic** otherwise,
so a device that steps its wall clock mid-round (network change, NTP resync)
mis-times all three by exactly the size of the step. It was never observed
on stationary hardware, and the movement that produced it is exactly the
condition the test could not hold fixed.

**Fixed** by storing the deadline as a `time.Time` that keeps its monotonic
reading, set once from `time.Now()` at countdown start. The wire value is
derived from the same instant via `UnixMilli`, so `shootAt` still reaches
the client as the same server epoch-ms and protocol/clock-skew handling is
unchanged. The late cutoff is a real behavioural improvement: a mid-round
clock step could previously reject an on-time move as `too late`, which is
the *symptom* of [docs/issues.md](../issues.md) 3 — but a distinct
contributor to it, not that entry's latency hypothesis, and not a
resolution of it. Issue 3 stays open.

**Testing.** A clock step cannot be injected, so `monotonic_test.go` pins
the structural property instead: the stored deadline must retain its
monotonic reading, which `time.Time.String` renders as a trailing `m=+`.
That guard was checked to *fail* against the old wall-only form, so it
cannot silently rot. Two further tests pin the wire value and an ordinary
arrival judgement. Five consecutive full runs clean. Residual risk: the
live trigger is unproven, so `t5` remains the live canary.
