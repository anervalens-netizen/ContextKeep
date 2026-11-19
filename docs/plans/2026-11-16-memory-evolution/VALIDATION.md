# Memory evolution acceptance catalogue

Date: 2026-11-16\
Status: acceptance contracts; dated execution evidence is maintained in the tracker\
Plan: [PLAN.md](PLAN.md)\
Work tracker: [MEMORY_EVOLUTION_TRACKER.md](../../../MEMORY_EVOLUTION_TRACKER.md)

Creating or reviewing this document does not execute its scenarios. A structural
documentation check is not evidence that application behavior passes. Each V item
maps to the ME item with the same number. The tracker owns implementation status;
this catalogue defines the evidence needed to assess that item's acceptance.

## Execution status

The initial planning snapshot had all 50 cases NOT RUN. Batch 1 qualifies V-05
with synthetic task-state regression coverage and the task-state subset of V-09.
Its exact-head reviews, CI and all 12 release-gate stages passed; see
[BATCH_1.md](BATCH_1.md). Production activation and the original task-state canary
passed. A subsequent independent restore also qualified the newly produced
candidate snapshot; private operational receipts remain outside this catalogue.
The [baseline protocol](BASELINE_PROTOCOL.md) is documented. Later corpus
preparation is recorded separately below; matched candidate and agent outcome
evaluation remain open.

Batch 2 qualifies the forward-ingestion behavior in V-18/V-19 with 99 targeted
synthetic producer tests and separate controlled deployed readback. Required
reviews, dispositions, source integration and CI passed. Original delivery
payloads/history, new attribution and explicit grouped-review closure were
verified; historical recovery remains partial and the producer retains an
explicit reconciliation backlog. Scheduled polling resumed through the guarded
step. One automatic repeat completed without additional captures or dispositions
and retained the known fence; indefinite stability is not established. See
[BATCH_2.md](BATCH_2.md) for the exact scope and limitations.

The public corpus helper passes 49 synthetic guard tests: the existing 45 and
four new parameterized tests. Batch 3 independently reviews and registers the
first canonical private freeze: 40 RO/EN formulations from
20 real episodes, with six abstention cases and ten task-state cases. Its private
scorer passes 32 separate synthetic guard tests. All 40 fixed live observations
were collected once. Final independent verification of the contracts, captures,
per-case metrics and serialized sizes passes with a display-rounding note and
no substantive discrepancies; failures remain in this limited baseline. The
complete 196-file private archive was saved and independently read back
successfully. Broader synthetic counterparts, matched candidate comparisons and
agent outcomes remain open. See
[BATCH_3.md](BATCH_3.md) for scope and limits.

Source recall is not applicable to current MCP search because it exposes no
ranked source array. Exact field fidelity is separate from semantic entailment,
semantic abstention and agent success. The latter remain NOT_RUN; provider tokens
and cost remain unknown. ME-02 includes a bounded offline guard correction for
eight explicit source-backed truncation flags: two freshness-reference flags and
six packing flags on allowed read-tool responses. The four new parameterized
tests cover all eight flags for true, false, invalid types and fail-closed freeze
behavior. The single test `test_known_nested_truncation_flags_block_gold`
reproduced eight failing subtests against the base helper. This count describes
that one test, not all four new tests. Required reviews and CI passed.
The frozen private evaluator and observed results are unchanged by that correction.

