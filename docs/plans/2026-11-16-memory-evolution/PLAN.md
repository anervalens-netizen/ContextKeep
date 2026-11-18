# Memory, retrieval and usage improvement plan

Date: 2026-11-16\
Status: proposed implementation programme; planning deliverables only\
Execution status: [MEMORY_EVOLUTION_TRACKER.md](../../../MEMORY_EVOLUTION_TRACKER.md)\
Acceptance catalogue: [VALIDATION.md](VALIDATION.md)

## 1. Objective and decision

Make ContextKeep better at answering **what is true now, why it is believed,
what changed, and what the next agent should do**, with less unnecessary context.

Keep ContextKeep as the authority for project/task identity, accepted knowledge,
proposed operational reports, evidence and execution continuity. Improve the
existing read paths, producers and derived views first. Evaluate additional
memory systems only against a measured problem that remains.

This plan consolidates the usage, retrieval, ingestion and technology review
completed on 2026-11-15. It defines work; it does not claim that work is implemented,
that a pilot is approved for production, or that a vendor's benchmark applies here.
Source inspection used public revision
`d479ca8e6b6a95b50930077ada622e700fbf9949`. Recheck the code and runtime when
each item starts; later changes may already satisfy part of a requirement.

The public repository contains generic technical findings, synthetic scenarios
and acceptance contracts. The private ContextKeep project retains the complete
audit, exact usage counts, observation windows, operational identifiers, runtime
evidence and the finding-to-task crosswalk. Do not copy that evidence into public
issues, CI output, fixtures or commit messages.

### Desired outcomes

1. A question about current deployment finds the relevant dated observation.
2. A task originally blocked but subsequently completed has one effective state
   across search, dossier and resume, with historical status still inspectable.
3. A fact present only in detailed evidence is discoverable without being
   mislabeled as accepted knowledge.
4. Search returns a useful short result first, with explicit, version-aware reads
   for details and omissions.
5. Review and monitoring integrations preserve meaningful changes and evidence
   without flooding the default context.
6. Project briefs stay tied to source versions and can be refreshed safely.
7. Every claimed improvement has a baseline, a held-out comparison and a cost.

## 2. Scope, authority and invariants

The existing contracts in [OPERATIONAL_DOSSIER.md](../../OPERATIONAL_DOSSIER.md),
[ARCHITECTURE.md](../../ARCHITECTURE.md),
[RECOVERY_CONTRACT.md](../../RECOVERY_CONTRACT.md) and
[VERIFICATION_EVIDENCE.md](../../VERIFICATION_EVIDENCE.md) remain the starting point.

- Accepted knowledge, proposed reports, task progress, execution completion and
  current verification validity remain distinct. A high search rank is not acceptance.
- Existing record/task/source identities and source evidence remain recoverable.
  Compression of presentation does not authorize deletion of history.
- Reads, ranking, summaries and exports do not start jobs, accept facts, resolve
  blockers, change lifecycle or reopen closed tasks.
  Read telemetry, caches and safe pagination/cursor bookkeeping may update; the
  protected invariant is no implicit change to knowledge, progress, authority or
  external execution.
- Operational writes remain task-scoped. Revision fences, stable idempotency keys
  and explicit project-note intent remain enforced.
- Uncertain effects require reconciliation against the exact existing receipt.
  Missing or partial history is not evidence that execution never started.
- Explicit nulls, terminal task precedence, post-closure follow-ups and separately
  classified attention retain their documented semantics.
- Project/task boundaries, access controls, redaction and evidence provenance apply
  before snippets, embeddings, exports, caches and derived summaries are exposed.
- Retrieved source text is data, not authority to execute instructions embedded
  in it or to change a task's scope.
- There remains one authoritative writable store. FTS, vector indexes, graph
  projections, wiki pages and summaries must be derived and reconstructible.
- Derived claims must resolve their support to distinct primary evidence. A
  summary citing another summary, a citation cycle or multiple reports copied
  from one event does not add independent corroboration or increase authority.
- Public examples are synthetic. Private evaluation and production evidence stay
  in owner-controlled private storage.
- API inference is the default for any model-assisted pilot. This programme does
  not introduce local model infrastructure or a new general orchestrator.
- Preserve unrelated work, existing application identifiers and compatibility
  reads. Do not reopen completed audit/remediation tasks as a planning shortcut.

The plan does not authorize bulk acceptance of reports, deletion of repetitive
records, global deduplication, database replacement, a production graph stack,
automatic lifecycle changes, or installation of a third-party memory service.

## 3. Findings and complete coverage map

Classification: **existing** means reuse or preserve it; **confirmed** means a code
limitation or reproduced behavior; **diagnostic** means the observation does not
yet isolate its cause; **conditional** means an experiment with a stop decision.

