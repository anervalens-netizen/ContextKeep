# MCP interface

> Current operational contract: MCP 2.20 / schema 19. Explicit task creation,
> compatible task selection and classified attention build on the existing
> task-scope, execution-evidence and no-replay contracts. Reports remain proposed.
> See [Operational dossier](OPERATIONAL_DOSSIER.md) and
> [Execution evidence](VERIFICATION_EVIDENCE.md). The host widget is v7.4;
> older installed resource reads remain available.

MCP interface version: 2.21.0. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve
a project, select the explicit task, read resume_task, and preserve canonical
versus proposed provenance. Operational checkpoints require taskId; a
project-level checkpoint must explicitly declare projectLevelIntent=project_note
and is excluded from task resume. Use categorized blocker objects for new
mentions. Prefer search_context compact=true for agent reads when the legacy
canonicalRecords alias is not needed. Never put private project records into
the public repository or CI logs.

## Exact evidence and bounded recovery

Captures preserve original evidence and technical outcome case/whitespace. Source
reuse requires an exact content hash within the same project; normalized text is
a separate search representation. Explicitly different event times produce
distinct proposed observations even when their source is reused. An exact
outcome without a new explicit time can still gain additional evidence. Same-key
retries replay their receipt, including receipts from the older trimmed contract.
These rules do not change canonical record deduplication or accept agent reports.

`get_source` defaults to `representation=normalized`; request `original` for
the stored original. Both representations are redacted in full before pagination.
`offset`, `nextOffset` and `totalChars` describe Unicode code points in the
delivered representation; follow `nextOffset` and keep the representation fixed.
`contentHash` hashes the stored original, `normalizedHash` the search text, and
`deliveredHash` the complete redacted representation (SHA-256 over UTF-8).
Excerpts retain normalized UTF-16 offsets and use length-preserving redaction
computed against the complete normalized source, including matches across excerpt
boundaries. Page reads support up to 20,000 code points; capture input supports up
to 64,000 UTF-16 units. New NUL-containing text is rejected explicitly; historical
source reads preserve it. Already discarded historical originals cannot be rebuilt.

`resume_task(depth=compact|balanced|deep)` and the HTTP resume route provide the
same bounded projection used by Copy, Attach and Send. Each summary and next
action has its own source reference. The latest separate report is visible but
does not override progress merely because it is newer. Depth loads stored record
detail before applying a per-field bound (600/1600/4800 UTF-16 units); omissions
include recovery pointers. State, follow-up, warnings, blockers, unresolved runs
and continuation remain distinct. Host acknowledgement does not prove execution.

Task history keeps its own cursor while execution/active-blocker pages change.
Explicit task refresh also refreshes the current history page. Structured errors
retain safe code, message, retry guidance and next action; uncertain effects still
require reconciliation before retry.

### Bounded operational resume (MCP 2.19)

For agent continuation, call `resume_task` with `format=structured`,
`depth=compact` and `totalContextBudgetChars=6000`. This returns one dossier,
without a duplicate prose export or the historical original objective.
Current state includes its source, review status and evidence provenance,
plus task revision and expected progress record ID for subsequent fences.
`get_task` is needed only for missing evidence or a stale snapshot.

The default `format=both` preserves existing panel and export consumers.
An explicit budget bounds the serialized structured payload in characters,
not tokens or the complete MCP transport envelope. If essential authority or
next-action metadata cannot fit, the call returns
`context_budget_unrepresentable`; increase the budget instead of dropping
authority. Reduced pages retain exact counts and recovery offsets.

`get_work_context` keeps state provenance even at its minimum budget.
Checkpoint excerpts mark field truncation and omitted blockers. Compact
working-memory indexes retain record IDs and recovery pointers before
discarding current reports. Historical task objectives are explicitly
labelled and cannot override effective state. Central workflow tools
advertise and validate required result identities, revisions and pagination.

## MCP 2.20 panel transport

The versioned v7.4 task panel keeps its initial UI data in result `_meta.contextkeepPanelBootstrap`. Model-facing structured content retains selection, revision and bootstrap metadata without duplicating full memory; the visible text is a short acknowledgement. Older resource URIs remain readable. App-only `panel_list_projects` and `panel_list_tasks` return compact selectors with routing identity and state provenance. Full dossier/evidence reads retain their existing contracts. The bootstrap remains bounded, redacted and read-only.

The PWA pauses private reads after an authentication failure until authentication is revalidated. Request logs record bounded client categories and credential-presence booleans, never header values or query credentials. These categories are diagnostic hints, not trusted caller identity.

Generic sources for the six installed continuity workflows are versioned under `plugins/contextkeep-workflows`; private account bindings remain in the owned plugin release.

### Blocker pages

`list_blockers` defaults to the existing active, resolved and history pages. Set
`state` to `active` or `resolved` to select those records, and set
`includeHistory: false` to omit the duplicate history page. Counts remain exact
for the full task or project scope; `selection.historyCount` describes the
filtered history. Each included array has its own next offset; omitted arrays
have a null next offset. Use that array's offset to continue paging.
