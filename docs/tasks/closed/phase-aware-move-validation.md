# Phase-aware move validation

`handleMove` checks `c.match.phase` before buffering; rejects with `400` in
countdown/done or after the deadline.