| Finding | Evidence and interpretation | Work items |
| --- | --- | --- |
| F01 — Runtime and metadata can disagree | A repository checkout, project description or old topology is not proof of the active runtime. Capture explicit runtime/build/schema observations privately; reconcile descriptions using evidence. | ME-01, ME-04, ME-31, ME-48 |
| F02 — Operational capture dominates recent use | Proposed agent reports are intentional working memory. Their share is not an approval backlog. Canonical-only reads cannot represent all recent progress. Counts of records, calls, handoffs and correlated runs describe different populations. | ME-01, ME-03, ME-05, ME-23, ME-29 |
| F03 — Usage windows differ | Record history and retained sampled counters have different coverage. Gaps, resets, first samples and migration boundaries limit totals and weekly comparisons. Partial periods need explicit duration. | ME-01, ME-03, ME-27, ME-28, ME-29 |
| F04 — Large catalogue traffic | Repeated catalogue reads can dominate serialized results. A known consumer requests more fields than it uses. Scheduled frequency supports an attribution hypothesis, not an exact historical attribution. | ME-24, ME-25, ME-27, ME-45 |
| F05 — Error aggregates are too broad | Budget errors can have distinct causes. Client errors include workflow preconditions, not just schema validation or server failures. Explicit successful omissions are not automatically defects. | ME-11, ME-26, ME-29, ME-41 |
| F06 — Current-state ranking misses relevant recent evidence | Freshness warnings exist, but applying them after candidate ranking cannot repair selection. Accepted old facts and newer proposed observations need explicit, separate presentation. | ME-02, ME-06, ME-07, ME-08 |
| F07 — Search exposes original task status | Search can show the initial status while dossier/resume uses later effective progress. Reuse the operational projection; do not mutate the original record. | ME-05, ME-09 |
| F08 — Compact is not a search budget | The compact flag removes an alias, while bodies, checkpoints, evidence and freshness references can remain large. Structured resume already has a budget. | ME-10, ME-11, ME-12 |
| F09 — Source-only information is poorly discoverable | Existing FTS covers records/checkpoint projections. Detailed sources/excerpts lack equivalent MCP retrieval; discovery uses whole-query LIKE matching. This is a coverage gap, not evidence of content loss. | ME-13, ME-14, ME-15, ME-16 |
| F10 — RO/EN paraphrase behavior differs | Deterministic FTS5/BM25, Unicode handling and aliases already exist. Equivalent natural-language formulations can yield different relevant results. Ad hoc probes are not a benchmark score. | ME-02, ME-07, ME-17, ME-39 |
| F11 — Review labels misattribute the source | The review bridge preserves author evidence but uses a generic reviewer label. Correct summary attribution and review status. | ME-18, ME-20 |
| F12 — Same comment URL can have legitimate revisions | Existing delivery identity includes comment/body version and stable replay payloads. A changed head or review state must survive deduplication. No finding justifies deleting all bridge activity as duplicate. | ME-19, ME-20, ME-22 |
| F13 — No-change monitoring crowds working context | Repeated phrases are a candidate signal, not a semantic classification. Distinguish successful unchanged observations, missing coverage, failures, incidents and unresolved blockers. | ME-21, ME-22, ME-30 |
| F14 — Delta and relations are underused in observed data | Existing delta sessions and relation primitives should be exercised before adding another sync mechanism or graph database. Missing retained activity is not proof of never being used. | ME-30, ME-31, ME-32, ME-40 |
| F15 — Freshness/volatility metadata needs discipline | Sparse volatility tags do not prove all other records stale. Define evidence-class policy, event/effective/capture time and revalidation rules without indiscriminate flags. | ME-04, ME-08, ME-23, ME-31 |
| F16 — Existing evaluations are a foundation | RO/EN corpus, held-out tests and a semantic gate exist. Resume presentation fidelity does not prove retrieval or agent task success. Extend rather than replace the harness. | ME-02, ME-03, ME-45, ME-49 |
| F17 — Project knowledge can become a useful derived view | Versioned claims, targeted invalidation, safe thematic refresh and portable context are promising patterns. No additional authoritative memory store is required to test them. | ME-23, ME-33, ME-34, ME-35, ME-36, ME-37, ME-38 |
| F18 — Semantic/graph additions need a demonstrated use case | Source coverage, currentness and producer fixes precede optional API embeddings, reranking or graph infrastructure. Vendor results are research leads, not local evidence. | ME-32, ME-39, ME-40, ME-49 |
| F19 — Capacity is not diagnosed by one snapshot | Main-file size is not total SQLite footprint; WAL, indexes and backups matter. A single memory reading does not show a leak, latency problem or need to replace SQLite. | ME-15, ME-28, ME-43, ME-48 |
| F20 — Rollout and tracking are part of correctness | Public contracts, external consumers, host metadata, review dispositions, exact-head qualification and private evidence must remain synchronized. | ME-41, ME-42, ME-43, ME-44, ME-45, ME-46, ME-47, ME-50 |

