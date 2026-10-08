# MCP interface

> Current operational contract: MCP 2.17 / schema 19. Explicit task creation,
> compatible task selection and classified attention build on the existing
> task-scope, execution-evidence and no-replay contracts. Reports remain proposed.
> See [Operational dossier](OPERATIONAL_DOSSIER.md) and
> [Execution evidence](VERIFICATION_EVIDENCE.md). The host widget is v7;
> older installed resource reads remain available.

MCP interface version: 2.17.0. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve
a project, select the explicit task, read resume_task, and preserve canonical
versus proposed provenance. Operational checkpoints require taskId; a
project-level checkpoint must explicitly declare projectLevelIntent=project_note
and is excluded from task resume. Use categorized blocker objects for new
mentions. Prefer search_context compact=true for agent reads when the legacy
canonicalRecords alias is not needed. Never put private project records into
the public repository or CI logs.
