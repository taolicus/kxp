# Deploy identity on `/health`

The live suite now proves *which* build it tested. `/health` reports `build
{sha, modified, source}`; `t1` asserts it against the local HEAD and fails with
a fix hint on absent, unknown, mismatched, or dirty.

→ rationale: [decisions/deploy-identity-health.md](../../decisions/deploy-identity-health.md)
