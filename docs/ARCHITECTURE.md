# ContextKeep architecture and invariants

This document describes the public contract. Paths, hosts, credentials and
operational records are deliberately omitted.

## Authority and evidence

- `accepted` records are reviewed, evidence-backed knowledge. `proposed`
  records are working material and do not silently become authority.
- A project `revision` is optimistic-concurrency metadata for the project or
  record shape. Canonical and working-memory `cursor` values are independent
  content positions. A revision change is not a cursor advance, and a cursor
  advance is not permission to overwrite a stale revision.
- A reset is an explicit recovery from an expired/ahead cursor or an invalid
  baseline. The client discards the unusable page token, reads a committed
  full snapshot, and resumes from its returned cursors; it does not invent a
  cursor or merge across an unknown baseline.
- A logical mutation has one stable event/idempotency key and one request
  fingerprint. Reusing that key for different arguments is a conflict. An
  unknown result keeps its barrier so a retry cannot become a second effect.

## Source, runtime and primary identity

Source identity (the trusted revision being built) and runtime identity (the
release directory, interpreter and data directory actually used) are separate
claims. A checkout, active service or HTTP 200 is not proof of the other claim.
The operational verifier and backup manifest bind the configured data path to
the runtime release, database hash and retained runtime-kit hash.

There is one writable SQLite primary. Readers used for online backup are
allowed, but a restore must stop or fence the writer and verify the target
before invoking the restore CLI. Standby copies remain recovery material, not a
second writable primary.

## Accepted versus proposed protocol details

The accepted implementation already preserves canonical/proposed provenance,
revision-bound writes, independent cursors, stable idempotency claims and
indeterminate outcomes. The result-compaction rule below is the agreed R13
target contract; it is marked proposed until the server implementation and
regressions expose the exact tombstone response.

When a completed response body is compacted, the durable idempotency row keeps
the key, request fingerprint and a result hash/tombstone. A retry receives
HTTP 409 with code `idempotency_result_expired`: the earlier request completed,
but its stored response expired. Completion may describe validation or another
non-mutating result; it does not assert that a business mutation was applied.
The protocol meaning is completed request, expired stored result, and
`reconcile` next action. The client must reconcile current state, and the
server must never auto-rekey that retry. Indeterminate outcomes persist and
require reconciliation rather than blind replay.

Current source references: [durable idempotency](../apps/server/src/services/idempotency.ts),
[cursor journal](../apps/server/src/services/context-journal.ts),
[HTTP idempotency hooks](../apps/server/src/app.ts), and
[MCP safety](../apps/server/src/mcp/safety.ts).
