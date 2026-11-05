# Security scope

SKY Evidence Recovery is a fail-closed, opt-in durable ledger for DeepSeek Harness tool dispatch. It is not an operating-system sandbox, a permission manager, or an exactly-once executor.

## Mandatory deployment controls

- Explicitly list every side-effecting tool in `rules`. An empty list protects nothing.
- Use a trusted DSH host to verify that required guard plugins are active before enabling those tools. The plugin cannot protect a host that did not load it.
- Deny the agent arbitrary shell, file-write, dynamic code execution, plugin management, and operator reconciliation permissions. A same-identity process with those rights can modify or delete the ledger.
- Keep the ledger on a trusted local filesystem with one owning process. Preserve unknown outcomes until independent readback and a trusted human reconciliation.
- Do not manually delete `.active.lock` while the owner is running. After a crash, investigate pending operations before any lock recovery.
- Store credentials, authoritative readback evidence, and operator-only tooling outside agent-accessible locations.

## Verified vs unverified

The supplied 2026-11-05 acceptance report covers a Windows single-process DSH setup with simulated downstream writes, real ToolRuntime calls, and five model-driven Web scenarios. R30 (community idempotency plugin combination) was blocked; R16 real-runtime disk-failure injection was not tested. macOS, Linux, cross-process and cross-host operation, real business systems, hard power loss, and host-level activation enforcement remain unverified.

Report a suspected bypass with a reproducible minimal case, but do not include secrets or real user ledger records in public issues.