### Code map for implementation

Paths are starting points, not immutable line references. Inspect the exact head
before making a change.

| Concern | Existing location |
| --- | --- |
| Lexical ranking, candidate limit, aliases and source discovery | `apps/server/src/services/search.ts` |
| Search assembly, canonical/working separation and compact response | `apps/server/src/services/memory-context.ts` |
| MCP request/response surface and serialized-result measurement | `apps/server/src/mcp/tools.ts`, `apps/server/src/mcp/safety.ts` |
| Effective state, task selection and classified attention | `apps/server/src/services/operational-dossier.ts`, `task-selection.ts`, `task-attention.ts` in the same directory |
| Packing, selection, budgets and resume | `apps/server/src/services/context-packing.ts`, `context-selection.ts`, `context-budget.ts`, `resume-response.ts`; `packages/shared/src/resume.ts` |
| Freshness and time | `apps/server/src/services/memory-freshness.ts`, `freshness-observations.ts`, `content-version.ts`, `mappers.ts` |
| FTS projection | `apps/server/drizzle/0014_checkpoint_fts.sql` |
| Delta, scope and evidence | `apps/server/src/services/context-delta.ts`, `context-journal.ts`, `task-scope.ts`, `source-membership.ts`, `run-evidence.ts` |
| Metrics | `apps/server/src/lib/telemetry.ts` |
| Evaluation | `apps/server/src/evals/ai-memory-corpus.json`, `ai-memory-heldout.json`, `ai-memory-heldout.ts`, `context-value-resume.ts` |
| Client workflow guidance | `plugins/contextkeep-workflows/`, `docs/contextkeep-mcp.md`, `docs/mcp/` |
| Review and health consumers | Companion integration repository; locate the deployed producer and map its public source privately before changing it. ContextKeep alone cannot complete these producer items. |

## 4. Measurement before optimization

### 4.1 Baseline manifest

ME-01 freezes a private observation manifest: source and runtime revisions, schema,
tool/contract versions, timezone, exact inclusive/exclusive window boundaries,
collection time, query definitions, corpus snapshot and known gaps. Store hashes or
version identifiers for reproducibility. Do not create an unnecessary full
production database copy just to count records.

Record these distinct populations:

- Projects by lifecycle, including unknown; created records by review status,
  evidence basis, type and project; source count and normalized characters.
- Task creation/progress, task handoffs, canonical handoffs and correlated workflow
  runs, with the warning that correlated runs are not every real execution.
- Source/event revisions, repeated monitoring observations and existing relation,
  delta-session and volatile/review-due coverage.
- MCP calls/outcomes, durations, result sizes and omissions over the actual
  telemetry retention. Counter increases are estimates from sampled series.
- Runtime health and resource trends; SQLite main file, WAL and derived indexes
  separately; no inferred CPU/memory bottleneck without measurements.

Use comparable durations and disclose partial weeks. Separate source imports from
event dates and record creation from real-world occurrence. Inspect production
read-only, with bounded transactions and the existing backup/storage policy.

### 4.2 Evaluation set and scoring

Extend the current RO/EN harness with 30–50 privately retained real questions and
synthetic public equivalents. Freeze expected relevant record/source/task
identities, valid answer time, allowed history, expected abstention and evidence
before tuning. Keep a held-out split that is not used to adjust aliases or ranking.

At the inspected source revision, the public corpus contains 61 cases (25 RO,
36 EN) and the held-out set 63 (26 RO, 37 EN). Held-out tags overlap: paraphrase,
current-vs-old, dependency, working-memory and abstention coverage are not additive
populations. The existing semantic-pilot threshold is 0.95; inspect its exact
metric definition before reuse. These are code/fixture properties, not observed
production quality scores. The previous audit inspected these tests but did not
run them.

Score three layers separately:

1. Retrieval: Recall@5/@10, relevant current observation, exact identifier behavior,
   project/task filter correctness and source-only coverage.
2. Presentation: protected core, provenance, omitted-content recovery, serialization
   budget and faithful distinction of current and historical information.
3. Agent outcome: answer/action correctness, unsupported claims, appropriate
   abstention, extra reads and time to useful resumption.

Measure logical structured characters, logical UTF-8 bytes, full MCP-result bytes,
actual provider tokens/cost when inference occurs, latency p50/p95 and reads per
scenario. Do not convert bytes into billed tokens by a constant factor. Existing
result-byte telemetry includes both `content.text` and `structuredContent` plus
JSON escaping, and excludes the outer JSON-RPC envelope.

