# Batch 6 — bounded source contracts for attribution and capacity

Date: 2026-11-17

Status: **SOURCE QUALIFICATION; PROGRAMME VALIDATION PARTIAL**

Predecessors: [Batch 4](BATCH_4.md) and [Batch 5](BATCH_5.md).

## Technical scope

- [ME-27](../../../MEMORY_EVOLUTION_TRACKER.md#me-27): the
  [Command Center consumer change](https://github.com/anervalens-netizen/astancu-website/pull/55)
  implements fixed-shape complete/compact/unchanged result-byte counters
  and a locally assigned executor class. A shared MCP bearer and a declared
  clientId do not identify other callers. The event omits project, user and
  session identifiers. Source tests cover negative/auth failure paths and
  preserve the existing catalogue semantic-health check.
- [ME-48](../../../MEMORY_EVOLUTION_TRACKER.md#me-48): the
  [ContextKeep capacity observer](https://github.com/anervalens-netizen/ContextKeep/pull/31)
  defines a primary-only read-only SQLite file and page metadata sampler.
  It requires an effective read-only mount and uses the existing shared
  restore lease, bounds index scans, and produces an explicit file-only
  partial status only under qualified stopped-WAL conditions. It does not
  execute schema changes, WAL checkpoints, imports or writes.
- [ME-45](../../../MEMORY_EVOLUTION_TRACKER.md#me-45): preserve the
  earlier [evaluation methodology](BATCH_5.md); do not convert a
  retrospective mixed-client comparison into a causal performance claim.

## Source and safety validation

The code changes are linked through their immutable pull requests and
associated CI/review history. Source tests exercise failed authentication,
partial/unavailable MCP content, malformed result serialization, missing
or inaccessible SQLite, concurrent exclusive restore leases, WAL/SHM
write prevention, DELETE-mode busy classification, quiescent WAL with and
without an empty WAL file, truncated/forged SQLite main files, and bounded
index scans. These contracts do **not** substitute for actual deployment
readback or full SQLite integrity.

Only one known local catalogue consumer can carry a source-assigned class.
No per-user/agent identity is inferred from untrusted metadata. The
SQLite observer's file-only output is an explicitly incomplete filesystem
measurement rather than a healthy database verdict. A read-only sampler
can still hold a short shared lease, so a planned exclusive restore must
coordinate with the timer. The unit scope must remain bounded to the
single writer's environment; no standby writer is introduced.

## Outstanding acceptance gates

ME-27 and V-27 remain **PARTIAL** until additional trustworthy caller
categories, cardinality and retention are qualified. ME-45 and V-45 remain
**PARTIAL** until a prospective comparable consumer-cohort study retains
each request category, timing, error state, missing event and periodic
full-control cadence.

ME-48 and V-48 remain **PARTIAL** pending repeated capacity observations
from one verified database identity across representative days and
independently bounded lock/write/backfill tests outside production. A few
read-only samples cannot justify a SQLite migration, timer budget expansion,
or additional hardware. The 48-second catalogue-consumer deadline is a
separate fail-closed tradeoff; any change needs an independent evaluation.

## Evidence retention

The public source contains contracts, review references and programme
statuses only. Actual host identifiers, runtime versions, deployment
receipts, sampled values, backup identities, journal lines and confidential
operational evidence are stored in private ContextKeep task memory. They
must not be reproduced in public commits, comments or CI logs.

The same 50-item memory evolution tracker remains canonical. This batch
does not close the wider programme or reopen verified earlier scope.
