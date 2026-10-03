# CPU ready gate

The ready handshake now gates CPU matches, not just PvP. The gate is a bitmask
over the non-bot sides, so a CPU match waits on its one human and `ackReady`
ignores a bot bit outright. The original rationale ("CPU matches have one human
who just clicked, so they start immediately") was the gap: the one match with no
sync barrier was the one that started instantly.

→ rationale: [architecture.md#matchmaking](../../features/architecture.md#matchmaking)
