# Tell the player *why* a handshake was cancelled

An expired readiness gate was invisible. The client acked with a fire-and-forget
`post('/ready')` (`web/app.js`) that discards its error, and the requeue arrived
as a bare `state idle`, so a player whose link was too slow saw "match found"
and then silently landed back in the queue with no reason.

→ rationale: [decisions/handshake-cancel-reason.md](../../decisions/handshake-cancel-reason.md)