Hard gates have zero tolerance on the test suite: authority/scope leaks, implicit
promotion, evidence loss, unsafe replay, task reopening and hidden omissions.
Quality targets are fixed before a comparison. Preserve the existing held-out
semantic gate; do not lower it to make a pilot pass. A proposed optimization target
is at least 50% fewer bytes for catalogue polling and short-search scenarios, with
no lost required information; establish feasibility from baseline before making
it a release commitment. A proposed p95 budget is no worse than baseline +10%
for comparable local reads, subject to a predeclared absolute latency ceiling.
These are initial targets, not measured results or universal service guarantees.

## 5. Design workstreams

### 5.1 Correct current state and time

ME-05 uses the same effective task projection as dossier/resume for task hits:
`effectiveState`, `stateSource`, current progress identity, provenance and a
resume pointer. Preserve the original record status separately. Closure, execution
completion and verification stay different fields. Post-closure checkpoints remain
labeled follow-ups.

ME-06 separates current-intent and historical queries. Currentness must influence
candidate selection as well as final ordering. Rank relevant, valid observations
using their evidence class, effective/event time and state, while keeping accepted
and proposed results visibly distinct. Neither “newest always wins” nor “accepted
always wins” is sufficient. An old accepted constraint can still be binding, while
a newer proposed deployment observation can explain current operations.

ME-07 measures candidate saturation and missed relevant items before increasing
candidate pools. The existing bounded candidate search can hide a good item before
freshness scoring. Keep saturation/pagination signals honest, protect exact IDs and
avoid unbounded scans as the default solution.
When saturation is reported, provide a usable route to more candidates: narrower
filters, a bounded expansion or pagination under the chosen contract. A record
detail read alone cannot recover a relevant hit whose identity was never returned.

ME-08 defines observed/event time, effective validity, write/import time and
verification time. Do not fabricate missing times. Reimporting an old document
must not make its contents current. Expired, future, superseded and uncertain facts
need explicit handling. Define volatility/review policy by information class and
use source changes for revalidation rather than indiscriminate auto-expiry.

ME-09 adds cross-surface consistency scenarios for MCP, HTTP, PWA and host views.
All reads stay side-effect free, including in paused/retired projects and terminal
tasks that still require attention.

### 5.2 Small search results, safe budgets and deeper evidence

ME-10 adds an additive, opt-in summary/detail contract and explicit search budget.
Design the exact schema during implementation. A short hit retains ID, type,
subject/title, short relevant snippet, provenance/status, relevant time/freshness,
effective task state when applicable, and a way to retrieve versioned detail.
Keep canonical records, working reports and source evidence distinguishable.

ME-11 reuses existing packing rules. Current state, next action, scope/authority,
active uncertainty and recovery pointers take priority over historical prose.
A small budget cannot always represent the protected core. Return a specific,
actionable error instead of truncating essential fields or retrying unchanged.
When a checkpoint body is omitted, retain its identity and recovery path.

ME-12 expands only selected hits through existing record/source readers or an
additive detail interface. Bound large evidence/reference lists, show total and
returned counts, and provide continuation. If the source changes between summary
and detail, disclose the revision mismatch or require a fresh read.

ME-13 exposes supported project/task/date/type/source filters through MCP with
documented time semantics. Reuse backend filtering where possible. Do not leak
cross-scope excerpts through ranking, counts or snippets.

### 5.3 Search sources without changing their authority

ME-14 adds a separate FTS5 index for normalized sources/excerpts. Keep record
ranking and evidence discovery explicit; do not pretend that a matching source is
an accepted fact. Start with lexical coverage. Chunk boundaries should support
precise retrieval, source identity and safe paging, not generate new canonical
records merely to index text.

ME-15 covers incremental updates, bounded backfill, resumption after failure,
versioned index format, consistency/rebuild checks, delete/redact propagation and
resource budgets. Index creation is a derived-data change, but its schema/runtime
compatibility and recovery still need verification. Avoid long write locks,
unbounded WAL growth and a second writable copy.

ME-16 defines offset and representation contracts. Existing source paging and
excerpt offsets can use different units; preserve/document compatibility rather
than silently changing them. Test Unicode code points, UTF-16 units, emoji,
combining characters, diacritics, redaction and normalized/original text mapping.
Never advertise offsets into a different representation.

ME-17 improves aliases only for measured failures. Test RO/EN paraphrases, phrase
search, exact IDs and broad terms. Track false positives and abstention. Remaining
semantic misses become evidence for ME-39.

### 5.4 Correct ingestion and reduce repetitive context

ME-18 fixes reviewer attribution from the actual source: reviewer, repository,
resource kind, pull request, reviewed head, attested base, review status and
meaningful change. A missing base remains unknown; never infer one for a reviewer
whose evidence does not supply it. Distinguish
running, completed, failure and awaiting developer disposition. Do not relabel
historical evidence as owner approval.

