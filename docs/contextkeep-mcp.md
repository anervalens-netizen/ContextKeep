# MCP interface

> Current operational contract: MCP 2.15 / schema 19. MCP 2.13 execution-evidence
> correlation remains required for new verification; MCP 2.15 retains the 2.14
> task-scope and no-replay contracts and adds the consistency/attention hardening.
> task-scope guardrails, current-state-first resume, task operational handoffs,
> compact search mode and no-replay uncertain-run reconciliation. Ordinary
> non-checkpoint project captures remain compatible. See
> Execution evidence (VERIFICATION_EVIDENCE.md) and
> Operational dossier (OPERATIONAL_DOSSIER.md). The host widget is v6;
> older installed resource reads remain available.

MCP interface version: 2.15.0. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve
a project, select the explicit task, read resume_task, and preserve canonical
versus proposed provenance. Operational checkpoints require taskId; a
project-level checkpoint must explicitly declare projectLevelIntent=project_note
and is excluded from task resume. Use categorized blocker objects for new
mentions. Prefer search_context compact=true for agent reads when the legacy
canonicalRecords alias is not needed. Never put private project records into
the public repository or CI logs.
