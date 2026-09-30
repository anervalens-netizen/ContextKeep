# MCP interface

> Current execution-evidence contract: MCP 2.13 / schema 19 requires explicit
> `runEvidence` correlation for new verification. Ordinary captures remain
> compatible. See [Execution evidence](VERIFICATION_EVIDENCE.md) for migration,
> current validity and re-verification. The host widget advertises v5 and retains
> installed older resource reads.

MCP interface version: 2.10.1. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve a project, read bounded work context, preserve canonical versus proposed provenance, then capture progress with a stable idempotency key. Never put private project records into the public repository or CI logs.