ME-19 preserves the current event/version identity contract. Repository, resource
kind and stable source identity plus content version can represent multiple
legitimate revisions. Numeric IDs from different resource kinds must not collide.
Retries reuse the saved payload and idempotency key. A comment URL alone, a title
or globally identical text is not an event identity. Test changed heads, edited
bodies with unchanged head/status, changed attested base with unchanged head,
exact retries, out-of-order arrivals and equal text in distinct scopes. Any
identity-format migration must preserve historical replay keys and saved payloads.

ME-20 presents a current review view keyed to repository/PR/reviewer/head and
attested base when present, with resource-kind/version provenance and
links to full historical versions and developer dispositions. An old-head review
cannot satisfy current-head qualification. Failed/missing polls must not mark a
review complete or unchanged.

ME-21 makes no-change monitoring structured. A successful, fully covered
observation may update a compact journal or bounded summary; changed facts,
incidents and unresolved blockers remain prominent. Keep last successful read,
observed interval, source watermark and coverage/error status. An empty page, a
fetch failure or missing history is not “nothing happened.” No text-only
heuristic may resolve a blocker.

ME-22 changes context selection before destructive retention. Preserve raw
evidence and audit history; make repetitive observations expandable and maintain
a final/daily summary when useful. Backfill or consolidation has dry-run reports,
explicit scope and reversible projection updates. No global deletion by phrase
or URL.

ME-23 distinguishes stable project knowledge from operational streams. Draft
decisions, architecture constraints and runbooks remain evidence-linked proposals
until the existing review flow accepts them. Do not turn every proposed report
into an approval obligation or auto-promote a synthesis.

### 5.5 Catalogue, health and trustworthy telemetry

ME-24 adds a compact catalogue projection for identity resolution and consumers
that need only a few fields. Define pagination, lifecycle filters, renames,
homonymous projects and conditional revision/ETag semantics. Identity caches need
explicit invalidation; they never establish runtime truth.
The initial consumer needs only id, name, lifecycle, revision and updatedAt.
Treat that field set as a candidate projection, with a compatible full read kept
available for consumers that require it.

ME-25 updates the external health consumer to use this contract, preserving its
authenticated application/perimeter check and a periodic fuller control read.
A minimal liveness endpoint alone does not preserve the current semantic check.
Measure call rate, returned fields, failure detection and bytes before/after.
The target is fewer serialized bytes per equivalent qualified check; call-rate
reduction is optional and must preserve detection timing. A known controlled
consumer cohort can validate this change without waiting for all ME-27 attribution.

ME-26 diagnoses error families using bounded error codes and request shape:
legacy/both vs structured resume, protected-core budget failure, result-size guard,
schema validation, workflow/scope preconditions and internal failure. Return
actionable remedies. Deterministic errors should not trigger identical retries.
Do not relax task/evidence/credential guards to improve the error chart.
In particular, distinguish context_budget_unrepresentable in legacy versus
structured output from result_too_large. A broad client category is insufficient
to infer schema validation failures or server crashes.

ME-27 adds bounded consumer classes where attribution is justified. Caller
`clientId` is untrusted metadata, not authentication. Derive any trusted identity
from the authenticated server context. Avoid private text, raw IDs, URLs and
unbounded labels; distinguish unknown clients and shared credentials.

ME-28 selects retention after measuring series cardinality and storage growth.
The analysis needs several comparable weeks; a candidate is a 35-day window,
subject to disk budget and restore policy. This is a proposal, not a configuration
change. Keep actual coverage visible and do not reconstruct exact missing events
from sampled counters.
Check duplicate scrapes during migrations: two series may represent the same
instance. Deduplicate only using justified identity, or label the aggregate
unreliable. Do not sum duplicated series as independent activity or introduce
unbounded identity labels to solve the problem.

ME-29 uses existing Prometheus metrics for a small outcome dashboard: usage,
successful resumptions, recurring errors, bytes, omissions, freshness/source
coverage and latency. Define which outcome measurements are sampled evaluations
rather than inferred from HTTP success. Alert only on actionable sustained
conditions and distinguish gaps from zero activity.

### 5.6 Use existing continuity and build derived knowledge carefully

ME-30 pilots existing `get_context_delta` for a consumer that rereads full context.
Respect canonical/working cursors, stable watermarks, paging and recovery.
Commit the local cursor only after the final page has been durably applied.
Expired/ahead cursors, interruptions and concurrent writes must never yield a
false empty delta. Measure whether delta is worthwhile for that consumer.

ME-31 updates producer/client guidance for task selection, structured resume,
task-scoped capture, explicit volatility and dated evidence. Reuse known IDs in a
session but refresh relevant state before fenced writes. Newly exposed tools may
require host connection metadata refresh; an installed capability is not proof a
consumer actually uses it.

