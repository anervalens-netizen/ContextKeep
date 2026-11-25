# MCP interface

> Current source contract: MCP 2.25 / schema 19. Compact and conditional project
> catalogue reads extend the existing full response. Explicit task creation,
> compatible task selection and classified attention build on the existing
> task-scope, execution-evidence and no-replay contracts. Reports remain proposed.
> See [Operational dossier](OPERATIONAL_DOSSIER.md) and
> [Execution evidence](VERIFICATION_EVIDENCE.md). The host widget is v7.4;
> older installed resource reads remain available.

MCP interface version: 2.25.0. Supported protocol contract: 2026-07-28.
Read `get_capabilities` for the installed version; a source contract is not
deployment evidence. The bundled workflow procedures are also discoverable through
[Skills over MCP](mcp/workflow-skills.md); installed plugin skills remain available.

Use authenticated MCP requests against an operator-configured endpoint. Resolve
a project, select the explicit task, read resume_task, and preserve canonical
versus proposed provenance. Operational checkpoints require taskId; a
project-level checkpoint must explicitly declare projectLevelIntent=project_note
and is excluded from task resume. Use categorized blocker objects for new
mentions. Prefer search_context compact=true for agent reads when the legacy
canonicalRecords alias is not needed. Never put private project records into
the public repository or CI logs.

For native `execution.finished` subscriptions, see the
[ChatGPT Work Cloud webhook workflow](WORKFLOW_EVENTS.md#subscribe-from-chatgpt-work-cloud).

## Evidence times and revalidation

`sourceEventAt` describes when an observation happened. `effectiveFrom` and
`effectiveTo` describe an inclusive start and exclusive end of validity.
`recordedAt` is capture or import time. `reviewedAt` is the review action time
and `reviewDueAt` is a review deadline. A missing timestamp remains unknown.
Legacy empty-string structured timestamps are treated as absent for freshness
eligibility, not as a new event date. Such capture-only working observations
may still prompt review without supporting staleness; malformed nonempty and
future/expired dates remain ineligible for current-state support.
Current search can use a valid effective start when event time is absent.

- **Operational facts.** An accepted current-state claim can warrant
  revalidation when a strictly newer, time-eligible proposal concerns the
  same entity. A capture-only or weakly related proposal can prompt a check
  without establishing staleness. A future, expired or malformed proposal
  cannot support a current-state change. Proposals retain working authority.
- **Explicitly volatile facts.** A configured review interval begins at acceptance
  and can trigger a due review. A deadline changes review urgency. The original
  observation and validity times are retained.
- **Stable decisions, constraints and reference evidence.** Age and missing
  volatility metadata alone do not invalidate these records. Honor explicit
  validity, supersession, conflicts or correction. Documentary source excerpts
  carry their own snapshot identity. When that identity changes, rediscover the
  excerpt before using it as support. Attached source history and owner-reviewed
  record authority remain traceable.
- **Tasks and handoffs.** Use the task's effective lifecycle and execution evidence
  as well as provenance. The capture timestamp alone cannot establish completion
  or verification.

When a newer operational report is corrected or superseded, the next read
recomputes its contribution. A source change or review deadline is a reason to
verify the claim. Only the existing owner review workflow changes canonical
authority.

## Compact and conditional project catalogue

`list_projects` defaults to its existing full response. Optional
`projection: "compact"` returns exactly `id`, `name`, `lifecycle`, `revision`
and `updatedAt`, with pagination and optional lifecycle selection. The supported
lifecycle states include `planned`; default `all` retains every state.

`catalogVersion` binds the matching catalogue and `pageVersion` binds the exact
page. Matching `ifVersion` returns `notModified: true` with `projects` absent.
The caller must possess that cached page. `expectedCatalogVersion` fences later
pages; a mismatch returns `project_catalogue_changed` with `resetRequired: true`
and `nextAction: "restart_catalogue_from_first_page"`.

Every call still authenticates and performs a real SQLite metadata read.
Tokens are opaque, scoped to the authenticated context and request, and
invalidated by relevant metadata changes or credential rotation. They do not
describe canonical/working memory or runtime freshness. Keep caches scoped by
origin, authentication and exact page/filter arguments; retain periodic full
semantic control reads for a health consumer.

The [complete catalogue contract](mcp/project-catalogue.md) documents arguments,
synthetic examples, pagination recovery, invalidation, query cost and cache
discipline. [Batch 4](plans/2026-11-16-memory-evolution/BATCH_4.md) records the
separate server/consumer qualification and release gates.

## Effective task state in search

Current actual-task hits expose an additive `taskState` projection in HTTP search
and both compact and legacy `search_context` responses. The original
`taskStatus`, record review status, evidence basis and freshness remain intact.

- `effectiveState` and `stateSource` use the dossier's task/progress precedence.
- `stateProvenance` identifies the winning record and its own review status,
  evidence basis and timestamp. A proposed report remains proposed.
- `progress` identifies the latest valid progress report, including its task
  revision; it can differ from the winning state source.
- `resume` supplies `resume_task`, project and task identity. It is a read pointer,
  not an instruction to reopen a terminal task or repeat execution.

For reported progress, `stateProvenance.recordedAt` is the report capture time.
For a task-record source it is the task update time, matching the dossier; it
is not the event or validity time. Unknown state can retain the inspected task
record as provenance without establishing a known effective state.

A terminal task record can retain precedence over later open/blocked progress.
Rejected, superseded or historical hits and actions classified as evidence do
not acquire current task state. Absence of `taskState` is not a completion signal.
Consumers should read the selected task's dossier/resume for blockers, unresolved
runs and current evidence validity before executing work.

The PWA card labels effective state and shows its provenance separately from the
task record status. Search performs no business-state mutation. Compact mode
still does not impose a total context budget.

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
