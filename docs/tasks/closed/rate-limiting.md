# Rate limiting

Per-IP token bucket on the six POST endpoints (queue, cancel, cpu, ready, move,
character), keyed on `RemoteAddr`; over-limit requests get `429` +
`Retry-After`. Thresholds sit far above any legitimate session (incl. best-of-5
and arcade-ladder bursts); `GET /events` exempt.
