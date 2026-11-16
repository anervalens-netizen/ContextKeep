# Batch 4: compact catalogue and controlled consumer

Date: 2026-11-16\
Programme items: ME-24 / ME-25; release duties ME-41–ME-48 / ME-50\
Accountable role: development agent; independent review and qualification

## Status and boundaries

**IN_PROGRESS.** The compact/conditional server candidate passed shared, server
and web typechecks and 55 focused tests, including 17 new catalogue scenarios.
The matched comparison, current-head reviews, required CI, full release
qualification and deployed readback remain pending in this record. Focused
validation does not establish an installed release.

ME-24 and ME-25 remain IN_PROGRESS. This is a bounded catalogue/consumer change.
It does not tune retrieval ranking, aliases or held-out questions. The previous
private corpus, scorer and observations remain frozen. No database migration,
new embedding provider or additional memory store is introduced.

The inspected public source baseline is
`b5435a34c2d8a96a57c74598ed81467df422df9d`.
The candidate advertises MCP **2.23.0** with schema **19**. Exact operational
source/runtime identities, consumer bindings and execution receipts remain in
the private evidence ledger.

## Server contract: ME-24

The detailed contract and synthetic request/response examples are in
[project-catalogue.md](../../mcp/project-catalogue.md).

| Concern | Candidate behavior |
| --- | --- |
| Existing callers | Default full `list_projects` response remains unchanged; REST and panel selectors remain compatible |
| Compact projection | Exactly `id`, `name`, `lifecycle`, `revision`, `updatedAt`; no full descriptions |
| Selection | Existing name/alias matching, ordered pagination and optional compact lifecycle filter, including `planned` |
| Conditional result | Exact `ifVersion` match returns `notModified: true` with `projects` absent |
| Cross-page consistency | `expectedCatalogVersion` mismatch returns `project_catalogue_changed`, an explicit reset and restart instruction |
| Version scope | Opaque tokens bind schema, authenticated context, query, lifecycle and matching metadata; page tokens also bind offset/limit |
| Invalidation | Relevant metadata and membership changes, including equal timestamps, aliases and import/restore paths |
| Authentication and database | Both are exercised on every conditional network call; cached identity is not a health check |
| Query cost | One statement snapshot reads all matching metadata, then counts and slices it; response size does not imply constant DB cost |
| Meaning | Metadata version is separate from canonical/working memory and runtime state |

Exact duplicate names remain disallowed. Ambiguous aliases and differently
cased names are tested as distinct identities rather than introducing duplicate
exact names into an invalid fixture.

## Controlled consumer: ME-25

The companion change is qualified separately against the server contract.
Its compact projection must match the fields it actually consumes. Cache keys
include origin, authenticated context and exact page/filter arguments; missing
or corrupt cache cannot turn `notModified` into an empty healthy result.

The candidate retains the authenticated application perimeter and a real
database read on network checks. Periodic full semantic controls have a declared
maximum age. Every page must be present and coherent before publishing a
successful result. Error paths retain the previous successful observation and
do not advance success or full-control timestamps.

Compatibility fallback and catalogue resets must be bounded. Old-server input
rejection, authentication failure, application failure, invalid JSON, missing
required bodies, database failures and timeouts remain distinguishable.
Liveness does not substitute for this check. Consumer code/review/release
evidence must be linked before this item can be marked verified.

## Predeclared synthetic comparison

The comparison uses a fixed synthetic population and no production data.
An amended fixture declaration precedes measurement; the shorter descriptions
keep full baseline pages within the controlled consumer's existing response
budget. The original declaration and reason for amendment remain in the private
ledger. This is not a post-result adjustment.

| Parameter | Declared comparison |
| --- | --- |
| Catalogue | 120 fictional projects, deterministic IDs/aliases/lifecycle/metadata |
| Descriptions | 512 characters per project |
| Workload | 60 equivalent checks, with all pages read for each check |
| Pagination | Limit 50, maximum 5 pages |
| Baseline | Legacy full catalogue on every check |
| Candidate | Compact and per-page conditional reads; full semantic controls at check indices 0, 12, 24, 36, 48 |
| Control age | Synthetic spacing 300 seconds; full control maximum age 3,600 seconds |
| Primary metric | Sum of UTF-8 bytes of complete serialized MCP `CallToolResult` values for all catalogue calls, including text and structured content |
| Acceptance | At least 50% fewer result bytes over the matched workload; all identities and five consumed fields preserved |
| Additional accounting | Actual initialization/catalogue/page counts, full controls, resets, fallbacks and observed durations |

A lower call rate is not required. Any extra candidate calls count toward the
comparison. Full control traffic and successful compatibility fallback traffic
cannot be excluded to improve the result. Transport wire bytes, provider tokens
and monetary cost are distinct metrics and are not inferred from JSON sizes.

Failure scenarios cover absent/wrong/rotated bearer, browser/cookie perimeter,
application errors, malformed JSON, MCP errors, missing or corrupt cached
content, database failure with a matching condition, timeout, metadata changes,
mid-pagination changes, old-server fallback and exceeded page/read budgets.
Their required outcome is no false healthy state and bounded recovery.

No comparison result is asserted here yet. A synthetic improvement, when
qualified, applies to this controlled workload; it does not attribute all
historical catalogue traffic to one consumer or prove savings for every client.

## Evidence required before closure

| Gate | Current record |
| --- | --- |
| Server regression suite | 55 focused tests passed, including 17 catalogue tests; shared/server/web typecheck passed |
| Consumer failure matrix | Implementation and qualification in progress |
| Matched serialization comparison | Predeclared; no result recorded |
| Source reviews | Current-head Codex and DSH reviews/dispositions pending |
| CI and release gate | Pending |
| Recovery and capacity | Private qualification pending for this release |
| Source/runtime activation | Pending; source version alone is not deployment evidence |
| Deployed read-only contract | Server and controlled consumer readback pending |
| Review/task closure | Evidence and explicit closure pending |

The final record must include public PR/commit references, reviewed head/base,
review dispositions and applicable gate results. Host names, endpoints, private
task IDs, operational reports and private metrics stay outside this repository.

## Continuation

Complete [V-24/V-25](VALIDATION.md#v-24), then update the two item statuses and
the programme inventory consistently. Retain failed scenarios and declared
limits. Later error attribution, retention, retrieval and source-indexing work
remain separate tracker items; this batch does not close the full programme.
