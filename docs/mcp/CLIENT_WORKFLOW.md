# Client workflow

MCP interface version: 2.24.0. Supported protocol contract: 2026-07-28.

Use authenticated MCP requests against an operator-configured endpoint. Resolve a project, read bounded work context, preserve canonical versus proposed provenance, then capture progress with a stable idempotency key. Never put private project records into the public repository or CI logs.

## Selecting a task from search

Use `taskState.effectiveState` for a current task hit when present, and keep the
original `taskStatus` as record history. Inspect `stateSource`,
`stateProvenance` and `progress` separately; a proposed completion report is
not accepted knowledge. Follow the returned `resume` pointer before continuing
work. The pointer only identifies a read: it does not reopen a closed task,
resolve blockers, verify a run or authorize replay. Missing `taskState` does
not establish whether an action is an active task.

## Correlating a Remote Control job

Prefer the discovered read-only Remote Control `job_input_hash` tool to prepare the exact input hash. Reserve the run before starting the executor. The reserved `inputHash` must be
Remote Control's canonical **job input** hash, not a hash of a deployment plan or
higher-level intent. Use the same exact command, working directory and environment
in the reservation calculation and the subsequent `job_start` call.

```js
import { createHash } from 'node:crypto';

function jobInputHash({ command, cwd, env }) {
  const entries = Object.entries(env ?? {})
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const environment = entries
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(',');
  const canonical = `{"command":${JSON.stringify(command)},"cwd":${JSON.stringify(cwd ?? null)},"env":{${environment}}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
```

Top-level key order is `command`, `cwd`, `env`; omitted `cwd` becomes `null` and
omitted `env` becomes `{}`. Environment keys are lexicographically ordered and
serialized directly, including integer-like keys. Preserve command whitespace
and Unicode exactly; do not append a newline or substitute ASCII-escaped JSON.
Do not include `operationKey`, device, identity, source revision, idempotency key,
lease or diagnostic scope in this hash. Scope and execution identity have their
own validation. Prefer the executor's exported `jobInputHash` when available.

After `reserve_run`, use `begin_run` and pass its current lease plus the exact
project/task/run IDs to one `job_start` with a stable executor idempotency key.
Read back the exact receipt and task run. A returned job does not by itself prove
that correlation or terminal observation succeeded. Verification remains a
separate evidence-bound operation; it does not close the task or accept reports.

If attachment fails, inspect the existing job and the reserved hash. Reconcile
that receipt with `reconcile_uncertain_run`; never start the command again to
repair correlation, rewrite historical hashes, or treat missing bounded history
as proof that execution never started.

## Recovering source evidence after working-search saturation

For source evidence without a known source identity, start with a project-scoped
`search_source_evidence` query. Use the hit's `detailArgs` to verify evidence.
Keep source excerpts, accepted records and proposed progress separate. If a
page version changed, restart the read before continuing. Refresh the tool list
after upgrading an existing connection to MCP 2.24.0.

After a working search reports candidate saturation, use this fallback only
when the question names a concrete object within a known project. Issue up
to two project-scoped source lookups using the literal question or focused
wording drawn from it. Keep the search and excerpt pages bounded. For a
plausible hit, pass the returned version-fenced `detailArgs` to `get_source`
and check the redacted passage itself. If a connector requires an explicit
text-page offset and `detailArgs` omits it, supply `offset: 0` and retain
the returned `excerptOffset` and `expectedVersion`.

Check that the passage identifies the actual stored data object, host or
cache and distinguishes the source or origin from its copies. A product
archive or a repository archive in the same topic cannot establish where
stored messages reside. When a question has a known exact cutoff, check
the relevant evidence timestamp at the caller. Missing, invalid or
post-cutoff timestamps leave the as-of claim unresolved. Keep the passage
and its provenance separate from ranked records and their review status.
Report insufficient evidence when the text only matches the topic.

For linked records, use `search_context` with `projectId` and either
`taskId` or `sourceId`. A task filter includes the task and its linked
records. A source filter requires a stored evidence link. When both are set,
a record must satisfy both. These filters work with canonical, working and
combined scope and apply to record lists and ranked results. They suppress
independent project and source suggestions.

An excerpt with `unavailableReason: "invalid_normalized_utf16_span"` has no
usable normalized excerpt text. Its empty span has offsets `0,0`. Other excerpts and the source page remain
available. Verify evidence using a valid excerpt or a direct source page.

Owner HTTP source detail and search use the same invalid-span marker while
retaining authorized text for valid stored spans. The source response labels
excerpt offsets as normalized UTF-16. Use the opaque page cursor even when the
last excerpt is unavailable. Its displayed empty span carries no ordering
information. A valid legacy cursor continues from its original position and
receives a new cursor bound to the normalized source snapshot.
