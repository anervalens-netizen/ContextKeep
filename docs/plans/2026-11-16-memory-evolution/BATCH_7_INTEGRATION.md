# Batch 7 — combined source candidate for scoped and temporal retrieval

Date: 2026-11-17

Scope: ME-06, ME-08 and ME-13 IN_PROGRESS. V-06/V-08/V-13 PARTIAL.

## Source composition

- [ME-13 scoped MCP filters](BATCH_7_SCOPED_SEARCH.md) expose validated
  optional project, recordType, recordedFrom and recordedTo parameters to
  the existing HTTP search backend. The inclusive UTC date range filters
  recordedAt, not sourceEventAt or effective time. Canonical accepted and
  proposed working results remain distinct arrays.
- [ME-06/ME-08 temporal retrieval](../../../apps/server/src/services/search-time.ts)
  adds explicit temporal eligibility metadata and a bounded lexical
  overscan with local temporal candidate selection for current/historical
  queries. Source event,
  effective validity, capture and review time stay distinct. Invalid/future/
  expired evidence is marked, not promoted to healthy current knowledge.
  Exact identifier priority and default internal synthesis behavior remain.
- The combined API retains search_context legacy defaults. The tool catalogue
  descriptions are made more concise without changing input/output schemas
  or relaxing the existing 200,000-byte serialized catalogue test gate.
  No database migrations or authoritative-memory changes are included.

## Adversarial correction of temporal ranking

Independent source review identified specific counterexamples: malformed
reviewDueAt invalidated a valid event; SQLite accepted timestamp shapes
rejected by TypeScript; lexically strong future claims could outrank a
valid current operational observation; mixed past/present intent collapsed
to historical; and exact UUID lookups in phrase mode were unrecoverable.

The combined candidate adds regressions for those cases. Review schedule
validity is separate from event/validity eligibility. Read-time event
validation requires explicit seconds and bounded hours/minutes/seconds. Valid
dated current operational observations precede future/expired/invalid ones
after exact IDs, with lexical score still ordering within each tier. Mixed
tense is recognized without converting purely historical questions to
current. A literal UUID remains retrievable in phrase mode.

A separate adversarial review caught substring matching inside an unrelated
record ID. Full record-ID equality is now required for the identity lane;
textual identifier mentions remain valid. A negative synthetic test failed
before and passed after the correction. Exact UUID phrase lookups still use
a strictly bounded exact-identity recovery path.

The former second full-match FTS/LIKE temporal sort is replaced by a
**single lexical query** with an overscan bounded at 400 rows, followed by
local temporal selection and at most 200 scored candidates per scope.
The existing project/status/type/date authority filters apply before the
bounded query. Completeness marks saturation even when a relevant newer
observation may lie beyond the candidate window.

A reproducible synthetic A/B fixture in
apps/server/test/temporal-saturated-benchmark.test.ts uses 12,000 rows,
4 warmups and 18 measured calls per query, executed separately against
pre-temporal main, the former combined candidate and the one-pass candidate
on the same host. Mean milliseconds observed:

| Query | Pre-temporal main | Former combined | One-pass candidate |
| --- | ---: | ---: | ---: |
| Current | 27.69 | 68.61 | 31.78 |
| Historical | 27.30 | 55.07 | 28.81 |
| Neutral | 25.07 | 24.80 | 25.16 |

These are synthetic source-level results, NOT production latency, provider
cost or a frozen private corpus. The one-pass candidate restores performance
near the original baseline but sacrifices the old unbounded-depth temporal
lane's ability to discover the newest qualifying document far beyond the
lexical overscan. An adversarial saturated corpus may require narrower
project/type/date constraints or a separately indexed temporal path to
preserve complete current-state recall. Therefore V-06/V-08 and the
performance/recall acceptance gate remain PARTIAL: a latency benchmark
alone cannot qualify this candidate for release. The independent high
picomatch advisory still blocks the required CI dependency audit.

These are source contracts only. They do not establish deployed behavior
or replace a frozen private retrieval benchmark, representative latency
measurements or security release gates.

## Source validation and limits

A combined candidate must pass the MCP tool-list budget and compatibility
regressions, date/scope filters, temporal search tests and the full backend
suite. Passing the isolated feature-branch tests is not by itself proof of
combined compatibility. Source review, CI and qualified deployment on the
final exact commit are separate requirements.

ME-13 still lacks taskId/sourceId/excerpt and alternate temporal-axis
filters. ME-06/ME-08 still need a representative frozen private retrieval
comparison, conflict/currentness evaluation, and latency/resource gates.
The upstream picomatch advisory remains an independent failing audit
check; do not disable it merely to integrate source work.

This public documentation contains source contracts only. Actual runtime
and backup observations stay in private ContextKeep project memory.