ME-32 captures a small set of evidence-backed relations using existing primitives:
project dependencies, integration and explicitly identified runtime targets.
A dependency does not prove deployment or health. Resolve current names from
stable identities and preserve proposed/accepted distinctions.

ME-33 prototypes a derived project brief with sections for current state,
architecture, constraints, decisions, integrations, runbooks, open uncertainties
and source index. Bind sections to source versions and evidence status. Keep
operational snapshots clearly dated and stable documentation separately labeled.
Generation failure must not replace a useful brief with an empty one.

ME-34 introduces claim-level provenance where needed: claim identity, source
version/hash, precise span, generated time and revalidation state. A changed file
or source marks affected claims for review; it does not prove them false.
Unsupported claims become unknown or are withdrawn explicitly, with history.
Resolve derived support to primary evidence and detect citation cycles. Repeated
copies of one event count as one evidentiary origin, not independent confirmation.
If primary support is missing, preserve uncertainty instead of strengthening the
claim through repeated synthesis.

ME-35, ME-36, ME-37 and ME-38 are gated pilots of patterns described below. They
are alternatives or complementary small experiments, not a requirement to operate
four additional memory platforms. The existing backend stays authoritative.

### 5.7 Optional semantic and graph work

ME-39 begins only after measured misses remain following currentness, coverage,
budget and alias work. Compare improved FTS with API embeddings plus lexical/dense
fusion, then optional reranking of a small top set. Consider RRF/DBSF as candidates,
not commitments. Exact IDs, names, source version, scope and authority remain
deterministic constraints.

The index key includes record/source identity, revision, fragment and model/index
version. Propagate changes, deletions and redactions. Test provider timeout,
throttling, stale vectors and lexical fallback. Predeclare sample, latency ceiling,
API spend cap and success threshold. Do not install a vector service merely to
run a small comparison if existing infrastructure suffices.

ME-40 asks whether real dependency/temporal questions remain unanswered with
existing relations and joins. Only then compare a derived graph projection or
Graphiti-style temporal graph. Account for extraction errors, episode provenance,
validity time, retractions, synchronization, database operations and rollback.
If benefit does not justify those costs, record a decision to stop.

### 5.8 Consolidated source qualification

