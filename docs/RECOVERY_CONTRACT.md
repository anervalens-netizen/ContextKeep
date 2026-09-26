# HTTP and MCP recovery contracts

## HTTP mutations

For a supported authenticated mutation, the `Idempotency-Key` identifies one
logical event and the request hash binds its method, URL and canonical body.
The server persists the business effect and the completed response before
emitting response bytes. A completed claim can be replayed byte-for-byte;
`pending` is retryable only as an in-progress 409; `indeterminate` means the
effect may have committed and must be reconciled.

Completed response bodies older than the configured retention window
(default 30 days) are compacted into durable key/hash tombstones. A retry returns HTTP 409
with `idempotency_result_expired`: the earlier request completed, but its
stored response expired. A completed request may have been a validation/error
or other non-mutating result; this code does not claim that a mutation was
applied. The protocol meaning is completed request, expired stored result, and
`reconcile` next action. The client reconciles, and the server never auto-rekeys
or executes the mutation again. Indeterminate outcomes remain durable and use
`idempotency_outcome_unknown`. Both responses are implemented recovery states;
clients must distinguish unknown effect from expired completed result.

## Cursor and reset recovery

Canonical and working cursors are scoped separately and carry the project
revision used to build their snapshot. An expired page token is discarded.
The client restarts from committed cursors or requests a full snapshot when
the server says `resetRequired`; it does not apply a delta to a different
revision or fabricate a stable event identity.

## MCP results

MCP responses retain both protocol forms: a text content item and
`structuredContent`. The result-byte ceiling covers the complete serialized
dual-form result (currently enforced by the server safety boundary), while a
semantic context budget controls how much useful project context is selected.
Those budgets are distinct: shrinking semantic context is not a way to evade
the protocol-byte limit, and byte truncation must not produce an invalid
structured result. Credential-like values are rejected or redacted at the
boundary.

Server MCP also maps an older oversized or corrupt cached reply to
`idempotency_result_unavailable`, retains the original key and directs
reconciliation. It does not create a new key or re-execute the write. This
implemented path is separate from `idempotency_outcome_unknown` (unknown
effect), `idempotency_result_expired` (compacted response) and `result_too_large`
(a newly generated result exceeding the result budget).
Clients should inspect the structured error code and `nextAction`, preserve
the original idempotency key for an explicit retryable in-progress case, and
reconcile state before retrying any indeterminate or expired result. See the
[MCP safety implementation](../apps/server/src/mcp/safety.ts) and
[context delta service](../apps/server/src/services/context-delta.ts) for the
current source behavior.

## Browser storage refusal

Cosmetic settings can use a memory fallback. Unreadable privacy settings are
not reported as cleared data. The owner may explicitly open an online-only
view without reloading; local persistence and replay remain disabled. Private
reads do not resume before that choice. Queued operations never move silently
to volatile storage or receive replacement event keys.

## Maintenance writers

Migration, seed and non-dry-run portable import share the server runtime lease.
Stop the application before invoking these writers. Online backup readers and
portable-import dry-run validation remain supported.
