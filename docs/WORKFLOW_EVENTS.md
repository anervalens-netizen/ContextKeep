# Task workflows, plugin UI and events

Tasks reuse current action-record IDs. Call list_tasks to discover an ID, then
get_task or get_work_context with projectId/taskId. capture_work and
capture_working_memory accept optional taskId. Legacy project-only callers still
work. A task-specific read never substitutes another task's checkpoint.
Operational run changes do not promote proposed knowledge or mark actions done.

## Executor correlation

1. Subscribe to execution.finished for the project/task before starting a fast job.
2. reserve_run persists operationKey, inputHash, device, identity and explicit
   verification criteria. The operation key identifies one intended effect.
3. begin_run uses a revision fence and persists job_start_uncertain before any
   external effect. Its lease token identifies that one attempt. Lease expiry is
   never permission to launch another job.
4. Pass the reservation to the optional executor bridge, or attach_run_job manually.
5. observe_run records terminal observations; verify_run requires an evidence-linked
   report captured in the same task. Completion and verification remain distinct.

For Remote Control, inputHash is SHA-256 of UTF-8 JSON.stringify of
{command,cwd:cwd??null,env:Object.fromEntries(sorted environment entries)}.
Environment keys are sorted with localeCompare, matching jobInputHash in the
executor bridge. Commands and environment values are not event payloads.

If a start response is lost, inspect executor state and retained idempotency
reservations. Do not issue a new job with the same or a new key merely because
the previous result is unknown.

## Plugin UI

open_task_panel declares global/thread entrypoints and ui://contextkeep/tasks.
resources/read serves a self-contained MCP App built separately from PWA startup.
The shared dossier is also available in the PWA project overview. It uses read
tools through the MCP Apps bridge; browser cookies and PWA embedding credentials
are not assumed to authorize the app. Model-App Context carries selection IDs
and action revision only. Host extensions are feature-detected; selection never
starts an executor job.

## Events and delivery

The authenticated MCP endpoint implements events/list, events/subscribe and
events/unsubscribe. SDK 2.1.0 removes draft event capabilities from modern
discovery serialization; the HTTP route restores just capabilities.events in
a successful discovery response. A wire-level SDK-client regression covers this
adapter. Revisit it when upgrading the SDK.

Subscriptions are deterministic per authenticated endpoint principal, callback,
event and canonical filters. Secrets are encrypted using the configured session
secret. Rotating the endpoint bearer invalidates delivery for its old principal.
Callbacks require HTTPS, public DNS resolution at connection time, no redirect,
a bounded signed challenge and constant-time comparison. Key refresh supports
a short dual-signature rotation interval. Expiration and action-record validity
are rechecked before each delivery. Already in-flight HTTP cannot be recalled.

An observation and its event/outbox entries commit in one SQLite transaction.
Workers use expiring delivery reservations, stable event IDs and fresh signatures.
Transient failures back off; 410 and 413 stop retries. Delivery attempts are
bounded. Receipt 2xx does not prove host processing or completion.

The pilot event has cursor:null and no protocol replay. Subscribe before starting;
if a job finishes before subscription, read get_task to recover the retained state.
Pending deliveries survive restart. Capturing an agent report emits no event,
preventing report-triggered feedback loops. Event data are observations, never
instructions or new authority.

## Qualification

Run pnpm release:gate with isolated fixtures. Separately validate the live runtime
build identity, backup/restore, actual plugin resource rendering, callback
registration and a host-triggered continuation. A local browser, synthetic receiver
or passing SDK test does not establish ChatGPT host availability.
