# Batch 5 — bounded outcome and capacity evidence (ME-45 / ME-48)

Date: 2026-11-17

Status: **PARTIAL EVALUATION**, no production source change

Predecessor: [Batch 4](BATCH_4.md), with ME-24 and ME-25 already verified

## Scope and control

This batch continues the single [memory evolution tracker](../../../MEMORY_EVOLUTION_TRACKER.md).
It does not reopen Batch 4 or introduce another model, database, storage
backend, metrics service, timer or background worker. The evidence is read-only.
The release producer and companion have different deployment identities; a
single checkout or CI result cannot prove that the two live processes agree.

The natural readout reuses the existing MCP counters/histograms
(`ck_mcp_tool_calls_total`, `ck_mcp_tool_result_bytes_*`,
`ck_mcp_tool_duration_seconds_*`) and owner-health execution logs. Both
comparison windows are eight hours long and their endpoints are retained
with exact UTC timestamps in the **private evidence ledger**.

| Quantity | Interpretation and exclusion |
| --- | --- |
| MCP tool counts and serialized bytes | Aggregate successful `list_projects` calls, not a specific client or network-wire/billing cost |
| Tool latency | Server handler duration and bucket-estimated quantiles; does not include end-to-end client/TLS latency |
| Owner-health checks | Entire source/perimeter/DSH monitor; stage failures cannot be attributed automatically to the catalogue |
| Retrospective windows | Matched duration, **not** time-of-day, request characteristics, client population or deployment cohort composition |
| Live paired sample | Authentic read-only complete/compact/unchanged responses compared on identical project identities and consumed fields; extra observer requests, not natural traffic |

Before/after exploration was **not prospectively preregistered**. Existing
metrics cover two independently scraped periods with stable counter identities,
but no consumer identity label. A favourable aggregate difference therefore
does not establish the contribution of one particular client. Preserve bad
or incomparable cases rather than adjusting the denominator. The original
pre-fix synthetic comparison from Batch 4 remains a separate experiment.

## Capacity and the 48-second consumer budget

A separate read-only capacity observation examines SQLite main/WAL/SHM file
footprints; page size/count/free-list, table versus index pages; host filesystem
reserve, process RSS/high-water/swap and historical resource samples. Existing
encrypted backup receipts are checked for integrity, retention and freshness.
The *compressed encrypted archive size is not a proxy for logical SQLite growth*.
One point and one short telemetry interval cannot demonstrate a memory leak,
write lock contention, long-term WAL growth or retention impact. There is no
hardware/SQLite migration decision in this batch.

For a cold/full-control catalogue with `limit=50`, and no pagination restart,
the theoretical request budget is:

| Matching projects | Pages | MCP calls, including initialize | 48 s divided by calls |
| --- | ---: | ---: | ---: |
| 1–50 | 1 | 3 | 16.0 s |
| 51–100 | 2 | 5 | 9.6 s |
| 101–150 | 3 | 7 | 6.86 s |
| 151–200 | 4 | 9 | 5.33 s |
| 201–250 | 5 | 11 | 4.36 s |

Each request is capped at 8 seconds and also by the *remaining* 48-second
whole-probe deadline; the last column is only a simple average allowance,
**not** a per-request timeout. Server/client processing overhead, restarts,
failures and the wider service deadline reduce actual headroom. For the
current single-page cohort, three bounded requests do not approach 48 seconds
in the observed paired read-only sample. Larger catalogues and slow peers
must be evaluated separately before changing this contract. Missing budget
must fail closed and retain the last successful observation.

## Decisions and next acceptance gates

1. **Keep** the current verified compact/conditional contract and fixed
   fail-closed timeout. The exploratory readout does not justify a second
   code release or a new metrics backend.
2. **ME-45 stays IN_PROGRESS / V-45 PARTIAL.** Compare prospectively equal
   local-clock windows and, where possible, the same known consumer cohort
   with a fixed case/field mix, exact source/read identities, error categories
   and independent client round-trip timing. Track releases separately and
   retain failed/omitted cases.
3. **ME-48 stays IN_PROGRESS / V-48 PARTIAL.** Obtain longitudinal *database*
   main/WAL/index samples, lock-contention and bounded write/backfill
   latency measurements under an isolated nonproduction fixture. Do not
   infer database growth from encrypted backup sizes.
4. **ME-27 is a possible dependency, not delivered here.** Consumer attribution
   may improve future comparisons, but it must use a finite, privacy-safe
   identifier without user/project/session labels or cardinality explosions.
5. Do not mark the broader programme done. ME-45/V-45 and ME-48/V-48
   remain open until their named gates have evidence; no synthetic pass
   substitutes for these omitted live conditions.

Private operational timestamps, measurements, file hashes and evidence paths
remain in ContextKeep task-scoped memory. No production database, identifier
list, endpoint, credential or private infrastructure receipt belongs in
this public document.
