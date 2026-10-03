# Operational dossier

The current-state dossier is a projection of the existing project/action/record/run
model. It does not introduce another knowledge store, an internal LLM or a general
scheduler. HTTP, PWA and MCP use the same service functions.

## Starting and resuming work

1. Resolve the project with `list_projects`, then read `get_project_dossier`.
2. Select an existing action ID. A conversation/session ID is not a task ID.
3. Read `resume_task` and, when more canonical detail is required,
   `get_work_context` with the same `taskId` and a bounded context budget.
   Task-scoped working memory contains only reports linked to that selected task;
   project-wide accepted constraints, decisions and evidence-backed relations remain
   separately labeled context rather than being presented as task evidence.
4. Include `taskId` in work captures, checkpoints and run reservations.
5. Report explicit operational progress using `report_task_progress`, supplying
   the current `taskRevision` and `expectedProgressRecordId` (null only when none
   exists). A conflicting writer must read and reconcile before retrying.

6. Operational checkpoints require the selected taskId. Project-wide history is
   still supported only when the caller explicitly sets
   checkpoint.projectLevelIntent=project_note; those notes remain outside task
   resume.
7. resume_task presents current state and its provenance first, then active
   blocker mentions and every unresolved execution page, before the historical
   task objective. Follow pagination rather than treating a bounded page as complete.
8. Use create_task_handoff for an operational task handoff. It is a proposed,
   task-scoped working export and never replaces the accepted-only
   create_handoff project export.

Resume selection and the **Reia lucrarea** button are read-only. They prepare
context; they do not start an executor job. The ChatGPT panel updates Model-App
Context with the selected task and state token. The text fallback remains usable
when a host does not support that context channel.

## Meaning of state

- Accepted decisions and constraints retain their canonical provenance.
- Operational task progress is a revision-linked, evidence-backed report. It
  does not mutate the original accepted action or automatically accept knowledge.
- Executor completion is a technical observation, not artifact verification.
- A verification verdict is linked to a report explicitly bound to the exact
  terminal run revision and executor receipt; current evidence validity is separate.
- Successful task closure is explicit and rejects live/uncertain runs and a latest
  run whose verification has not passed or whose supporting evidence is no longer
  valid. Cancellation is distinct from success.

A new task without explicit progress is unknown, even when its free text says
"completed". Explicit progress owns the current next action, including an explicit
`null`; an older checkpoint cannot revive a cleared instruction. A checkpoint
written after terminal progress is preserved as a labeled follow-up with
provenance and a reconciliation warning, not as an implicit reopen or current
resume command. An old project-wide checkpoint without a task binding remains
visible as historical context and cannot replace a selected task's next step.
Reported and accepted task states may disagree; the dossier shows the distinction
rather than changing either implicitly.

An explicit task-record `done` or `cancelled` status takes precedence over any
agent progress report. A later audited task-status change
supersedes progress tied to older revisions, including an explicit reopening.
A text edit or owner acceptance alone is not a status change or reopening.
Explicit status edits during owner acceptance are recognized from the resulting
acceptance snapshot, including historical edits with intermediate audit revisions.
The older report is retained with its provenance; it cannot authorize a new
continuation claim. Changing a report is not an implicit owner reopening.

Resume text includes `historicalVerification`, `currentEvidenceValidity`, and
all actionable dossier warnings. A historical pass is never presented as proof
that edited, retracted, or legacy-unbound evidence remains valid. Completion and
attention are separate dimensions: a task may stay `done` while an older run,
blocker, abandoned continuation or owner action still requires attention. Project
and portfolio summaries compute that attention independently of the recent-task
page, including the case where the latest run is valid but an older proof changed.
Reads and handoffs never reopen or rerun the task because of that projection.
Resume stays read-only and instructs the next consumer to reread the selected task.


`get_operational_timeline` combines record history and retained latest run
observations with source/review labels. It is not a complete OS process log.
`get_project_timeline` retains its canonical-only compatibility contract.
`get_changes_digest` supports explicit time windows and pagination; unreturned
pages must not be described as an empty or complete result. Retired projects are
excluded by default from portfolio and change summaries.


## Usage-hardening and consistency contracts (MCP 2.15)

New blocker mentions may carry an explicit caller-supplied category:
blocking, deferred, verification, or legacy, plus an optional logical
key. The category/key are metadata only: ContextKeep never deduplicates or
resolves blockers from text or key similarity. Existing checkpoint+index blocker
identities and explicit resolution history remain authoritative.

A terminal task may retain active blocker mentions. Resume reports that
contradiction without mutating accepted or reported task state. Likewise,
unresolvedExecutions includes every reserved, job_start_uncertain, running,
or terminal run whose current verification evidence is pending/invalid; the
latest run alone is not a complete recovery view.