The qualified helper candidate is [PR #29](https://github.com/anervalens-netizen/ContextKeep/pull/29),
head `16c24a907d46d58da98374c182c86c61b62011e2`, base
`0356372130661674062996e7cc8ae4ab515a1a13`.
[Codex](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6919711553)
reported no findings;
[DSH](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920023151)
reported no confirmed code findings and passed 232 additional assertions. Its
single low, nonblocking documentation precision note is addressed by the
named-test wording above.
[CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329947)
and [public-source checks](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329984)
passed. The [version-bound disposition](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920242721)
records the immediate wording follow-up, applied in this completion record.
Grouped review closure was read back. Application runtime is unchanged; no
deployment is required.

Batch 4 qualifies **V-24** with 55 focused tests, both current-head reviews,
required CI, all 12 release-gate stages, isolated candidate recovery and
post-activation authenticated full/compact/conditional readback. Independent
recovery of a fresh deployed-release backup also passed, including authenticated
HTTP probes, preserved schema/counts and complete isolated cleanup. **V-25 remains
PARTIAL:** 47 targeted consumer tests and the independently recomputed synthetic
comparison pass; companion review/release and deployed verification remain open.
The fixed workload uses 12,037,320 baseline and 1,158,120 candidate result bytes
(90.3789% fewer), while catalogue calls increase from 180 to 195. This is a
serialization result from simulated checks, not a natural observation period or
a CPU, network-latency, wire-byte or provider-cost measurement. See the
[catalogue contract](../../mcp/project-catalogue.md) and [Batch 4 record](BATCH_4.md).

A passing release subset does not complete the full programme catalogue. Cases
V-41–V-48 and V-50 retain their full scenario status below; release-specific
execution evidence belongs in the tracker and the corresponding batch record.
Do not infer that all their synthetic setup variants or future release duties
were executed.

### Consolidated source batch

Base: stacked PR36 `67f86dd0735b58aed98f6c72f70aaf31945e5ceb`. All fixtures
are synthetic. V-06/V-08, V-10, V-11 and V-12 remain PARTIAL. The candidate
requires independent review, CI and release qualification.

The matched search benchmark inserts 10,000 synthetic records, including
8,000 stronger lexical matches, with a fixed event clock. Each revision
runs 5 warmups and 40 measured retrieval calls on the same database, with
alternating order. The baseline fails the newest-record assertion. The
candidate passes the unchanged 150 ms search p95 limit and marks the result
saturated.

| Retrieval implementation | p50 | p95 | Known newest record |
| --- | ---: | ---: | --- |
| Stacked PR36 base | 38.71 ms | 41.34 ms | Missed |
| Consolidated candidate | 64.61 ms | 67.09 ms | Ranked first |

These measurements are for in-process retrieval on this synthetic workload.
The approximately 26 ms p95 increase is specific to the saturated fixture.
In separate runs, the saturated candidate passes at 70.05 ms p95 and the
existing 10,000-record HTTP search gate passes at 22.43 ms p95.
The catalogue fits in 195,573 UTF-8 bytes against the unchanged 200,000-byte
cap. The 131 focused tests include the original context-delta contract.
Workspace typecheck, 103 operational tests, the 49 synthetic private-corpus
guard tests and public-data checks pass. The candidate's bounded reference
fingerprints scan metadata for the selected records/sources, so page transfer
is bounded while local work scales with their linked metadata.

The full backend run passed 920 of 936 tests. Ten require a loopback
listener unavailable in the sandbox. The six subprocess failures reproduced
on the unchanged PR36 base. Shared and web suites passed 15 and 481 tests
respectively. Six of seven performance checks pass. The brief-route check
requires the same loopback listener. The dependency audit could not reach
the registry; the existing audit threshold applies to release. The worktree
history guard passes at the base revision. Git metadata is read-only in
this workspace, so the candidate is uncommitted.

## Method and evidence rules

### Freeze the comparison before tuning

Record the inspected source/runtime/schema/contract versions, fixture identity,
clock and timezone, query definitions, observation boundaries, consumer versions
and coverage gaps. Extend the existing evaluation harness. Keep private natural
questions and production observations in the private evidence ledger; only
synthetic equivalents belong in this repository. Do not copy a production store
merely to construct fixtures or count records.

Freeze expected relevant records, sources, task state, answer time, permitted
history and abstention before changing ranking or aliases. Separate tuning and
held-out cases. A failed held-out case remains in the report; changing an expected
answer requires an independently documented reason and a new corpus version.
Do not tune on the held-out set and then report it as an independent comparison.

### Measure three different outcomes

Score retrieval, presentation fidelity and agent task usefulness separately.
Report Recall@5/@10, currentness, exact matching, scope/provenance fidelity,
abstention, additional reads and time to useful resumption. Measure logical
structured characters, logical UTF-8 bytes, complete MCP-result bytes and actual
provider tokens/cost separately. The complete MCP result can contain both a text
serialization and structured data; neither representation establishes billed
tokens. Sampled counter increases are estimates, not an exact event census.

Predeclare the comparison population, repetitions, warm/cold conditions, quality
thresholds, absolute resource/latency limits and any inference spend cap. Preserve
the existing held-out semantic gate. Evaluate the proposed efficiency targets
against a feasible baseline before making them release commitments. Show actual
coverage, resets, partial windows and errors rather than converting missing data
into zeros. Successful transport, a successful command and a useful task outcome
are distinct observations.

### Apply gates to each relevant release

For every release, list its ME items and applicable V cases before rollout.
Check prerequisites, compatibility, bounded migration/rebuild behavior, exact-head
reviews, required CI, runtime identity and deployed read-only behavior where
applicable. Later waves do not postpone these gates. Public CI uses synthetic
fixtures; private operational probes retain their exact evidence privately.

Hard invariants have zero tolerance in the executed suite: authority or scope
leaks, implicit acceptance, evidence loss, unsafe replay, task reopening and
hidden omissions. Read-only behavior means no mutation of knowledge, business
progress, authorization or executor state; documented internal telemetry, cache
and pagination bookkeeping must not be mistaken for business-state changes.
Summaries must resolve support to distinct primary evidence. A summary loop or
multiple reports of one event cannot manufacture independent corroboration.

### Record results without overstating them

For each executed case, retain the case and fixture versions, source/runtime
revisions, inputs, sanitized outputs, expected/actual comparison, measurement
definitions, errors, coverage and limitations. Public references must be safe;
raw operational identifiers, payloads, measurements and credentials stay private.
Use existing task-scoped checkpoints and evidence references for continuation.

An unmet prerequisite is BLOCKED or NOT RUN, never a pass. For gated experiments,
record the entry assessment and adopt/adapt/defer/stop decision separately from
execution results. A justified defer/stop can satisfy a decision-based work item;
unexecuted behavior remains NOT RUN. Failing adoption criteria must not be
rephrased as a delivered feature. Do not run a gated pilot merely because a case
exists here.

## Acceptance cases

### V-01

**ME-01 — Freeze the baseline and private evidence manifest**\
Status: **VERIFIED — Frozen private baseline identity, coverage and populations**

Batch 3 retains exact stored populations, sampled-counter estimates, observation
boundaries and coverage limits separately. This does not establish an exact
complete historical call ledger or execute every synthetic setup below.

- **Setup:** Build synthetic projects with distinct record, source, progress, run
  and handoff populations. Include a stale description, a runtime revision mismatch
  and a sampled counter reset.
- **Action:** Produce a baseline manifest using bounded reads and explicit time
  boundaries without creating an unnecessary full-store copy.
- **Expected:** Exact counts, sampled estimates, event dates and capture dates stay
  separate. The mismatch and missing coverage remain visible.
- **Retain:** Fixture hash, query definitions, version matrix, observation window,
  population definitions and a reproducible manifest review.

### V-02

**ME-02 — Extend the real-question and synthetic evaluation sets**\
Status: **PARTIAL — private gold/split review, canonical freeze and limited live baseline independently verified; broader outcomes remain open**

Batch 3 freezes the intended 40-case private corpus before tuning. The selected
gold evidence and semantic episode separation passed independent review. All
40 fixed observations were collected once, and independent checks match their
contracts, captures, metrics and serialized sizes. Negative outcomes remain in
the baseline; final independent verification has only a display-rounding note
and no substantive discrepancies. New synthetic counterparts and agent outcome
evaluation are separate follow-ups.

- **Setup:** Prepare synthetic RO/EN questions for current/history answers,
  source-only details, closed tasks, identifiers, paraphrases, conflicts and
  unavailable information. Keep natural questions outside the public fixture.
- **Action:** Freeze target identities, temporal expectations and abstention;
  assign independent tuning and held-out splits before implementation.
- **Expected:** Retrieval, presentation and agent outcomes have different scores.
  Equivalent questions do not leak across the independence boundary unnoticed.
- **Retain:** Corpus version/hash, split rationale, expected outcomes, privacy
  review and a list of unsupported coverage claims.

### V-03

**ME-03 — Define metric semantics and predeclare quality gates**\
Status: **VERIFIED — Predeclared metric contract and independently checked scorer**

Batch 3 predeclares exact tool contracts, eligibility, planned/scorable
denominators, one sequential observation per case and client wall-clock timing.
Its private scorer passes 32 synthetic guard tests. Final independent verification
checks all frozen observations, metrics and sizes with a display-rounding note
and no substantive discrepancies. No live SLO or new
acceptance threshold is inferred from a descriptive baseline; mocked
provider-receipt and broader agent-outcome scenarios below are not claimed
complete.

- **Setup:** Use Unicode payloads with both text and structured MCP content,
  successful responses with omissions, failed tasks with successful transport and
  mocked provider usage receipts.
- **Action:** Calculate the proposed metrics and freeze quality, latency, resource
  and cost gates before comparing candidates.
- **Expected:** Characters, UTF-8 bytes, complete results and actual tokens differ
  where expected. Omissions are interpreted separately from errors or task failure.
- **Retain:** Metric formulas, denominators, sample protocol, gate decisions and
  independently checked worked examples.

### V-04

**ME-04 — Reconcile metadata and lifecycle evidence**\
Status: **NOT RUN**

- **Setup:** Create a project description naming an old runtime, a newer dated
  observation, an unknown lifecycle and a closed task with historical follow-up.
- **Action:** Generate the metadata correction queue and inspect the proposed
  correction path against current evidence and revision fences.
- **Expected:** The queue distinguishes facts from assumptions. Unknown lifecycle
  is not silently activated or retired; the closed task remains closed. Unrelated
  records are unchanged.
- **Retain:** Before/after proposals, source references, stale-revision response,
  lifecycle assessment and scoped change preview.

### V-05

**ME-05 — Expose effective task state in search**\
Status: **PASS — synthetic Batch 1 regression suite and deployed original-regression canary**

Executed coverage: blocked-to-done progress, explicit terminal precedence,
  post-closure follow-up, dossier/resume parity and unchanged business state.
  Exact source, test totals and review evidence: [BATCH_1.md](BATCH_1.md).

- **Setup:** Seed a task whose original record is blocked, followed by valid done
  progress. Add an explicit terminal task-status change and a later checkpoint.
- **Action:** Retrieve the task through search, dossier and structured resume.
- **Expected:** Effective state, state source and progress identity agree. Original
  status remains separately inspectable. Explicit terminal precedence wins; a
  later checkpoint is a follow-up, not an implicit reopening.
- **Retain:** Surface responses, projection comparisons, recovery references and
  a business-state comparison proving that reads changed no task status.

### V-06

**ME-06 — Rank current observations and historical answers correctly**\
Status: **VERIFIED — Bounded current, historic and authority behavior of the installed release**

- **Setup:** Model a synthetic service moving between runtimes, with old accepted
  observations, newer proposed evidence and an older still-binding constraint.
- **Action:** Ask equivalent current-state and historical questions using the
  frozen evaluation set and documented candidate limits.
- **Expected:** Current queries expose relevant dated evidence while preserving
  authority distinctions and the binding constraint. Historical queries recover
  prior state. Neither recency nor acceptance alone determines truth.
- **Retain:** Ranked identities, evidence/time labels, candidate diagnostics,
  baseline comparison and unresolved or conflicting answers.

- **2026-11-17 source result.** Development agent. The working-tree source
  candidate qualifies the bounded search implementation starting at
  `c4b31d7663a2f70774364a08aa01ed2cba50c447`. Forty synthetic temporal cases and
  68 targeted search/evaluation tests pass. The two FTS/LIKE saturated-observation
  reproductions fail on the original search source and pass on the candidate.
  The frozen public 63-case evaluation retains Recall@5/@10 0.8627, currentness
  0.5385 and abstention 0.6667 before/after. Zero provider calls are made. The
  existing semantic gate remains PILOT_WARRANTED. Private corpus evaluation,
  resource/recall qualification, reviews, CI and release gates remain pending.
  Candidate saturation exposes narrower-filter recovery, with at most 200
  scored candidates per authority bucket. Deployment is unverified.

- **2026-11-18 source result.** A fixture with 640 stronger lexical
  competitors recovers the known latest observation through FTS. The forced
  LIKE fallback misses it and reports candidate saturation. When the lexical
  window fills on temporal intent, FTS provides a second shortlist limited
  to 200 rows per authority bucket. Up to 200 distinct rows per bucket enter
  final scoring. The synthetic SQLite query plan uses FTS MATCH, record
  primary-key lookups and an indexed evidence count in one statement.
  SQLite examines matching postings and uses a temporary B-tree to order
  the shortlist. Broad queries and invalid or competing dates can exhaust a
  bounded window. Narrow project, type or recorded-date filters when
  saturation is reported. The matched 10,000-record benchmark in the
  consolidated source result qualifies this fixture and leaves representative recall open.

### V-07

**ME-07 — Measure candidate recall and saturation**\
Status: **NOT RUN**

- **Setup:** Place relevant records among many synthetic lexical decoys, including
  an exact identifier and a current observation near a candidate boundary.
- **Action:** Compare baseline selection with bounded widening or improved
  selection under the same queries and resource limits.
- **Expected:** Saturation and possible-more flags match actual coverage. Any
  recall benefit is measured without unbounded default scans. Exact identifiers,
  false positives and latency remain within the predeclared gates.
  Saturated results provide usable filters, bounded expansion or paging; reading
  one already returned record is not presented as recovery for unseen candidates.
- **Retain:** Candidate sets, rank traces, saturation checks, query/resource
  measurements and all remaining misses.

### V-08

**ME-08 — Define event, validity, capture and verification time**\
Status: **PARTIAL**

- **Setup:** Use a fixed clock with an old event imported later, future-effective
  evidence, an expired fact, a superseded claim and an observation lacking event
  time or volatility metadata.
- **Action:** Classify freshness and query current/history views across boundaries.
- **Expected:** Import time does not invent a newer event. Future, expired,
  superseded and unknown states remain explicit. Missing tags alone prove neither
  freshness nor staleness; verification time retains its distinct meaning.
- **Retain:** Temporal truth table, selected timestamp basis and boundary outputs.

- **2026-11-17 source result.** The same bounded source candidate as V-06 passes
  synthetic late-import, null event, effective-start fallback, review-time,
  missing-volatility, invalid/future event, expired/inverted validity, UTC offset
  and fractional-boundary checks. In-process HTTP and MCP compact/compatibility
  search retain distinct time fields and proposal provenance. `observedAt` is
  null when `sourceEventAt` is null. Capture/review dates provide no current-time
  bonus. Scope, history-toggle and no-business-write negative controls pass.
  This is a search-only policy. The wider evidence-class/revalidation and
  cross-surface gates remain open. Deployment is unverified.

- **2026-11-18 source result.** FTS shortlist selection uses approximate
  SQLite date comparisons. Existing strict parsing, validity, current-claim
  and review checks remain authoritative for ranking. Capture time still
  cannot substitute for event or effective time.

### V-09

**ME-09 — Qualify current-state parity across surfaces**\
Status: **PARTIAL — task-state subset passed; broader scenario remains open**

Executed subset: HTTP, compact/legacy MCP and PWA task-state/provenance
  behavior. Ranking, freshness, lifecycle and the remaining host/attention matrix
  are not closed by this batch. See [BATCH_1.md](BATCH_1.md).

A live read-only comparison on 19 November matched the authenticated ChatGPT
task panel and native MCP dossier for a completed task with an explicit null
next action and an active task with verified execution evidence and the same
dated next action. Proposed provenance agreed in both. Neither had an active
blocker or unresolved execution, so present-blocker and lifecycle parity stay
open.


- **Setup:** Prepare open, closed, paused and retired synthetic cases, including
  explicit null next actions, unresolved verification and post-closure follow-up.
- **Action:** Read corresponding search, HTTP, MCP, PWA and advertised host views
  from the same fixture revision.
- **Expected:** Effective state, provenance and classified attention agree.
  Terminal or lifecycle suppression does not hide genuine uncertainty. Nulls do
  not revive older instructions, and reads cause no business-state or execution
  changes.
- **Retain:** Cross-surface field comparisons, UI captures, fixture revisions and
  before/after invariant checks.

### V-10

**ME-10 — Add budgeted search summaries**\
Status: **VERIFIED — Record-card byte budget, explicit omissions and fenced detail**

- **Source evaluation:** Optional MCP cards under a JSON UTF-8
  maxResultBytes budget after redaction; impossible budgets refuse and
  legacy full results do not truncate silently. Synthetic accepted/working
  cards preserve first ranked identity, authority, date and provenance
  with explicit omissions and detail recovery. The exact 10,000-byte
  digit transition, credential replacement growth and surrogate-safe
  clipping have negative controls. Candidate saturation remains separate
  from output packing. Transport framing is not part of the byte budget.
  Selected record cards now carry the V-12 fences. Source/excerpt-kind
  discovery cards remain open.
  See [Batch 8](BATCH_8_BUDGETED_SEARCH.md).
- **Setup:** Seed long records, checkpoints, evidence lists and freshness
  references across canonical, working and source-evidence results.
- **Action:** Request summary/detail modes at several declared budgets, including
  an impossible protected-core budget and a legacy request without new options.
- **Expected:** The declared representation fits its budget or returns a specific
  error. Short results retain identity, authority, time, task state and recovery.
  Omitted material is explicit; legacy behavior remains compatible.
- **Retain:** Serialized sizes, required-field comparisons, omission paths and
  compatibility/error responses.

### V-11

**ME-11 — Protect current context and improve budget remedies**\
Status: **PARTIAL — synthetic MCP contract exercised**

- **Setup:** Create a task with a long current next action, active uncertainty,
  extensive history and a checkpoint that cannot fit every requested budget.
- **Action:** Exercise structured and legacy resume plus work-context at tight
  and sufficient budgets, including the complete-result size guard.
- **Expected:** Current scope, authority, next action and recovery survive;
  historical prose yields first. An omitted checkpoint keeps a pointer. Impossible
  cores fail clearly with the appropriate remedy, not identical automatic retries.
- **Retain:** Budget breakdowns, protected-field assertions and distinct error
  paths.

- **Source contract.** Task-scoped `get_work_context` and `resume_task`
  accept `protectCurrent: true` and default to 12,000 serialized UTF-16
  units. Protected resume emits one structured dossier. It uses the full
  active action and preserves explicit nulls, state authority, blocker and
  unresolved execution totals, and record recovery. Historical prose yields
  before the core. An undersized request returns
  `protected_context_budget_too_small` with a minimum budget. A core beyond
  the ceiling returns `protected_context_requires_detail_reads` with
  record recovery guidance. The legacy paths retain their original behavior.
  Synthetic tests cover both tools, a long blocked checkpoint, partial
  blocker/run pages and both errors.

### V-12

**ME-12 — Implement progressive, version-aware evidence reads**\
Status: **PARTIAL — synthetic MCP contract exercised**

- **Setup:** Create a short search hit backed by multiple evidence pages and
  freshness references. Change one supporting source between summary and detail.
- **Action:** Expand only the selected hit, follow all advertised continuation
  pointers and repeat after the source revision changes.
- **Expected:** Totals, returned counts and omitted content agree. Detail matches
  the advertised revision or explicitly reports change. An incomplete page never
  claims complete evidence, and unrelated results are not expanded.
- **Retain:** Page sequence, revision comparisons, continuation receipts and
  complete recovered identities.

- **Source contract.** Follow a selected card's `detailArgs` to
  `get_record` with `expectedRevision` and `expectedEvidenceVersion`.
  Follow `evidenceRecovery` for further linked evidence. Each evidence row
  identifies its source and carries a `get_source` pointer with
  `expectedVersion`. Source text and excerpts page independently through
  `textRecovery` and `excerptRecovery`. Totals, returned counts and
  next offsets describe the respective collections. Restart at offset zero
  when a revision or evidence mismatch is reported. Fingerprints use
  indexed evidence metadata and stored content hashes. Record fences also
  include project cursors and the delivered freshness reference summary;
  unrelated project writes can require a restart. Freshness samples keep
  their existing truncation signals. Exhaustive freshness-reference paging
  remains open. Synthetic tests traverse all pages and exercise scope,
  provenance and revision churn.

### V-13

**ME-13 — Expose scoped filters through MCP**\
Status: **PARTIAL — MCP project/type/recordedAt filters in source candidate**

- **Source test:** Bounded MCP search_context projectId, recordType,
  recordedFrom/recordedTo inclusive UTC recordedAt filters reuse HTTP
  selection and preserve working/canonical status. Synthetic tests include
  inclusive UTC-day boundaries (including offset timestamps), invalid/reversed
  dates, unsupported types, legacy search and whole-row nonmutation. Full taskId/sourceId,
  source excerpt and explicit event/effective/verified time filters remain
  unimplemented; correctness has not been qualified for those scopes.
  [Batch 7](BATCH_7_SCOPED_SEARCH.md) retains open gates.
- **Setup:** Use projects with similar names, separate tasks, multiple record
  types and sources whose event, validity and import dates differ.
- **Action:** Combine project/task/date/type/source filters through MCP; include
  invalid combinations, boundary timestamps and default legacy requests.
- **Expected:** Results, counts, pagination and snippets respect the selected
  scope. Each date filter uses its declared time basis and boundary convention.
  Invalid input is explicit; undocumented cross-scope fallback does not occur.
- **Retain:** Filter truth table, requests, returned identities and compatibility
  results.

### V-14

**ME-14 — Index detailed sources and excerpts with FTS**\
Status: **VERIFIED — Installed source-only discovery and version-fenced evidence expansion through the advertised host**

- **Source result:** Synthetic term discovery, separate evidence authority, cross-project exclusion, title hits, and version-bound detail navigation passed at source.

- **Setup:** Put a unique synthetic fact only in a detailed source, with no
  corresponding canonical record. Include distractors, phrase variants and
  relevant text near an excerpt boundary.
- **Action:** Query the source/excerpt retrieval path using terms and phrases;
  inspect the returned evidence and linked detail.
- **Expected:** The fact is discoverable beyond whole-question LIKE matching.
  Results carry source identity, version and evidence labels. Indexing creates no
  accepted knowledge and preserves project scope.
- **Retain:** Index/query plan, matched spans, result labels and unchanged
  authoritative-record counts.

### V-15

**ME-15 — Make index lifecycle incremental and reconstructible**\
Status: **PARTIAL — bounded source-evidence contract exercised**

- **Source result:** The initial cache is process-local, subject to source, excerpt and text budgets. Invalidation across external commits and page version mismatch are covered; the path does not write the authoritative database.

- **Setup:** Prepare a synthetic corpus and incremental inserts, edits, deletions
  and redactions. Interrupt a bounded backfill and change its index version.
- **Action:** Resume, reconcile and rebuild the index while measuring write locks,
  WAL growth and delivery behavior during index lag.
- **Expected:** Interrupted work resumes without lost updates. Deleted or redacted
  fragments cannot be served from stale index entries. Removing a derived index
  does not destroy authoritative data; compatibility and recovery gates apply.
- **Retain:** Watermarks, consistency checks, rebuild manifests and resource
  traces.

### V-16

**ME-16 — Preserve source representations, offsets and redaction**\
Status: **PARTIAL — bounded source-evidence contract exercised**

- **Source result:** Scoped tests cover redacted UTF-16 spans, supplementary code points, combining characters and a skipped malformed span. Existing get_source text paging retains its code-point contract.

- **Setup:** Use synthetic original/normalized text with diacritics, emoji,
  combining characters, credential-shaped placeholders and matches spanning page
  boundaries.
- **Action:** Retrieve source pages and excerpts in every supported representation;
  apply redaction and follow advertised offsets through boundary and end pages.
- **Expected:** Code-point paging and UTF-16 excerpt units are explicit. Each span
  resolves to the advertised representation. Redaction precedes disclosure; an
  offset mismatch is reported rather than silently selecting different text.
- **Retain:** Representation hashes, span maps, redacted outputs and boundary
  comparisons.

### V-17

**ME-17 — Improve RO/EN aliases and exact matching**\
Status: **NOT RUN**

- **Setup:** Freeze synthetic RO/EN paraphrase pairs, diacritic variants, exact
  names/identifiers, phrase queries, broad terms and questions with no supporting
  information.
- **Action:** Compare baseline aliases with the proposed vocabulary using tuning
  cases, then run the untouched held-out set.
- **Expected:** Relevant equivalence improves within declared gates. Exact
  matching and abstention do not regress, and broad overlap does not manufacture
  confidence. Remaining semantic misses are documented rather than hidden.
- **Retain:** Alias diff, per-case ranks, false positives, held-out scores and
  remaining failure classes.

### V-18

**ME-18 — Fix reviewer and review-status attribution**\
Status: **PASS — qualified synthetic suite and controlled deployed forward-ingestion readback**

Executed synthetic coverage includes distinct reviewers/resource kinds, running,
completed, failed and awaiting-disposition states, attested/unknown bases and
developer responses. Separate live reads confirmed actual reviewer, source
author, reviewed head and base provenance in new captures and current summaries.
Unattested base remained unknown; historical inline evidence with unknown status
did not publish a current checkpoint. Explicit developer disposition closed the
grouped review work without implying owner approval. Exact producer and source
comparisons remain private; see [BATCH_2.md](BATCH_2.md).

Scope limit: this verifies the new ingestion path. Historical reconciliation is
partial and the ME-20 projection remains outside this batch. Scheduled polling
resumed; one automatic repeat added no captures or dispositions and retained the
known fence. This is a bounded observation, not proof of indefinite stability.

- **Setup:** Create synthetic events from distinct reviewers and resource kinds,
  with running, completed, failed and awaiting-disposition states. Include an
  attested base, an unknown base and a developer response.
- **Action:** Pass events through the companion producer and inspect stored
  evidence, summaries and consumer views.
- **Expected:** Reviewer, resource kind, repository, pull request, head and status
  match evidence. Base is asserted only when attested; otherwise it remains
  unknown. Developer disposition is not owner approval.
- **Retain:** Input/output mappings, producer revision and linked source/status
  comparisons.

### V-19

**ME-19 — Preserve review event identity and replay safety**\
Status: **PASS — qualified synthetic identity/replay suite and controlled deployed preservation readback**

Executed synthetic coverage includes exact saved-payload retry, meaningful
edits, head/base changes, repeated-version transitions, out-of-order delivery,
numeric-ID collisions across resource kinds, separate repositories and uncertain
acknowledgements. Source quarantine is durable before cursor advance and bounds
current checkpoints while unaffected sources continue. Legacy fingerprint debt
can be superseded at a new comment URL only with the same comparison pair,
strictly newer saved source time, current semantic evidence and a confirmed
closure that remains the task's current progress; old payload/reason/proof are
retained. See [BATCH_2.md](BATCH_2.md).

Separate live comparison retained original delivery rows and review events,
confirmed eligible new captures and explicit dispositions, and preserved current
checkpoints. One automatic repeat completed without additional captures or
dispositions and retained the known fence. No new uncertain delivery or API
failure was observed. Known legacy
uncertainty and an identity ambiguity remain fenced without replay or replacement
keys. The explicit reconciliation backlog means incomplete recovery coverage;
`ok: false` and exit status `1` must not be reported as full health. A failed ACK
was not deliberately injected into production; that case is covered synthetically.

- **Setup:** Prepare exact retries, edited findings with unchanged head/status,
  changed heads/bases, out-of-order delivery and equal numeric IDs across resource
  kinds. Simulate an uncertain delivery acknowledgement.
- **Action:** Migrate and deliver versions while retaining legacy retry keys and
  payloads; reconcile uncertainty before any replacement attempt.
- **Expected:** Exact retries add no event. Resource kinds prevent ID collisions;
  legitimate revisions survive. URL/title/text cannot replace event identity.
  Older arrivals cannot overwrite current state.
- **Retain:** Event/version map, replay receipts, payload hashes and uncertainty
  reconciliation evidence.

### V-20

**ME-20 — Project current reviews by PR, reviewer and head**\
Status: **NOT RUN**

- **Setup:** Seed reviewers/resource kinds across synthetic heads, an attested
  base change with unchanged head, an unknown base, a running review and failed
  polling.
- **Action:** Read the current review projection and expand its historical
  versions and developer dispositions.
- **Expected:** Source identity preserves resource kind. Head and attested base
  determine applicability; unknown base is not invented. Old or running reviews
  cannot qualify the current comparison; missing coverage stays unknown. Authors
  and history remain recoverable.
- **Retain:** Projection rows, qualification decisions, history links and polling
  coverage.

### V-21

**ME-21 — Represent unchanged monitoring as structured observations**\
Status: **NOT RUN**

- **Setup:** Simulate fully covered unchanged polls, a material change, partial
  pages, failed requests, missing history and an unresolved blocker.
- **Action:** Produce structured observations with last-success time, covered
  interval and source watermark; inspect default context after each outcome.
- **Expected:** Only successful complete coverage permits unchanged status.
  Failure or missing data remains unknown and cannot advance success coverage.
  Changes and blockers stay visible; omitting blocker text does not resolve it.
- **Retain:** Observation sequence, coverage/watermark transitions and blocker
  state comparisons.

### V-22

**ME-22 — Reduce repetitive default context without deleting history**\
Status: **NOT RUN**

- **Setup:** Seed repeated monitoring prose, meaningful changes, equal text from
  distinct events and historical evidence needed for a later investigation.
- **Action:** Preview and apply a scoped context projection or interval summary,
  then expand history and reverse the projection update.
- **Expected:** Matched default context becomes smaller without losing required
  facts or unresolved issues. Every underlying event/version remains retrievable.
  No phrase or URL triggers bulk deletion; rollback restores the previous view.
- **Retain:** Dry-run scope, size comparison, recovered evidence and rollback
  result.

### V-23

**ME-23 — Curate stable knowledge with explicit review status**\
Status: **NOT RUN**

- **Setup:** Provide synthetic architecture decisions, operating constraints,
  transient progress and conflicting reports with explicit evidence status.
- **Action:** Draft a stable-knowledge proposal and inspect its source links,
  uncertainty and behavior through the existing review path.
- **Expected:** Stable knowledge remains separate from the operational stream.
  Synthesis is proposed until explicitly reviewed; conflicting support is exposed.
  Proposed-report volume does not create automatic approval debt, and no source
  or accepted record is silently rewritten.
- **Retain:** Proposal-to-source map, review transitions and unchanged transient
  history.

### V-24

**ME-24 — Add a compact and conditional project catalogue**\
Status: **PASS**

- **Execution:** Reviewed head `9a0e0244c48adcc8c24bc8d3122de4d83214bd00`
  passed 17 catalogue scenarios and 38 related MCP/panel/consolidation tests,
  shared/server/web typecheck, both current-head reviews, CI and all 12 release
  gates. Isolated candidate recovery and post-activation authenticated full,
  compact and conditional reads passed with coherent pages and unchanged
  database identity. A new deployed-release snapshot was independently restored;
  runtime identity, schema/counts, authenticated HTTP probes and isolated cleanup
  passed. MCP 2.23.0 retains schema 19. See [Batch 4](BATCH_4.md) for public
  review/CI links and the distinct consumer follow-up.
- **Setup:** Use more than 50 synthetic projects, shared aliases, differently
  cased names, every supported lifecycle (including planned), and a rename
  crossing a page boundary. Verify that an exact duplicate name is rejected.
- **Action:** Compare legacy full, compact, REST and panel responses. Exercise
  `ifVersion`, `expectedCatalogVersion`, page/filter changes, import/restore,
  equal-timestamp edits, credential rotation and actual SQLite read failure.
- **Expected:** Full compatibility is retained. Compact records have exactly
  five fields; unchanged responses omit `projects`. Pagination stays coherent
  or returns an explicit reset instruction. Every conditional network call
  authenticates and reads the database. Token scope and client cache identity
  remain separate from runtime and memory freshness. Redaction and the complete
  MCP result budget still apply.
- **Retain:** Exact source/test identity, field and serialized-byte comparisons,
  complete page IDs, cache/invalidation transitions, auth and DB failure results,
  reset behavior and applicable review/release evidence. Authored suite:
  [project-catalogue.test.ts](../../../apps/server/test/project-catalogue.test.ts).

### V-25

**ME-25 — Optimize the health consumer while preserving its check**\
Status: **PASS — bounded controlled consumer, not a natural-traffic outcome**

- **Execution:** The frozen **pre-fix** primary comparison passed 60/60 checks
  in both arms, 12,037,320 versus 1,158,120 serialized MCP result bytes
  (90.3789% fewer), catalogue calls 180 versus 195, and total MCP calls 240
  versus 255. Independent per-call recomputation included all periodic controls
  and matched eight frozen hashes and the pre-measurement amendment.
  The corrected later consumer passed 51 catalogue scenarios, 148 targeted
  tests, the full 902-test Python suite, current-head reviews, disposition and CI.
  [PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53)
  was merged and a guarded consumer component activated without overwriting
  unrelated owner code. The live scheduled full-control and later conditional
  unchanged read both preserved all 44 project IDs and five consumed fields;
  service and API release proof passed. The primary comparison **was not rerun**
  on the corrected module. The result is neither a natural-traffic observation
  nor evidence of post-fix production savings. See [Batch 4](BATCH_4.md).
- **Setup:** Model the authenticated semantic health check and compact candidate
  in the fixed [Batch 4 cohort](BATCH_4.md#predeclared-synthetic-comparison):
  120 synthetic projects, 512-character descriptions, 60 checks and full controls
  at 0/12/24/36/48. Record any declaration amendment before measurement. Inject
  broken authentication, application failure and unavailable database reads while
  liveness responds.
- **Action:** Compare matched polling workloads, including periodic fuller
  semantic checks and recovery from failures. Exercise missing/corrupt cache,
  bodyless responses, old-server input rejection, bounded fallback/reset,
  malformed payloads, timeouts and exceeded page/read budgets.
- **Expected:** At least 50% fewer complete serialized MCP-result bytes over
  the equivalent successful workload, with all identities and five consumed
  fields preserved. Include full-control and fallback traffic. Auth/application/DB
  failure detection and its timing remain intact; errors do not advance success
  or full-control timestamps. Call rate may stay unchanged. Liveness cannot
  replace the application/perimeter contract. Failures stay distinct from
  unchanged results; the result does not attribute all historical traffic.
- **Retain:** Server and consumer versions, fixed fixture/declaration,
  pre-measurement amendments, failure matrix, complete result-byte totals,
  initialization/catalogue/page/reset/fallback counts, observed durations,
  applicable review/release evidence and the disclosed deployed observation
  window. The synthetic result above does not establish deployed consumer health.

### V-26

**ME-26 — Separate actionable error codes and request shapes**\
Status: **NOT RUN**

- **Setup:** Trigger synthetic legacy-budget, protected-core, oversized-result,
  schema, workflow/scope, credential-guard and internal failures alongside
  successful responses with omissions.
- **Action:** Collect finite error codes and format/budget buckets, then exercise
  the suggested client remedies.
- **Expected:** Causes are distinguishable without private payload labels.
  Deterministic errors do not retry unchanged; successful omissions remain
  separate. Improving diagnostics does not weaken task, evidence, scope or
  credential protections.
- **Retain:** Error/remedy matrix, request-shape buckets, metric series and
  negative-control results.

### V-27

**ME-27 — Attribute consumers with bounded, trustworthy metadata**\
Status: **PARTIAL — one known local executor source contract**

- **Source contract:** [Companion PR #55](https://github.com/anervalens-netizen/astancu-website/pull/55)
  implements finite local-executor classification with numeric result-size
  buckets and negative controls. A shared bearer does not identify other
  consumers; caller-supplied clientId grants no authority. Broader
  authenticated attribution, retention and prospective matching remain
  unqualified. Runtime evidence belongs in private ContextKeep memory.
  See [Batch 6](BATCH_6.md).
- **Setup:** Use synthetic authenticated consumers, shared credentials, unknown
  callers and spoofed clientId values with many distinct declared strings.
- **Action:** Observe attribution and metrics while checking authorization and
  label cardinality under the proposed metadata contract.
- **Expected:** Trusted attribution comes only from authenticated server context.
  Declared clientId grants no authority. Unknown/shared identities remain
  qualified; labels contain no raw IDs, queries or URLs and remain bounded.
- **Retain:** Attribution-strength matrix, spoofing results, cardinality counts and
  prospective consumer-identification evidence.

### V-28

**ME-28 — Size telemetry retention and disclose coverage**\
Status: **NOT RUN**

- **Setup:** Generate synthetic activity with resets, missing scrapes, a migration
  gap and duplicate scrape series for the same underlying instance.
- **Action:** Estimate retention/cardinality/storage cost, choose a window under
  the established storage policy and inspect dashboard coverage and rollback.
- **Expected:** Retention fits capacity. Duplicate series are justifiably
  deduplicated or the aggregate is labeled unreliable, without raw-ID labels.
  Missing events are not invented; gaps and resets stay visible. Rollback
  preserves recovery behavior.
- **Retain:** Sizing assumptions, coverage map, retention decision and rollback
  procedure/result.

### V-29

**ME-29 — Build an outcome-oriented usage readout**\
Status: **NOT RUN**

- **Setup:** Combine synthetic call/error/size/latency series with separately
  scored retrieval and resumption outcomes, including successful transport with
  an unsuccessful task and missing scrapes.
- **Action:** Build the proposed readout and exercise sustained actionable
  conditions, temporary spikes and data gaps.
- **Expected:** Windows, denominators, estimates and coverage are explicit.
  Sampled quality is not inferred from HTTP success. Bytes are not billed tokens;
  omissions and alerts are interpreted in context.
- **Retain:** Dashboard captures, calculation cross-checks, alert dispositions and
  outcome-source provenance.

### V-30

**ME-30 — Pilot existing delta consumption safely**\
Status: **NOT RUN**

- **Setup:** Select a synthetic consumer that repeatedly reads full context.
  Create canonical/working changes, concurrent writes, interrupted pages and
  expired or ahead cursors.
- **Action:** Apply delta pages to staged local state and commit cursors only
  after complete durable application; compare with a fresh full read.
- **Expected:** No event is lost across interruption or the stable watermark.
  Recovery is explicit, never a false empty delta. Authority scopes stay separate
  and any efficiency benefit is measured.
- **Retain:** Cursor/page journal, reconciled snapshots and matched read/byte
  counts.

### V-31

**ME-31 — Improve task capture and client workflow discipline**\
Status: **NOT RUN**

- **Setup:** Prepare representative synthetic clients with known project IDs,
  existing tasks, an explicit project note, stale revisions and outdated host
  capability metadata.
- **Action:** Follow revised guidance for selection, structured resume, dated
  task-scoped capture and metadata refresh; inject scope/idempotency mistakes.
- **Expected:** Clients reuse identities without caching runtime truth, refresh
  state before fenced writes and preserve stable retry keys. Project notes remain
  explicit; errors provide actionable recovery without task duplication.
- **Retain:** Client traces, guidance/version mapping, capture provenance and
  error-recovery outcomes.

### V-32

**ME-32 — Use evidence-backed relations before a graph stack**\
Status: **NOT RUN**

- **Setup:** Seed a small synthetic dependency/integration topology with stable
  project and runtime-target identities, proposed relations and supporting
  evidence. Include a rename and a merely similar name.
- **Action:** Answer predefined relation questions using existing primitives and
  inspect the same links after renaming.
- **Expected:** Stable identities preserve links; lexical similarity and guessed
  targets do not create authoritative relations. Evidence status remains visible.
  A dependency alone proves no deployment, health or lifecycle state.
- **Retain:** Question answers, relation/evidence map and rename/negative-control
  results.

### V-33

**ME-33 — Prototype a source-versioned project brief**\
Status: **NOT RUN**

- **Setup:** Provide synthetic current observations, architecture, constraints,
  decisions, integrations, runbooks and unresolved questions with versioned
  sources. Retain a prior valid brief.
- **Action:** Generate a derived brief, change a supporting source and simulate
  generation or fetch failure.
- **Expected:** Sections retain source versions and review status; operational
  snapshots are dated separately from stable knowledge. Drift is visible and
  failed generation preserves previous useful content with appropriate labels.
- **Retain:** Section/source map, evaluation answers, version transitions and
  failure-preservation evidence.

### V-34

**ME-34 — Track claim provenance and targeted invalidation**\
Status: **NOT RUN**

- **Setup:** Create derived claims with precise primary-source spans, hashes,
  versions and generation times. Share one source between claims and include
  unaffected claims plus an indirect summary reference.
- **Action:** Change or retract support and follow targeted revalidation to
  distinct primary evidence.
- **Expected:** Only affected claims require review or become unknown; source
  change alone does not prove falsehood. Unaffected claims and history survive.
  Indirect references cannot conceal missing primary support.
- **Retain:** Claim/support graph, invalidation decisions, span checks and
  revalidation outcomes.

### V-35

**ME-35 — Run a bounded OpenWiki-style repository pilot**\
Status: **NOT RUN**

- **Setup:** Define one synthetic repository, architecture/runbook questions and
  a qualified entry record covering access, licensing, privacy and cost limits.
- **Action:** If entry criteria are met, compare source-grounded wiki navigation
  against current retrieval and change a supporting source; otherwise record
  defer without executing the pilot.
- **Expected:** Usefulness, drift and cost meet predeclared gates or lead to an
  explicit stop/adapt decision. The wiki never becomes authoritative memory.
- **Retain:** Entry assessment, comparison cases, source links, costs and
  adopt/adapt/defer/stop disposition.

### V-36

**ME-36 — Test thematic summaries with atomic refresh watermarks**\
Status: **NOT RUN**

- **Setup:** Use versioned thematic sources, concurrent changes and a summary
  loop A-to-B-to-A. Represent one primary event in three reports.
- **Action:** If qualified, exercise full/delta/no-change refresh and failures
  between content and watermark updates; resolve support to primary evidence.
- **Expected:** Partial failure preserves previous content and watermark.
  No-change avoids needless inference. Loops and repeated reports add no
  independent corroboration; insufficient support and original status remain
  explicit.
- **Retain:** Refresh traces, atomicity checks, provenance graph, provider-call
  accounting and pilot disposition.

### V-37

**ME-37 — Test conservative consolidation proposals**\
Status: **NOT RUN**

- **Setup:** Include equal text across scopes, distinct revised events, one event
  copied into three reports and circular summary references. Check applicable
  feature/licensing assumptions before the pilot.
- **Action:** If qualified, propose merge/supersede/synthesis and trace every claim
  to distinct primary support through the existing review path.
- **Expected:** Distinct events survive; duplicated support or loops cannot raise
  confidence. Insufficient support is explicit or abstained. Review status is
  preserved and acceptance remains authorized and explicit.
- **Retain:** Proposal map, rejected consolidations, evidence counts and pilot
  decision.

### V-38

**ME-38 — Test portable derived context for coding agents**\
Status: **NOT RUN**

- **Setup:** Define a synthetic versioned context export with a small index,
  progressive detail, a stale source revision and an attempted local edit.
- **Action:** If qualified, compare agent use with current retrieval, reconstruct
  the export and submit any write-back through ContextKeep guards.
- **Expected:** Freshness, privacy and schema are explicit. Local edits cannot
  bypass scope, revision or review. The export remains rebuildable and is never
  labeled a disaster-recovery copy or independent truth store.
- **Retain:** Export manifest, agent comparison, guard results and pilot
  disposition.

### V-39

**ME-39 — Compare API embeddings, fusion and optional reranking**\
Status: **NOT RUN**

- **Setup:** Freeze remaining lexical misses after prerequisite fixes and declare
  API, latency and cost ceilings. Use a versioned derived index and negative
  controls for scope, exact IDs and abstention.
- **Action:** If qualified, compare lexical retrieval, fusion and optional bounded
  reranking; inject throttling, timeout, stale vectors, deletion and redaction.
- **Expected:** Held-out benefit justifies cost without authority regressions.
  Lifecycle filtering and lexical fallback remain correct; otherwise stop. No
  local-model dependency is introduced.
- **Retain:** Index/model versions, per-case results, provider receipts and
  adoption decision.

### V-40

**ME-40 — Decide whether a temporal graph is justified**\
Status: **NOT RUN**

- **Setup:** Define synthetic dependency/time questions and their answers using
  existing relations/joins. Identify any material unresolved question before
  specifying a derived graph and operational budget.
- **Action:** If entry is justified, compare the smallest graph experiment,
  including validity changes, extraction errors, retractions and rollback.
- **Expected:** Measured improvement outweighs synchronization/database costs or
  graph work is deferred. Provenance and temporal uncertainty remain explicit;
  graph removal leaves authoritative memory intact.
- **Retain:** Baseline answers, entry decision, temporal cases, operating costs and
  adopt/adapt/defer/stop record.

### V-41

**ME-41 — Maintain client and host compatibility**\
Status: **VERIFIED — Legacy and additive MCP reads, including live host discovery and detail expansion**

- **Setup:** Prepare old and updated synthetic MCP/HTTP clients, cached host
  resource metadata and requests that omit all newly added fields.
- **Action:** For each affected release, exercise old defaults and new
  capabilities, update bundled UI advertisement where required and perform the
  documented metadata refresh; do not wait for unrelated features.
- **Expected:** Legacy behavior remains documented and usable. New clients
  discover the intended contract without silent budget, resource-URI or
  representation changes. Compatibility does not merge canonical and working
  material or hide errors.
- **Retain:** Contract/version matrix, client traces, host discovery evidence and
  compatibility dispositions.

### V-42

**ME-42 — Plan and qualify each staged rollout**\
Status: **VERIFIED — Staged rollout and rollback gates exercised on the installed release**

- **Setup:** Select a synthetic release spanning server, derived index, companion
  consumer and presentation changes, with mixed versions and a failing canary.
- **Action:** Review and rehearse the deployment order, feature controls, rollback
  and external-repository dependencies for the selected ME items.
- **Expected:** Consumers never require unavailable fields. Canary failure has an
  explicit stop/rollback decision. Source implementation, publication and
  runtime-verified status remain different observations; applicable gates are not
  postponed to programme end.
- **Retain:** Release manifest, version sequence, canary evidence and rollback
  decision.

### V-43

**ME-43 — Verify migration, index rebuild and recovery**\
Status: **VERIFIED — Isolated rollback, recovered database and scheduled off-host copy**

- **Setup:** Use isolated synthetic data with a verified recovery point,
  compatible runtime/database pairs, limited storage reserve and interrupted
  schema/index work.
- **Action:** Rehearse bounded backfill, restart and rollback under the established
  single-writer policy; verify deletion/redaction and remove isolated scratch
  restores afterwards.
- **Expected:** Recovery preserves authoritative data and compatible binaries.
  An old binary is not paired blindly with a new schema. Code-only changes do
  not create unnecessary production copies.
- **Retain:** Recovery manifest, integrity checks, resource limits and cleanup
  confirmation.

### V-44

**ME-44 — Complete exact-head reviews and release qualification**\
Status: **NOT RUN**

- **Setup:** Model a stable candidate with required Codex Connector and DSH
  reviews, findings, CI and a later head change that invalidates earlier evidence.
- **Action:** Check review reuse/dispositions against the delivered head, then
  qualify matching source/runtime identity and deployed read-only contracts.
- **Expected:** Required review closure and CI are tied to the applicable revision.
  A merge, old-head review or successful command alone proves neither deployment
  nor verified behavior. Operational proof remains private.
- **Retain:** Review/head matrix, dispositions, CI and runtime qualification
  references.

### V-45

**ME-45 — Measure post-release outcomes against matched baseline**\
Status: **PARTIAL — exploratory readout, prospective matched evaluation NOT RUN**

- **Execution:** A bounded retrospective comparison examined two equal-duration
  natural windows using existing Prometheus per-tool byte/call/duration series,
  reset and scrape checks, alongside separately reconstructed owner-health
  outcomes. A limited paired authenticated live catalogue read separately
  compared complete, compact and conditional responses for equal field/ID
  content. The former does not isolate client type or match dayparts; the
  latter is additional observer traffic and cannot be mixed into the natural
  denominator. Raw operational results and source/retention boundaries
  remain private. Neither is a prospectively matched causal benchmark nor
  a proof of production provider-cost or total CPU savings. See [Batch 5](BATCH_5.md).
- **Setup:** Define matched synthetic baseline, canary and post-release workloads,
  plus an intentionally incompatible period with different traffic and coverage.
- **Action:** For each affected release, compare quality, errors, reads, bytes,
  latency and resources using frozen denominators. Retain failures; use a bounded
  controlled readout without waiting for the full dashboard.
- **Expected:** Comparable populations support quantified conclusions; incompatible
  periods are qualified or excluded transparently. Regressions receive explicit
  dispositions. Thresholds do not shift after results, and vendor scores do not
  substitute for local measurements.
- **Retain:** Comparison protocol, per-case/window results, exclusions and
  regression decisions.

### V-46

**ME-46 — Keep the private evidence ledger and handoffs complete**\
Status: **NOT RUN**

- **Setup:** Use a synthetic audit with findings spanning implementation,
  diagnosis, conditional pilots and unresolved external verification.
- **Action:** Map each finding to tracker items and exact private evidence/version
  references; prepare a concise task-scoped handoff and sanitized public links.
- **Expected:** No finding disappears or becomes accepted truth through the
  summary. Handoff identifies current state, artifacts and limits. Planning
  completion remains separate from implementation and execution verification.
- **Retain:** Coverage crosswalk, artifact/revision references, handoff readback
  and public-privacy review.

### V-47

**ME-47 — Regress authority, scope, uncertainty and no-replay invariants**\
Status: **VERIFIED — Authority, scope, uncertainty and no-replay controls of the installed release**

- **Setup:** Include synthetic malicious source instructions, cross-project
  snippets, stale fences, truncated evidence, uncertain runs and closed tasks
  across each changed read or derived-context path.
- **Action:** Execute applicable negative controls and inspect attempted business
  mutations and executor effects independently of response text.
- **Expected:** Sources grant no authority; reads do not promote reports, resolve
  blockers or reopen tasks. Missing history never justifies replay. Scope and
  uncertainty remain explicit, including in summaries and caches.
- **Retain:** Negative-control matrix, state/effect checks and every failing gate.

### V-48

**ME-48 — Measure capacity before infrastructure changes**\
Status: **PARTIAL — read-only snapshot and limited historical range**

- **Source contract:** [PR #31](https://github.com/anervalens-netizen/ContextKeep/pull/31)
  supplies a bounded read-only SQLite main/WAL/index/volume observer with
  shared restore exclusion, explicit partial file-only classification and
  negative controls. This alone does not establish longitudinal database
  growth, lock contention, write/backfill latency, retention effects or
  complete SQLite integrity. Continue the [Batch 5](BATCH_5.md) evaluation
  method and [Batch 6](BATCH_6.md) acceptance gates. Operational samples
  and backup receipts are stored privately; V-48 stays PARTIAL.
- **Setup:** Prepare realistic bounded synthetic read/write/backfill workloads
  with separate main-file, WAL, index and retention storage, including transient
  memory peaks and concurrent readers.
- **Action:** Measure trends, query latency, locks, service resources and storage
  reserve across steady state and rebuild/recovery phases.
- **Expected:** The report distinguishes temporary peaks from persistent growth
  or bottlenecks. Capacity decisions use measured headroom and established policy;
  one snapshot cannot justify replacing SQLite or hardware.
- **Retain:** Workload definitions, time series, footprint accounting and capacity
  decision.

### V-49

**ME-49 — Maintain research and pilot decision records**\
Status: **NOT RUN**

- **Setup:** Inventory every candidate in the research ledger with a named use
  case and a synthetic uncertainty about release date, feature availability,
  license, API support, cost or data flow.
- **Action:** Recheck primary sources before each pilot gate and record an
  adopt/adapt/defer/stop decision, including alternatives needing no new service.
- **Expected:** Current evidence resolves or explicitly retains each uncertainty.
  Vendor claims stay separate from local results; unavailable features and
  unsuitable local-model requirements do not become assumed capabilities.
- **Retain:** Dated source ledger, gate assessments and complete candidate
  dispositions.

### V-50

**ME-50 — Maintain tracker coverage and programme closure**\
Status: **NOT RUN**

- **Setup:** Create a synthetic tracker review containing a missing validation
  link, an invalid dependency, an unassigned started item and a premature done
  claim alongside justified deferred experiments.
- **Action:** Check all ME/V mappings, dependencies, ownership, status evidence,
  handoffs and closure decisions against the authoritative tracker.
- **Expected:** Defects block closure until corrected or explicitly resolved.
  Deferred/stopped work retains rationale; unexecuted validation is not passed.
  Archived trackers remain historical and unfinished work is handed off.
- **Retain:** Coverage/dependency report, corrected references, closure decisions
  and remaining-work handoff.
