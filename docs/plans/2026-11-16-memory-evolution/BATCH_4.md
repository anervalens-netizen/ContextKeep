# Batch 4: compact catalogue and controlled consumer

Date: 2026-11-16\
Programme items: ME-24 / ME-25; release duties ME-41–ME-48 / ME-50\
Accountable role: development agent; independent review and qualification

## Status and boundaries

**ME-24 VERIFIED; ME-25 VERIFIED within the bounded consumer scope.**
The compact/conditional server passed 55 focused tests, both current-head reviews,
required CI and all 12 release-gate stages. Isolated candidate recovery,
guarded activation and authenticated full/compact/conditional readback passed.
The existing database and schema 19 were preserved. A newly produced deployed-release
backup was independently restored with matching runtime/database identity,
preserved schema/counts, passing authenticated HTTP checks and complete cleanup.

The corrected companion consumer passed 51 catalogue scenarios, 148 targeted
tests, the 902-test Python suite, both current-head reviews, CI and guarded
component-only installation. Its authenticated scheduled full/compact control,
later conditional revalidation, API readiness and shared service-generation
receipt passed. The earlier primary serialization comparison remains valid for
its original pre-fix source, not a new measured post-fix release result.
This is a bounded catalogue/consumer change.
It does not tune retrieval ranking, aliases or held-out questions. The previous
private corpus, scorer and observations remain frozen. No database migration,
new embedding provider or additional memory store is introduced.

The inspected public source baseline is
`b5435a34c2d8a96a57c74598ed81467df422df9d`.
The qualified server advertises MCP **2.23.0** with schema **19**. Exact operational
source/runtime identities, consumer bindings and execution receipts remain in
the private evidence ledger.

## Server contract: ME-24

The detailed contract and synthetic request/response examples are in
[project-catalogue.md](../../mcp/project-catalogue.md).

| Concern | Qualified server behavior |
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
Liveness does not substitute for this check. The companion implementation is
[PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53).
Its own current-head reviews, component-only activation and authenticated live
readback passed, independently of the server release. The shared Command Center
backend/collector release receipt was requalified without relabeling the older
frontend baseline. The unrelated owner-health stage remains independently
failed/unknown where its DSH delivery evidence is unavailable.

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

## Measured synthetic result

The single primary result and its independent review were reread, and totals
were recomputed from every retained per-call row. All eight frozen input hashes,
the producer fixture and the prospective amendment match the primary receipt.
No primary measurement was replayed for this documentation update.

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Successful checks | 60/60 | 60/60 |
| Identical project rows per check | 120 | 120 |
| Complete serialized MCP result bytes | 12,037,320 | 1,158,120 |
| Catalogue calls | 180 | 195 |
| Initialization calls | 60 | 60 |
| Total MCP requests | 240 | 255 |
| Maximum adapted JSON-RPC HTTP body | 83,568 B | 83,568 B |

**Result-byte reduction: 90.3789%, passing the predeclared 50% threshold.**
The 15 additional catalogue calls are the periodic full-control pages. Full
control traffic and compact validation are included in both the bytes and counts.

The harness uses captured responses from the actual producer with isolated
synthetic data, adapting only JSON-RPC response IDs and the synthetic sentinel
name. Five-minute simulated timestamps span 4 h 55 min from the first check to
the last. This is not a natural observation period, production latency result,
wire-byte total or provider billing measurement. Processing durations retained
in the receipt do not establish a server CPU or network-latency improvement.

The result applies to this controlled workload. It does not attribute all
historical catalogue traffic to one consumer or prove savings for every client.

## Qualification evidence and remaining gates

| Gate | Current record |
| --- | --- |
| Server regression suite | 55 focused tests passed, including 17 catalogue tests; shared/server/web typecheck passed |
| Consumer failure matrix | Corrected consumer: 51 catalogue tests, 148 targeted tests and 902 full Python tests passed |
| Matched serialization comparison | Passed; complete primary rows, frozen inputs and independent recomputation retained |
| Server source reviews | Current-head Codex and DSH reviews and explicit dispositions passed |
| Server CI and release gate | Required CI and all 12 release-gate stages passed |
| Recovery and capacity | Previous snapshot restored in isolation; candidate verified against the same restored database; capacity and cleanup passed |
| New deployed-release snapshot | Production capture and independent exact restore passed; runtime/database identity, schema/counts, authenticated HTTP checks and complete cleanup verified |
| Server source/runtime activation | Merged source, guarded activation and original database identity verified |
| Deployed server contract | Authenticated full, compact and conditional pages matched; runtime MCP 2.23.0 / schema 19 verified |
| Consumer source/runtime | [Companion PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53) merged; both current-head reviews, explicit finding disposition and CI passed; guarded three-file component release preserved unrelated owner code. Scheduled full control and later conditional check passed with 44 identities/five fields, and shared API/collector receipt is verified. |
| Review/task closure | Server grouped review closure read back; consumer disposition published. The independent private bridge/task closure is verified separately from this public source. |