The batch starting at PR36 `67f86dd` delivers one candidate for temporal
shortlisting (ME-06/ME-08), task continuity budgets (ME-11) and selected
evidence expansion (ME-12). Existing record cards inherit the detail fences
under ME-10. Source/excerpt discovery remains open. The
[acceptance catalogue](VALIDATION.md#consolidated-source-batch) records the
matched synthetic comparison and the scope of the local qualification.
Representative evaluation, independent review, CI and production release
qualification remain separate gates.

## 6. Research ledger and adoption decisions

Research snapshot: 2026-11-15. Availability, dates, releases, licensing and API
contracts must be rechecked when a pilot starts. The entries describe vendor
documentation; none was installed or benchmarked in this review.

| Candidate | Primary sources and dated context | Useful pattern | Decision / items |
| --- | --- | --- | --- |
| OpenWiki / LangChain | [Building agent memory](https://www.langchain.com/blog/building-agent-memory-openwiki-graphs), 2026-10-28; [self-correcting memory](https://www.langchain.com/blog/self-correcting-memory-openwiki), 2026-08-25; [overview](https://docs.langchain.com/oss/openwiki/overview) | Source-grounded wiki, claim spans/hashes and targeted revalidation; coding-agent/MCP access | Gated one-repository pilot, private where sources are private. ME-33–ME-35. |
| Hindsight | [Releases](https://github.com/vectorize-io/hindsight/releases), including 1.2.1 on 2026-11-10; [mental models](https://hindsight.vectorize.io/developer/api/mental-models) | Curated thematic summaries, full/delta refresh, traces and watermarks | Adapt refresh pattern before adopting a service. ME-33, ME-36. |
| Mem0 Dream and temporal memory | [Dream](https://mem0.ai/blog/dream-background-memory-consolidation-for-ai-agents), 2026-08-04 / updated 2026-09-28; [time](https://mem0.ai/blog/managing-time-in-ai-memory), 2026-10-20 | Merge/supersede/synthesize with retained source pointers; event vs write time | Conservative proposed consolidation pilot. Dream plan availability must not be assumed to equal OSS functionality. ME-08, ME-37. |
| Letta Context Repositories / MemFS | [Context repositories](https://www.letta.com/blog/context-repositories/), 2026-02-12; [memory docs](https://docs.letta.com/configuration/memory); [production evaluation](https://www.letta.com/blog/evaluating-memory-in-production-agents/), 2026-07-28 | Versioned portable context, progressive disclosure, memory generation/hygiene separate from memory use | Optional derived export, no independent editable truth fork. Not presented as a launch from the last few weeks. ME-38, ME-49. |
| Graphiti | [Repository](https://github.com/getzep/graphiti), [releases](https://github.com/getzep/graphiti/releases), 0.31.2 on 2026-10-20 | Temporal relations and source episodes | Defer graph infrastructure until existing relations demonstrate an unmet question. The observed release primarily contains fixes/security work. ME-32, ME-40. |
| Qdrant hybrid retrieval | [Official hybrid-search guide](https://github.com/qdrant/landing_page/blob/master/qdrant-landing/content/documentation/search-tuning/hybrid-search.md), reviewed as 2026-08 guidance | Dense paraphrases plus lexical exact matching, fusion and bounded reranking | API-only comparative pilot if remaining failures justify it. A Qdrant deployment is not required by this plan. ME-39. |
| QMD | [Repository](https://github.com/tobi/qmd) | Local hybrid retrieval reference | Defer the default local-model pipeline. Reconsider only if API-compatible operation and measured benefit fit constraints. ME-49. |
| Augment Context Engine MCP | [Official announcement](https://www.augmentcode.com/blog/context-engine-mcp-now-live), 2026-02-06 / updated 2026-06-18 | Codebase retrieval comparison | Research candidate only; validate access, indexing boundaries, price and a relevant benchmark before any trial. Not a launch from the last few weeks. ME-49. |
| LangMem | [SDK introduction](https://www.langchain.com/blog/langmem-sdk-launch), 2025-02-18 | Semantic/episodic/procedural distinctions | Design reference, not a migration recommendation or recent launch. ME-23, ME-49. |
| DolphinBench and LongMemEval-V2 | [DolphinBench](https://mem0.ai/blog/introducing-dolphinbench-mapping-the-pareto-frontier-of-agent-memory), 2026-09-22; [LongMemEval-V2 repository](https://github.com/xiaowu0162/LongMemEval-V2) | Evaluate task usefulness, memory quality and cost together | Evaluation inspiration; verify protocol and use applicable cases without substituting vendor scores for local results. ME-02, ME-03, ME-49. |

For a pilot decision record, include: problem, baseline, hypothesis, smallest
experiment, licensing/provider/data-flow constraints, API budget, held-out
comparison, negative controls, rollback, findings and **adopt / adapt / defer /
stop** disposition. Recheck claims at the decision date. No candidate is mandatory
just because it appears in the ledger.

## 7. Delivery order and dependency gates

Use small coherent PRs. Independent documentation or diagnostic work can run in
parallel, but one authoritative tracker records status. Priorities express value
and prerequisite order, not incident severity or a promised delivery date.

| Wave | Scope and suggested units | Exit condition |
| --- | --- | --- |
| W0 — Baseline | ME-01–ME-04; initial ME-49 research dispositions; establish ME-46/ME-50 recording rules | Frozen evidence manifest, evaluation split, metric definitions, candidate readiness and explicit unknowns. |
| W1 — Correctness | ME-05–ME-09; reviewer attribution ME-18–ME-20 can proceed independently | Current-state/task cases pass; historical/provenance behavior unchanged; review versions remain distinct. |
| W2 — Retrieval efficiency and coverage | ME-10–ME-17 | Budgeted search and source-only discovery work with safe recovery, filters and rebuildable indexing. |
| W3 — Producers and context hygiene | ME-21–ME-23; complete review integration | Structured monitoring preserves gaps/blockers, current review view is correct, raw history remains accessible. |
| W4 — Consumers and observation | ME-24–ME-32, ME-41, ME-48 | Catalogue savings, actionable diagnostics, representative retention, delta pilot and evidence-backed relation capture are measured. |
| W5 — Derived knowledge | ME-33–ME-38 | Bounded brief/wiki/refresh work has a measured adopt/adapt/defer/stop disposition; any adopted view is useful, versioned and safely invalidated. No optional pilot must run merely to exit the wave. |
| W6 — Optional retrieval experiments | ME-39–ME-40; refresh ME-49 decisions | Adopt/adapt/defer/stop decision based on held-out benefit and operational cost. No forced infrastructure addition. |
| W7 — Qualification and follow-up | ME-42–ME-47, ME-50 across every applicable wave | Exact-head review/CI, compatible rollout, runtime evidence, rollback and post-release comparison are recorded. |

ME-41–ME-45 and ME-47 are **per-release gates**, not work postponed until all features exist.
Each release records which items it covers. Later consumer changes depend on a
verified compatible server contract. External producer changes must be linked to
their own repository commit and qualification.
Compatibility and follow-up apply to that release's affected contracts and metrics;
they do not require every future search/catalogue feature or the complete dashboard.
A bounded reviewer-attribution release can use provenance fixtures and an observed
sample without waiting for a retention or consumer-classification project.

Effort is deliberately not estimated from item count. Before implementation,
break large items into bounded changes, assign an actual owner and estimate from
the inspected head. W0/W1 correctness can deliver value while later pilots remain
gated. The first recommended execution batch is baseline/evaluation, effective
task state and reviewer attribution, followed by bounded search/catalogue work.

### Pilot entry and stop rules

- Enter only with a reproducible failure or a specific useful workflow, a fixed
  evaluation set and an accountable owner.
- Prefer one project/repository and one consumer first.
- Set work/API/resource budgets before running the experiment.
- Stop if hard invariants fail, provider/data handling is unsuitable, performance
  exceeds the agreed budget or held-out benefit is absent.
- A well-supported decision to stop/defer completes the experiment item. It does
  not mark an unimplemented feature delivered.
- Reopen a deferred idea only with new evidence, preserving the prior decision.

## 8. Rollout, recovery and risk

ME-41 keeps new fields/tools additive, documents defaults and errors, updates
ContextKeep Workflows and refreshes advertised host resource versions when needed.
Test old clients as well as new requests.

ME-42 orders backend, derived index, consumer and presentation changes. Allow
temporary mixed versions. Use a canary consumer and feature controls where useful;
do not make an external producer assume a field before the server can supply it.

ME-43 qualifies index backfill and schema compatibility. For persistent schema
changes, inspect the established verified recovery point and follow coordinated
backup policy. An older binary may require a matching pre-migration database,
not just a symlink rollback. Rebuildable indexes still need deletion/redaction
correctness. Keep scratch restores isolated and remove them after validation.

ME-44 follows the repository's application review and release process:
stable local candidate, both required current-head reviews, finding dispositions,
required CI, exact source/runtime identity, deployed read-only contract verification
and independent recovery evidence where applicable. A merge or a passing command
alone is not proof of production behavior.

ME-45 compares a matched post-release period to baseline, controlling for different
traffic, retention and coverage. Use a canary plus a representative period; avoid
a claim of percentage improvement from incompatible samples. Regressions require
a disposition, not silent threshold changes.

| Risk | Detection / mitigation |
| --- | --- |
| “Current” hides accepted constraints or promotes a report | Separate authority from recency; critical contradictory-evidence cases. |
| Candidate cap silently loses relevant evidence | Saturation signals, recall evaluation and bounded widening. |
| Summaries erase blockers or uncertain executions | Protected core, explicit omission recovery and closed-task/no-replay tests. |
| Source index leaks content or stale redacted fragments | Scope-before-output checks, lifecycle invalidation and adversarial synthetic fixtures. |
| No-change optimization hides a failed monitor | Coverage watermark and last-success state; failure is unknown, not unchanged. |
| Review compaction accepts an obsolete head | Versioned reviewer/PR/head identity and current-head qualification. |
| Derived briefs become a second truth store | Source/version links, proposal labels, rebuildability and constrained write-back. |
| Metric labels leak data or explode cardinality | Bounded enums, unknown bucket, retention/storage measurement. |
| Embeddings/graph improve demos but not real work | Frozen held-out comparison, provider cost and stop criteria. |
| Index/migration backfill disrupts the primary | Bounded batches, contention/WAL/resource observation and tested recovery. |
| Public plan exposes operational details | Public synthetic contracts; private evidence ledger and normal privacy hooks. |
| Tracker says done before deployment/evidence exists | Separate planning, implementation, verification and release states; evidence required. |

## 9. Working protocol and completion

The root tracker is the authoritative checklist for this programme. This document
holds rationale; VALIDATION holds acceptance scenarios. Do not maintain an
independent competing checklist in an archived tracker.

At item start: inspect current code and task memory; claim an actual owner; record
scope, dependencies and the intended acceptance cases. At each meaningful change:
update status, commit/PR reference, tests and unresolved limits. Before closure:
verify the exact applicable behavior, attach sanitized public evidence and retain
private details in ContextKeep.

For code items, “done” means required implementation, tests, review and applicable
deployment verification are complete. For experiments, “done” requires a recorded
decision and evidence, including a valid decision not to adopt. Missing external
access or an offline replica is reported accurately; it cannot silently turn
verification into a pass.

ME-46 preserves the full private audit-to-item map and concise handoffs, with
artifact paths/commits and no fabricated execution receipts. ME-47 qualifies the
existing authority, recovery and no-replay protections across all new read paths.
ME-48 provides capacity measurements before infrastructure decisions. ME-49 keeps
research decisions current. ME-50 maintains coverage and closes the programme only
when every item is done or explicitly deferred/stopped with its rationale.

**Planning completion is not implementation completion.** At creation, all
implementation work is planned or gated. The complete source audit remains private
and none of its operational observations is silently promoted to accepted truth.
