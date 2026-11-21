# Task workflows, plugin UI and events

Tasks reuse current action-record IDs. Call list_tasks to discover an ID, then
get_task or get_work_context with projectId/taskId. capture_work and
capture_working_memory accept optional taskId. Legacy project-only callers still
work. A task-specific read never substitutes another task's checkpoint.
Operational run changes do not promote proposed knowledge or mark actions done.

## Executor correlation

1. Register a draft webhook or obtain a beta poll cursor for the project/task before starting a fast job.
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

open_task_panel declares global/thread entrypoints and
ui://contextkeep/tasks/v2.html. Resource URIs are host cache keys: bump the
version when shipped HTML, JavaScript or CSS behavior changes, and update the
tool descriptor and resource listing together. The legacy ui://contextkeep/tasks
URI stays readable while existing developer connections refresh their metadata.
After deployment, refresh the developer-mode connection in ChatGPT Plugins;
reloading the app page alone does not refresh imported metadata.
resources/read serves a self-contained MCP App built separately from PWA startup.
The shared dossier is also available in the PWA project overview. It uses read
tools through the MCP Apps bridge; browser cookies and PWA embedding credentials
are not assumed to authorize the app. Model-App Context carries selection IDs
and action revision only. Host extensions are feature-detected; selection never
starts an executor job.

## Events and delivery

### ChatGPT draft webhooks

The authenticated `/mcp` endpoint implements events/list, events/subscribe and
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

Draft callbacks carry `cursor: null` and support delivery retries. Subscribe before
starting a job. If it finishes before subscription, read `get_task` for the retained state.
Pending deliveries survive restart. Capturing an agent report emits no event,
preventing report-triggered feedback loops. Event data are observations, never
instructions or new authority.

### SEP-3415 beta poll

Connect a modern MCP client to `POST /mcp/events-beta` using the same owner
bearer as `/mcp`. This events-only profile uses protocol `2026-07-28`.
`server/discover` advertises `capabilities.extensions["io.modelcontextprotocol/events"] = {}`.
On this endpoint, `events/list` describes `execution.finished` with
`delivery: ["poll"]` and the project/task argument and occurrence data schemas.
The client may declare the extension in its per-request capabilities.
See the [beta Events specification](https://github.com/modelcontextprotocol/ext-events/blob/main/specification/beta/events/events.mdx).

For example, send the following JSON body with the usual bearer and JSON
content headers, `Accept: application/json, text/event-stream`,
`MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: events/poll` and
`Mcp-Name: execution.finished`. For discovery or listing, set `Mcp-Method`
to the requested method and omit `Mcp-Name`.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "events/poll",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "example-client", "version": "1" },
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/events": {} }
      }
    },
    "name": "execution.finished",
    "arguments": {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "taskId": "22222222-2222-4222-8222-222222222222"
    },
    "cursor": null,
    "maxEvents": 10
  }
}
```

The first poll (omitted or null cursor) returns an empty batch and the current
task head. Persist that cursor. Subsequent polls return occurrences in insertion
order, including those recorded while the client was offline. Each occurrence
contains `eventId`, `name`, `timestamp` and `data`. Process the batch, deduplicate
by `eventId` within the subscription, then persist the **response** cursor.
Retrying from the previous cursor can return the same IDs. Polls default to 50
events and return at most 100. Drain `hasMore: true` immediately, otherwise
wait `nextPollMs` (30 seconds). Stopping the client ends polling.

`maxAgeMs` limits replay by occurrence time. When older events are skipped,
`truncated: true` signals a possible gap. A valid cursor whose anchor is missing
after a database restore returns an empty truncated batch at the current head.
Use the fresh cursor and read the authoritative task/run state to reconcile.
Each poll checks the current project/task association and action-record status.
An unavailable scope returns `Forbidden` (`-32024`). Cursors are authenticated
for one bearer principal, event and filter. Reusing a cursor with another scope
or after credential rotation returns `InvalidParams` (`-32602`). After rotation,
obtain a fresh head and reconcile the task. Preserve the configured session
secret and bearer across ordinary restarts.

### Storage compatibility

Both profiles read the terminal observation committed to `workflow_events`
since schema 17. Its unique event ID also identifies signed draft deliveries.
Schema 19 supplies the task/sequence index used for polling. This profile
requires no migration or backfill. Even rows recorded without any webhook
subscriber can be replayed from an earlier poll position. Existing draft
subscription IDs, signed bodies and queued deliveries keep their stored values.
Polling only reads the log and creates no callback registrations.

## Qualification

Run `pnpm --filter @contextkeep/server exec vitest run test/beta-events.test.ts`
for synthetic poll conformance and the loopback HTTP restart regression. The
test verifies signed draft callbacks with an in-process receiver.

Run `pnpm release:gate` with isolated fixtures. Separately validate the live runtime
build identity, backup/restore, actual plugin resource rendering, callback
registration and a host-triggered continuation. A local browser, synthetic receiver
or passing SDK test does not establish ChatGPT host availability.
