# Reconnect recovery can read as a loss

**Symptom** — a player whose connection drops and who reconnects *during* a
match sometimes lands on a result that reports a loss (or misses the result
entirely) even though their reaction was on time.

**Where it shows** — TCP drop during countdown/shoot → reconnect → snapshot or
result reconciliation.

**Working hypothesis** — recovery (`/events` reconnect + backoff + snapshot)
takes ≥ the ~2s round window, so the effective window collapses; the residual
path is the 6s no-result watchdog / `opponent-left` forfeit. Cause of the
remaining loss-misread is not confirmed.

**Proves the cause** — a journaled reconnect faster than the window that still
loses, or a reconnect slower than the window (pure latency, not a protocol
gap).

**Prospective fix (not scheduled)** — stream seq + replay on reconnect (fast
recovery), a short result-acceptance grace, or `/ping`-measured reintent.

*Draft specs exist for two of the three,* kept in the issues that defined them:
stream seq + replay in [silent-stuck](silent-stuck.md), and the `/ping` probe in
[window-shrink](window-shrink.md). Neither is scheduled until diagnostics confirm
a cause. The reconnection/grace race is tracked on [drop-loss](drop-loss.md).