### Companion source, review and deployed evidence

[PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53)
merged the bounded consumer at public head
`6ebf475fb9c1691772519fb02f652b03a85d38e5`; its final commit changed
only historical measurement documentation after functional review at
`ab90cc99cfabb1b74cd182d123787921c3813ae3`.
[DSH functional review](https://github.com/anervalens-netizen/astancu-website/pull/53#issuecomment-6929240885)
confirmed the compatibility fixes. The
[exact-head DSH review](https://github.com/anervalens-netizen/astancu-website/pull/53#issuecomment-6929377268)
found no new defect; the
[version-bound developer disposition](https://github.com/anervalens-netizen/astancu-website/pull/53#issuecomment-6929422275)
records fixed findings and the explicitly deferred, fail-closed 48-second
multi-page slow-route budget. [Exact-head CI](https://github.com/anervalens-netizen/astancu-website/actions/runs/43956328906)
passed, including the full Python regression suite.

The guarded production change installed exactly the compact catalogue module,
owner-health wrapper and application-registry classification. The deployed
wrapper and registry retained locally qualified OpenClaw/HP integration changes
absent from the public PR; the current module matches the reviewed functional
source. The authenticated scheduled cold control and subsequent warm
conditional check preserved all 44 identity rows and five required fields, with
no fallback or catalogue restart. The API and collector generation, the backend
generation and their shared release receipt were checked independently.
These are **dated, narrow** release observations, not a natural-traffic
performance test. Operational hashes, private locations and logs remain in
the private evidence ledger.

### Public server source and reviews

[PR #30](https://github.com/anervalens-netizen/ContextKeep/pull/30) was reviewed at
head `9a0e0244c48adcc8c24bc8d3122de4d83214bd00` against base
`b5435a34c2d8a96a57c74598ed81467df422df9d`, then merged in
`39aa969658630b8b3e5fd25723701a2eab525de4` with the same source tree.
[Codex](https://github.com/anervalens-netizen/ContextKeep/pull/30#issuecomment-6925853401)
reported no findings and
[DSH](https://github.com/anervalens-netizen/ContextKeep/pull/30#issuecomment-6925945612)
reported no confirmed new defect. The
[version-bound disposition](https://github.com/anervalens-netizen/ContextKeep/pull/30#issuecomment-6925990677)
records the corrected guide headers, coherent-pagination rules and separate
follow-ups below. [CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43932903162)
and [public-source checks](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43932903027)
passed. The original failing guide-version gate remains in the private evidence;
no assertion was weakened.

Host names, endpoints, private task IDs, operational reports and private metrics
stay outside this repository. Public source identity and a synthetic comparison
do not substitute for the separate private runtime and recovery receipts.

## Review follow-ups

Initial review of `0385fe22dda64f176e337fd0ad4698fbef8ae67c` found two
current-guide headers still declaring MCP 2.22.0. The operational contract test
failed. Both headers now declare 2.23.0. The same assertion, all 84 operational
recovery tests and the full release gate passed on the corrected head before
promotion.

The pagination contract now explicitly requires clients that omit the optional
server fence to compare every page's catalogue version and discard a changed
pass. The controlled consumer sends the fence and validates returned versions.

| Follow-up | Disposition and acceptance |
| --- | --- |
| ME-24 scaling cost | Keep response-byte savings separate from database work. Every compact or conditional page performs an O(N) metadata read. Characterise larger catalogues and actual call rates before claiming a server CPU or latency improvement. |
| Import lifecycle validation | Deferred existing defect in `dump-import.ts`: invalid lifecycle strings can make legacy and compact output fail their schema. Validate imports against the shared lifecycle enum and add invalid/valid import regressions in a subsequent integrity change. Preserve the imported source and report invalid values rather than silently rewriting them. |

These follow-ups remain open. Neither is covered by a successful 120-project
serialization comparison, and this batch does not claim to fix them.

## Continuation

ME-24, ME-25, [V-24](VALIDATION.md#v-24) and [V-25](VALIDATION.md#v-25)
passed their scoped qualification and release gates. The immutable server
backup was restored independently; the consumer's live full and unchanged
conditional checks and related service-generation proof passed. The whole
owner-health pipeline is **not** claimed healthy where an unrelated DSH
delivery stage reports failure. The 48-second aggregate MCP deadline fails
closed for slow multi-page controls; characterize p95/p99 times and catalogue
size under ME-48 before changing the service budget. Future ME-45 evaluation
must use matched natural traffic, distinct from the frozen pre-fix synthetic
comparison. Retain failed scenarios, declared limits and review provenance.
Error attribution, source indexing and retrieval remain separate tracker items;
this batch does not close the full programme.