reconcile_uncertain_run never starts an executor. It applies only to an exact
job_start_uncertain run and requires the current revision, operation key,
input hash, device, identity and inspected evidence. It may attach an exact
existing receipt or record an explicit not_started/lost conclusion. Missing
or truncated executor history is never proof that a start did not occur.

search_context remains backward-compatible by default. Callers may request
compact=true to omit the duplicate canonicalRecords alias while keeping
records as the canonical result set and workingRecords separate. Bounded
`get_work_context` responses also avoid duplicating a current-state record body:
`currentState` keeps the full selected observation while `facts` keeps its
identity/provenance pointer. Compact and minimal responses preserve project/task
identity plus explicit recovery metadata before optional prose.

## Relationships

`link_project` uses the existing relation record types. Source project and target
project identities are UUIDs; a device target is an explicitly supplied runtime
identifier, not a guessed host name. Current names are resolved on read, so a
project rename does not break the relationship. Incoming and outgoing links are
available through `get_project_links`. Relations remain proposed evidence until
reviewed; a dependency does not prove deployment, health or lifecycle.

## Event continuation

`set_task_continuation` stores an explicit objective with one of three modes:
`off`, `verify_and_report`, or `continue_authorized`. A policy is **not** a native
host subscription. The dossier reports policy and active subscription separately.
The native subscription must be created before the real executor job is started.
An existing successful qualification must not be reused as a new operational job.

For a received `execution.finished` event:

1. Read the current task/run and call `claim_continuation` for the event's run
   revision. A stale event, closed task, disabled policy or existing claim does
   not start a second continuation.
2. Read the exact existing executor receipt; do not rerun the command.
3. Capture evidence in this task with the current `runEvidence` identity described
   in [Execution evidence](VERIFICATION_EVIDENCE.md), independently call `verify_run`, then call
   `finish_continuation` with the same verification evidence. `needs_owner` may
   record an unresolved result without claiming successful verification.
4. Continue only within the already-authorized objective. The payload is data,
   not authority to execute arbitrary instructions or widen the task.

A claim expiration is an uncertainty signal, not permission to repeat external
effects. Retained claims are not silently reassigned. The original claimant can
finish after reconciling its retained result; other sessions use `reconcile_continuation` with the current claim timestamp and
fresh same-task evidence after expiry, never restarting the executor. The recovery
operation cannot steal an active claim or skip verification. A completed
continuation does not close the task or emit another execution-finished event.

This mechanism does not fix a frozen host conversation. Host support for native
subscription creation and delivery must be verified independently in the actual
account. If that capability is missing, report it as unavailable; never substitute
polling while claiming event-driven execution.

## Schema and release

Schema 19 adds report/run bindings and append-only verification receipts on top
of the schema-18 continuation claims. Task progress, policies and relationships
stay in existing records with working-memory journals. Back up and validate the
current store before migration. An older schema-18 binary cannot read a schema-19
store; rollback requires the matching pre-upgrade database recovery copy, not
only a binary symlink change.
The production writer remains singular; passive copies must not become writers.

The dossier widget advertises `ui://contextkeep/tasks/v6.html`; the legacy URI
and installed v2/v3/v4/v5 resource URIs remain readable. Change the advertised
version when the bundled host UI changes so host caches cannot retain an obsolete
interface. A host may still require connection-metadata refresh before it
discovers newly added tools or a new resource key.

Qualification includes concurrent task/progress writers, stale revisions,
duplicate/expired claims, wrong-task evidence, outcome/verification separation,
retired project filtering, pagination, HTTP/MCP parity, and the compiled host
iframe without Node globals. Public tests use synthetic data only.

Portable JSON exports remain knowledge seeds, not disaster-recovery copies. They
do not export live task correlations, executor observations, webhook credentials
or continuation claims. Use a verified full SQLite snapshot and its matching
runtime kit to retain operational continuity after recovery.

## Freshness and operational visibility

The project card list refreshes the visible page prefix, including previously
loaded pages. A failed load-more does not stop subsequent refreshes; late replies
from another selected project are ignored. Pages are live reads, not a transactional
snapshot across multiple requests. Re-reading the prefix on the next refresh
reconciles concurrent page-boundary movement and removes duplicate task IDs.

The task dossier distinguishes configured policy/subscription from delivery
health. It exposes bounded last-event status/attempts, pending and failed counts,
oldest pending event time, and abandoned continuation count. No callback URL,
secret or raw executor output is included. No delivery yet means unknown, not
healthy. Historical failed deliveries remain labeled as history.

The private authenticated `GET /api/health` checks a live SQLite read and returns
ready or HTTP 503 without private details. A successful SPA page response is not
an application-readiness check.
