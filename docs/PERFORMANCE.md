# Performance contracts

Performance changes must preserve accepted/working-memory separation, evidence
completeness, authorization, and temporal currentness. A small response alone is
not proof that a read performs bounded work.

## Memory reads

The freshness observation loader streams proposed agent-report facts in one
project-scoped scan. It prepares text relationships once and shares a bounded,
connection-local, project-versioned index between brief and work-context reads.
Observation-derived signals are cached; final currentness verdicts are not.
Effective dates, review deadlines and the caller's current clock are evaluated on
every read. Unresolved conflicts remain live reads because their lifecycle is
not represented by the observation version alone.

Cache admission is an optimization, not a retrieval cutoff. If a prepared index
exceeds its retained-size budget, every observation still contributes to the
requested signals. Reference samples are bounded and their total counts and
truncation flags remain explicit. Eviction triggers recomputation, not omission.
Transaction reads do not publish reusable snapshots; separate database handles
never share private observations. Cold reads after a version change still have
to examine the relevant data and should be measured separately from warm reads.

## Search

The project list has one shared query key and one provenanced value shape across
consumers. Its durable mirror is available offline. A missing project label must
be displayed as unavailable, not replaced by an incorrect all-projects scope.

Typing uses a short debounce. Filter-only navigation must preserve an uncommitted
draft, while explicit navigation and history restoration remain authoritative.
Obsolete requests consume cancellation signals. Cancellation must not write a
stale cache entry, trigger offline fallback, or appear as a server error.

Record type and recorded-date filters apply before candidate selection in both
canonical and working searches. Date bounds are inclusive UTC calendar dates on
`recordedAt`; they are not source-event or effective dates. Invalid calendar dates
and reversed ranges are rejected. Project/source discovery buckets are excluded
when record-only filters are active, rather than presented as matching records.

Result windows are bounded. Request limits do not remove the candidate cap or
guarantee exhaustive retrieval. Completeness flags must stay visible when the
user needs to refine a query. Every filter, scope and result window belongs in
both request identity and offline cache identity; unfiltered legacy entries must
never satisfy a filtered request.

## Initial rendering

Public route modules may load alongside session bootstrap. Their private queries
must not run before the authenticated shell mounts the page. Delaying secondary
work or rendering records progressively is distinct from paginating an HTTP
payload; do not report one as evidence of the other.

## Regression checks

Run the full release gate as documented in the root README. Targeted checks
include `apps/server/test/freshness-versioned.test.ts`,
`apps/server/test/freshness-bounded-context.test.ts`,
`apps/server/test/search-filter-bounds.test.ts`,
`apps/web/test/search-performance.test.tsx`, and
`apps/web/test/route-preload-auth.test.tsx`.

Freshness work tests count executed SQL calls and returned/streamed rows,
including native iterators. They cover cold scans, warm reuse, version changes,
transaction rollback, independent connections, time boundaries, conflict changes,
long reports and cache eviction. Optional synthetic timing output is diagnostic;
machine-sensitive latency is not a replacement for correctness or deterministic
work budgets. Browser qualification should include rapid typing/filter changes,
late responses, populated offline searches, unavailable cached queries, server
errors and narrow viewports. Keep real deployment measurements, user data and
recovery receipts in private operator storage rather than this repository.
