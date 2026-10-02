# Deterministic deadline enforcement

The run loop drains each side's channel when the shoot timer fires
(`drainPending`), so an on-time tap is never dropped by a scheduler coin-flip;
moves after the deadline are still rejected by `handleMove` (`400 too late`).
