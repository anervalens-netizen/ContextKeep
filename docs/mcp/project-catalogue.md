# Compact and conditional project catalogue

Source contract: MCP **2.23.0**, database schema **19**. This is an additive
`list_projects` contract. Deployment and qualification status are recorded
separately in [Batch 4](../plans/2026-11-16-memory-evolution/BATCH_4.md).

Use this read for project identity and metadata. A catalogue version does not
describe project memory, execution state or application health. Read the
appropriate dossier, resume or evidence tool for those purposes.

## Compatibility and request fields

Omitting `projection` retains the existing full response, including descriptions,
aliases, parent information and content versions. Explicit `projection: "full"`
returns the same shape. REST project routes and the app-only
`panel_list_projects` selector retain their existing contracts.

| Argument | Contract |
| --- | --- |
| `projection` | `full` by default; `compact` selects the fixed five-field projection |
| `offset` | Integer at least 0; default 0 |
| `limit` | Integer from 1 through 50; default 50 |
| `q` | Optional trimmed string, 1–200 characters; existing name/alias SQL `LIKE` matching |
| `lifecycle` | `all` by default; compact reads also accept `unknown`, `planned`, `active`, `paused`, `retired` |
| `ifVersion` | Optional compact-page condition; send the cached `pageVersion` for the exact request |
| `expectedCatalogVersion` | Optional compact pagination fence; send the first page's `catalogVersion` on subsequent pages |

Version inputs are trimmed nonempty strings of at most 128 characters. Unknown
fields, invalid types and out-of-range values return `invalid_input`.
`ifVersion`, `expectedCatalogVersion`, and a lifecycle other than `all` require
`projection: "compact"`; full mode does not silently ignore them.

`q` keeps its existing semantics, including the SQL `LIKE` behavior of `%` and
`_`. This is not a new exact-name resolver. Exact duplicate project names remain
rejected by project creation/update. Shared aliases and differently cased names
can match several identities; retain their separate IDs and resolve ambiguity
explicitly.

## Compact body

Call `list_projects` with these arguments:

```json
{
  "projection": "compact",
  "offset": 0,
  "limit": 1,
  "lifecycle": "all"
}
```

The following examples show `structuredContent`. The ordinary MCP result also
carries the same safe JSON in its text content. All names, IDs and tokens below
are fictional; clients must copy real returned tokens instead of constructing
them from these examples.

```json
{
  "scope": "all",
  "projection": "compact",
  "catalogVersion": "pc1-example-catalogue-version",
  "pageVersion": "pp1-example-page-version",
  "total": 2,
  "offset": 0,
  "limit": 1,
  "nextOffset": 1,
  "notModified": false,
  "projects": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Synthetic Atlas",
      "lifecycle": "active",
      "revision": 3,
      "updatedAt": "2025-01-02T03:04:05.000Z"
    }
  ]
}
```

Every compact project has exactly **`id`, `name`, `lifecycle`, `revision`,
`updatedAt`**. Legacy imported string IDs remain representable. The projection
does not include descriptions, aliases, parent IDs, lifecycle-record IDs,
`contentVersion` or `workingMemoryVersion`. Aliases still participate in matching
and invalidation.

`total` is the exact number of matching projects. `nextOffset` is the next page
offset or `null`. A successful empty catalogue has `projects: []`, `total: 0`,
`nextOffset: null`, and `notModified: false`. An offset beyond the end also
returns an empty page, while retaining the catalogue's actual `total`.

## Conditional page

Repeat the same request with its cached page version:

```json
{
  "projection": "compact",
  "offset": 0,
  "limit": 1,
  "lifecycle": "all",
  "ifVersion": "pp1-example-page-version"
}
```

When that exact page is unchanged, the response is:

```json
{
  "scope": "all",
  "projection": "compact",
  "catalogVersion": "pc1-example-catalogue-version",
  "pageVersion": "pp1-example-page-version",
  "total": 2,
  "offset": 0,
  "limit": 1,
  "nextOffset": 1,
  "notModified": true
}
```

**`projects` is absent.** The caller must already have the matching cached body.
It must not turn the missing property into an empty catalogue. If the cache is
missing, corrupt or belongs to another request, request a body without
`ifVersion` and bound recovery attempts.

A nonmatching `ifVersion` returns the current compact body with
`notModified: false`. This includes a version from another page, page size,
query, lifecycle filter or older token format. A catalogue version cannot
substitute for a page version.

