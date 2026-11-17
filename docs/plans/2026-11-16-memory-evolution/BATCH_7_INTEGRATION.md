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
  adds explicit temporal eligibility metadata and bounded dual lexical/
  temporal candidate lanes for current/historical queries. Source event,
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
validity is separate from event/validity eligibility. The SQL temporal lane
requires explicit seconds and bounded hour/minute/second fields. Valid
dated current operational observations precede future/expired/invalid ones
after exact IDs, with lexical score still ordering within each tier. Mixed
tense is recognized without converting purely historical questions to
current. A literal UUID remains retrievable in phrase mode.

A separate adversarial review caught substring matching inside an unrelated
record ID. Full record-ID equality is now required for the identity lane;
textual identifier mentions remain valid. A negative synthetic test failed
before and passed after the correction. Exact UUID phrase lookups still use
a strictly bounded exact-identity recovery path.

The extra temporal FTS/LIKE lane is now skipped when the lexical candidate
window is complete, and historical queries do not perform a superseded
selection when that status is excluded. This prevents unnecessary second
queries. However, broad saturated temporal searches can still require a
second sorted scan; an isolated reviewer measured roughly 1.9 times the
unmodified source latency on a 12,000-row synthetic corpus. This remains
a quantified ME-06/ME-07 performance and resource gate, NOT proof of a
production improvement. Indexed temporal retrieval or an explicitly
evaluated bounded recall/latency tradeoff may be needed before release.

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