This condition is part of the tool payload. The MCP route retains authenticated
POST and `Cache-Control: no-store`; it does not implement HTTP 304 for these
calls. Both content channels still pass through redaction and the complete MCP
result-size guard.

## Coherent pagination

1. Read the first page and retain its `catalogVersion`.
2. Request each `nextOffset` with the same query, lifecycle and page size.
   Supply the first page's version as `expectedCatalogVersion`.
3. A matching cached page can additionally supply its own `ifVersion`.
4. Publish the assembled catalogue only after all pages have passed the same
   version fence.

The catalogue fence is checked before the page condition. A mismatch returns
an MCP error result with `isError: true` and this structured error:

```json
{
  "error": {
    "code": "project_catalogue_changed",
    "message": "The project catalogue changed. Discard accumulated pages and restart at offset 0.",
    "retryable": false,
    "nextAction": "restart_catalogue_from_first_page",
    "resetRequired": true
  }
}
```

Discard pages from the interrupted pass and restart at offset 0 without the
stale fence. Do not merge old and new pages or retry the identical stale request.
The consumer must cap restarts and report persistent churn as an incomplete
check. `expectedCatalogVersion` is optional for compatibility, so a consumer
that omits it cannot claim that several calls form one stable snapshot.

## Versions, invalidation and cost

Versions are opaque equality tokens, not monotonic counters. The implementation
uses an HMAC over the catalogue contract/schema, authenticated context, scope,
query, lifecycle and ordered matching metadata. Page versions additionally bind
the offset and limit. Clients must not parse the prefix or infer a timestamp,
authority level or health status from a token.

The reader issues one explicit SQLite metadata query for every compact call.
Sorting, exact count, version and page derive from that statement's snapshot.
Descriptions are not selected and full project DTOs are not constructed.
Conditional requests still perform the database query.

The version detects changes affecting the filtered catalogue: membership,
names, aliases, lifecycle, metadata revision and update time. Aliases are included
even though the compact body omits them. Equal timestamps or equal revision
numbers cannot hide a name, alias or membership change. Normal metadata updates
also advance their metadata revision. Import or restore can change the catalogue
without using an ordinary update path; the next read hashes the actual rows.
Restoring identical relevant metadata can restore an earlier token value.

The configured authentication secrets bind the version namespace. Rotation
invalidates earlier tokens. Each call authenticates independently; possessing
a catalogue token never grants access. There is currently one authenticated
all-projects scope, not a new per-project permission system.

Each call reads all matching metadata before slicing the page. `limit` bounds
the returned page, not the database work. Measure this cost for the expected
catalogue size; do not interpret a small response as proof of constant query
cost or a production latency guarantee.

## Consumer cache and health discipline

Keep cached pages scoped by endpoint origin, authenticated context, projection,
query, lifecycle, offset and limit. Do not place a raw bearer in logs or public
cache keys. Validate cached page shape, identities, counts and versions before
using `notModified`. Never combine caches from different authenticated contexts.

An identity cache is not a successful health check. A network check must still
traverse the authenticated application boundary and execute a database read.
Missing/wrong bearer, browser cookie/origin shortcuts, application errors,
malformed responses, timeouts, database failures and incomplete page sets remain
failures. Do not advance the last successful observation or full-control time
on those paths.

Preserve a periodic full semantic control read at a declared maximum age.
Keep its result separate from catalogue metadata freshness. Canonical or working
memory can change while the compact catalogue stays unchanged. A full control
also does not replace task-specific resume or execution verification.

During a mixed-version rollout, use a bounded compatibility fallback only when
the older server rejects the new input contract. Do not reinterpret an
authentication failure, database failure or arbitrary tool error as a successful
fallback. Report the actual initialization, catalogue, restart and fallback
calls, including any extra calls needed by the control read.

## Qualification

The synthetic regression suite is
[`project-catalogue.test.ts`](../../apps/server/test/project-catalogue.test.ts).
It covers compatibility, fixed fields, pagination/reset, version scope,
ambiguous aliases, equal-timestamp changes, imports/restores, authentication,
database failure and redaction/budget boundaries. Test presence does not assert
that the suite has passed.

[V-24 and V-25](../plans/2026-11-16-memory-evolution/VALIDATION.md#v-24)
define the evidence required for server and consumer qualification. The
[Batch 4 record](../plans/2026-11-16-memory-evolution/BATCH_4.md) separates
implementation, matched measurement, reviews, release gates and deployed
readback. Operational identities and production observations remain private.
