# Memory evolution tracker

Date opened: 2026-11-16\
Programme: memory, current-state retrieval, source indexing and usage efficiency\
Plan: [PLAN.md](docs/plans/2026-11-16-memory-evolution/PLAN.md)\
Acceptance cases: [VALIDATION.md](docs/plans/2026-11-16-memory-evolution/VALIDATION.md)

## Current state

**Batch 1 is delivered: effective task state in search, provenance-aware
presentation and a reproducible evaluation protocol. The deployed task-state
canary and candidate-produced snapshot recovery are verified.**

Initial inventory: **50 items — 44 PLANNED, 6 GATED, 0 IN_PROGRESS,
0 IMPLEMENTED, 0 VERIFIED, 0 DONE.** This line is a dated creation snapshot;
the item rows and later dated updates are authoritative as work proceeds.

Current inventory after Batch 2 starts: **50 items — 28 PLANNED,
6 GATED, 15 IN_PROGRESS, 0 IMPLEMENTED, 0 VERIFIED, 1 DONE.**

The complete private audit and operational evidence map remain in the ContextKeep
project. This public tracker contains technical scope and synthetic acceptance
contracts. It is not a production status report.

### Start here

1. Start ME-01 / ME-02 / ME-03 and maintain ME-46 / ME-50.
2. Take effective task state (ME-05) and reviewer attribution (ME-18 / ME-19)
   as the first bounded correctness changes once their prerequisites exist.
3. Deliver search budgets/currentness and compact catalogue work in independently
   qualified batches. Use the plan's waves, not item number alone, for sequencing.
4. Keep ME-35–ME-40 gated until their named problems, baselines and budgets justify
   an experiment. A justified defer/stop decision is a valid experiment outcome.

## Batch 1 — 2026-11-16

Implementation notes and qualification scope: [BATCH_1.md](docs/plans/2026-11-16-memory-evolution/BATCH_1.md).

Implementation owner: development agent; evaluation and operational verification
are reviewed independently. Private task, baseline and execution receipts remain
in ContextKeep. No programme-wide completion is claimed.

- ME-01 / ME-02 / ME-03: [BASELINE_PROTOCOL.md](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md)
  records existing metric semantics, immutable held-out identity, private corpus
  design and first-release gates. The full private 30–50-question corpus and
  matched outcome evaluation remain pending.
- ME-05: the blocked-record / completed-progress regression passes with a shared
  task projection, additive HTTP/MCP fields and UI provenance. Required reviews,
  CI and the full release gate passed for the merged source. Deployed MCP
  capability and task-state canary readbacks passed. The broader ME-02 outcome
  remains open.
- ME-09: this batch covers task-state parity only. Ranking, freshness and the
  remaining cross-surface scenarios retain their original dependencies.
- ME-04: operator-confirmed topology metadata was corrected privately. The wider
  lifecycle audit remains open.
- ME-41 / ME-42 / ME-43 / ME-44 / ME-47: the release-specific compatibility,
  negative controls, exact-head reviews and full release gate passed. Isolated
  recovery qualified the previous snapshot and candidate on one restored clone.
  Primary activation, deployed readback and independent recovery of a newly
  produced candidate snapshot also passed. The two recovery observations are
  recorded separately.
  Private operational receipts remain outside this repository.
- ME-46 / ME-48 / ME-50: the private ledger, capacity observations and tracker
  are being maintained. Rolling duties remain open for later batches.

## Batch 2 — 2026-11-16

Scope and continuation gates: [BATCH_2.md](docs/plans/2026-11-16-memory-evolution/BATCH_2.md).

- ME-18 / ME-19: the development agent owns a bounded companion-producer change
  for reviewer/status attribution and versioned review delivery. Synthetic
  regressions cover meaningful edits, metadata changes, exact retry, resource
  identity and event ordering. Scope and local verification are recorded in the
  batch note. Official exact-head reviews, CI, source
  integration and deployed producer readback remain pending.
- ME-01 / ME-02 / ME-03: a strict offline corpus-validation helper is implemented
  against the existing baseline protocol, with 32 synthetic guard tests. This
  does not create or validate the real private question set. Evidence access and independent
  ground-truth review are required before freezing that corpus.
- ME-46 / ME-50: release status stays open. Runtime verification and private
  memory synchronization remain explicit gates; no production change is claimed.

The opening creation inventory is historical. Current item rows own status.

## Status and ownership rules

- **PLANNED:** defined, not claimed or implemented.
- **GATED:** conditional experiment; entry prerequisites and a decision are required.
- **IN_PROGRESS:** an actual owner has claimed the bounded scope.
- **BLOCKED:** name the concrete unmet dependency and the next resolution step.
- **IMPLEMENTED:** code exists; verification/review/deployment may still be pending.
- **VERIFIED:** specified behavior and required checks passed; record release status.
- **DONE:** all applicable implementation, review, rollout and evidence duties met;
  for an experiment, a documented adopt/adapt/defer/stop outcome is sufficient.
- **DEFERRED / STOPPED:** retain rationale, owner and evidence/reconsideration trigger.

Owner values below are accountable **roles**, not assignments to named people.
When starting an item, add the actual assignee, ContextKeep task reference privately,
and public PR/commit references as appropriate. Dependencies are prerequisites to
the item outcome; per-release gates ME-41–ME-45 and ME-47 apply whenever relevant
and are not postponed to the end of the whole programme.

Priority: P0 correctness/baseline/release protection; P1 high-value product or
efficiency work; P2 derived knowledge/conditional improvement; P3 research justified
only by an unanswered use case. These are priorities, not incident severities.

## Item index

| ID | Item | Status | Priority | Wave | Owner role | Prerequisites |
| --- | --- | --- | --- | --- | --- | --- |
| [ME-01](#me-01) | Freeze the baseline and private evidence manifest | IN_PROGRESS | P0 | W0 | Evaluation | — |
| [ME-02](#me-02) | Extend the real-question and synthetic evaluation sets | IN_PROGRESS | P0 | W0 | Evaluation | ME-01 |
| [ME-03](#me-03) | Define metric semantics and predeclare quality gates | IN_PROGRESS | P0 | W0 | Evaluation | ME-01, ME-02 |
| [ME-04](#me-04) | Reconcile metadata and lifecycle evidence | IN_PROGRESS | P1 | W0 | Operations | ME-01 |
| [ME-05](#me-05) | Expose effective task state in search | DONE | P0 | W1 | Backend | ME-02 |
| [ME-06](#me-06) | Rank current observations and historical answers correctly | PLANNED | P0 | W1 | Retrieval | ME-02, ME-03, ME-05, ME-08 |
| [ME-07](#me-07) | Measure candidate recall and saturation | PLANNED | P1 | W1 | Retrieval | ME-02, ME-03 |
| [ME-08](#me-08) | Define event, validity, capture and verification time | PLANNED | P0 | W1 | Backend | ME-01, ME-02 |
| [ME-09](#me-09) | Qualify current-state parity across surfaces | IN_PROGRESS | P0 | W1 | Backend | ME-05, ME-06 |
| [ME-10](#me-10) | Add budgeted search summaries | PLANNED | P0 | W2 | Retrieval | ME-02, ME-03, ME-05 |
| [ME-11](#me-11) | Protect current context and improve budget remedies | PLANNED | P0 | W2 | Backend | ME-02, ME-03, ME-05 |
| [ME-12](#me-12) | Implement progressive, version-aware evidence reads | PLANNED | P1 | W2 | Retrieval | ME-10, ME-11 |
| [ME-13](#me-13) | Expose scoped filters through MCP | PLANNED | P1 | W2 | Backend | ME-02 |
| [ME-14](#me-14) | Index detailed sources and excerpts with FTS | PLANNED | P1 | W2 | Retrieval | ME-02, ME-13 |
| [ME-15](#me-15) | Make index lifecycle incremental and reconstructible | PLANNED | P1 | W2 | Backend | ME-14 |
| [ME-16](#me-16) | Preserve source representations, offsets and redaction | PLANNED | P0 | W2 | Backend | ME-12, ME-14 |
| [ME-17](#me-17) | Improve RO/EN aliases and exact matching | PLANNED | P1 | W2 | Retrieval | ME-02, ME-03, ME-07 |
| [ME-18](#me-18) | Fix reviewer and review-status attribution | IN_PROGRESS | P0 | W1 | Integration | ME-01 |
| [ME-19](#me-19) | Preserve review event identity and replay safety | IN_PROGRESS | P0 | W1 | Integration | ME-18 |
| [ME-20](#me-20) | Project current reviews by PR, reviewer and head | PLANNED | P1 | W1 | Integration | ME-18, ME-19 |
| [ME-21](#me-21) | Represent unchanged monitoring as structured observations | PLANNED | P1 | W3 | Integration | ME-01 |
| [ME-22](#me-22) | Reduce repetitive default context without deleting history | PLANNED | P1 | W3 | Backend | ME-20, ME-21 |
| [ME-23](#me-23) | Curate stable knowledge with explicit review status | PLANNED | P1 | W3 | Knowledge | ME-04, ME-08, ME-22 |
| [ME-24](#me-24) | Add a compact and conditional project catalogue | PLANNED | P1 | W4 | Backend | ME-03 |
| [ME-25](#me-25) | Optimize the health consumer while preserving its check | PLANNED | P1 | W4 | Integration | ME-03, ME-24 |
| [ME-26](#me-26) | Separate actionable error codes and request shapes | PLANNED | P0 | W4 | Backend | ME-01, ME-03 |
| [ME-27](#me-27) | Attribute consumers with bounded, trustworthy metadata | PLANNED | P1 | W4 | Operations | ME-03 |
| [ME-28](#me-28) | Size telemetry retention and disclose coverage | PLANNED | P1 | W4 | Operations | ME-01, ME-27, ME-48 |
| [ME-29](#me-29) | Build an outcome-oriented usage readout | PLANNED | P1 | W4 | Evaluation | ME-03, ME-26, ME-27, ME-28 |
| [ME-30](#me-30) | Pilot existing delta consumption safely | PLANNED | P1 | W4 | Integration | ME-03, ME-31 |
| [ME-31](#me-31) | Improve task capture and client workflow discipline | PLANNED | P1 | W4 | Integration | ME-04, ME-11, ME-26 |
| [ME-32](#me-32) | Use evidence-backed relations before a graph stack | PLANNED | P2 | W4 | Knowledge | ME-04, ME-23 |
| [ME-33](#me-33) | Prototype a source-versioned project brief | PLANNED | P2 | W5 | Knowledge | ME-12, ME-23, ME-30 |
| [ME-34](#me-34) | Track claim provenance and targeted invalidation | PLANNED | P2 | W5 | Knowledge | ME-16, ME-33 |
| [ME-35](#me-35) | Run a bounded OpenWiki-style repository pilot | GATED | P2 | W5 | Knowledge | ME-03, ME-33, ME-34, ME-49 |
| [ME-36](#me-36) | Test thematic summaries with atomic refresh watermarks | GATED | P2 | W5 | Knowledge | ME-03, ME-30, ME-33, ME-49 |
| [ME-37](#me-37) | Test conservative consolidation proposals | GATED | P2 | W5 | Knowledge | ME-03, ME-19, ME-22, ME-23, ME-34, ME-49 |
| [ME-38](#me-38) | Test portable derived context for coding agents | GATED | P2 | W5 | Knowledge | ME-03, ME-23, ME-33, ME-49 |
| [ME-39](#me-39) | Compare API embeddings, fusion and optional reranking | GATED | P2 | W6 | Retrieval | ME-03, ME-06, ME-14, ME-15, ME-17, ME-49 |
| [ME-40](#me-40) | Decide whether a temporal graph is justified | GATED | P3 | W6 | Knowledge | ME-03, ME-32, ME-49 |
| [ME-41](#me-41) | Maintain client and host compatibility | IN_PROGRESS | P1 | W7 | Integration | ME-03 |
| [ME-42](#me-42) | Plan and qualify each staged rollout | IN_PROGRESS | P0 | W7 | Maintainer | ME-03 |
| [ME-43](#me-43) | Verify migration, index rebuild and recovery | IN_PROGRESS | P0 | W7 | Operations | ME-01, ME-48 |
| [ME-44](#me-44) | Complete exact-head reviews and release qualification | IN_PROGRESS | P0 | W7 | Maintainer | ME-42 |
| [ME-45](#me-45) | Measure post-release outcomes against matched baseline | PLANNED | P1 | W7 | Evaluation | ME-03, ME-44 |
| [ME-46](#me-46) | Keep the private evidence ledger and handoffs complete | IN_PROGRESS | P0 | W7 | Maintainer | ME-01 |
| [ME-47](#me-47) | Regress authority, scope, uncertainty and no-replay invariants | IN_PROGRESS | P0 | W7 | Backend | ME-03 |
| [ME-48](#me-48) | Measure capacity before infrastructure changes | IN_PROGRESS | P1 | W4 | Operations | ME-01 |
| [ME-49](#me-49) | Maintain research and pilot decision records | PLANNED | P2 | W0 | Evaluation | ME-02, ME-03 |
| [ME-50](#me-50) | Maintain tracker coverage and programme closure | IN_PROGRESS | P0 | W7 | Maintainer | — |

## Detailed work and acceptance

### ME-01

**Freeze the baseline and private evidence manifest**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: none · Validation: [V-01](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-01)

- [ ] Scope: Capture source/runtime/schema versions, exact observation windows and timezones, corpus identity, read-only query definitions and coverage gaps. Keep record/source/progress/run/handoff/relation/delta/volatility populations separate.
- [ ] Acceptance: Reproducible private manifest exists; sampled counters and exact stored counts are labeled correctly; partial periods and runtime/description disagreement are recorded.
- [ ] Evidence: Partial: [baseline protocol](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md)
  and exact candidate/review identities are recorded. The complete frozen private
  baseline manifest and matched observation windows remain open. The
  [corpus preflight](scripts/evaluation/README.md) validates evidence and freeze
  structure; it cannot establish semantic truth by itself.

### ME-02

**Extend the real-question and synthetic evaluation sets**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: ME-01 · Validation: [V-02](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-02)

- [ ] Scope: Freeze 30–50 private real questions with expected record/source/task identities and time semantics. Extend existing RO/EN fixtures with synthetic equivalents; maintain a tuning/held-out split.
- [ ] Acceptance: Retrieval, presentation and agent outcomes have distinct scores; cases cover current/history, source-only facts, closed tasks, identifiers, paraphrases, conflicts and abstention; no private fixtures enter Git.
- [ ] Evidence: Partial: 8 new backend task-state cases and 5 PWA cases passed with synthetic
  fixtures; the existing held-out corpus remains unchanged. The private
  30–50-question corpus, independent split and expected identities remain open.
  Batch 2 adds 32 synthetic corpus-guard tests, without changing retrieval
  fixtures, held-out questions or quality floors.

### ME-03

**Define metric semantics and predeclare quality gates**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: ME-01, ME-02 · Validation: [V-03](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-03)

- [ ] Scope: Define Recall@5/10, currentness, answer/action correctness, provenance, abstention, reads, latency and resource/cost measures. Separate structured characters/bytes, full MCP bytes and actual inference tokens.
- [ ] Acceptance: Targets and sample protocol are fixed before comparisons; existing held-out gate is preserved; omissions and HTTP success are not misreported as failures or task success.
- [ ] Evidence: Partial: [baseline protocol](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md)
  defines measurement semantics and first-release gates. Six existing synthetic
  performance gates passed unchanged. Real-question quality and matched outcome
  measurements remain open. Batch 2's offline size diagnostics distinguish
  Unicode code points, UTF-16 units, logical UTF-8 bytes and the complete
  serialized MCP result; unavailable provider tokens/cost remain unknown.

### ME-04

**Reconcile metadata and lifecycle evidence**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W0 · Owner role: Operations\
Dependencies: ME-01 · Validation: [V-04](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-04)

- [ ] Scope: Audit stale project descriptions, runtime pointers and unknown lifecycle values using current dated evidence. Define a safe metadata correction queue and volatility policy inputs.
- [ ] Acceptance: Descriptions distinguish evidence from assumptions; unknown lifecycle is reported without automatic activation/retirement; no closed task is reopened or unrelated state changed.
- [ ] Evidence: Partial: operator-confirmed topology metadata was reconciled privately.
  The broader lifecycle/metadata audit and volatility policy remain open.

### ME-05

**Expose effective task state in search**\
Status: **DONE** · Priority: P0 · Wave: W1 · Owner role: Backend\
Dependencies: ME-02 · Validation: [V-05](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-05)

- [x] Scope: Reuse the operational task projection for task search hits: effective state, state source, progress identity, provenance and resume pointer. Retain the original record status separately.
- [x] Acceptance: Blocked-to-done, explicit terminal precedence and post-closure follow-up cases agree with dossier/resume without mutating accepted records.
- [x] Evidence: [Batch 1 qualification](docs/plans/2026-11-16-memory-evolution/BATCH_1.md)
  and [merged PR #27](https://github.com/anervalens-netizen/ContextKeep/pull/27).
  Source, synthetic behavior, exact-head reviews, CI and the full release gate
  are verified. Deployed MCP capability and original-regression readbacks passed,
  followed by independent recovery of the candidate-produced snapshot. Private
  runtime/recovery receipts are retained in ContextKeep.

### ME-06

**Rank current observations and historical answers correctly**\
Status: **PLANNED** · Priority: P0 · Wave: W1 · Owner role: Retrieval\
Dependencies: ME-02, ME-03, ME-05, ME-08 · Validation: [V-06](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-06)

- [ ] Scope: Make current-vs-historical intent, relevant evidence and freshness influence selection/ranking. Keep canonical and working results separate; avoid both newest-always-wins and accepted-always-wins rules.
- [ ] Acceptance: Current migration scenarios return dated relevant evidence; old accepted constraints remain visible; history queries recover prior state; no proposed report becomes accepted.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-07

**Measure candidate recall and saturation**\
Status: **PLANNED** · Priority: P1 · Wave: W1 · Owner role: Retrieval\
Dependencies: ME-02, ME-03 · Validation: [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07)

- [ ] Scope: Diagnose misses caused by bounded candidate selection; compare bounded widening or better selection before increasing cost. Preserve exact-identifier behavior and truthful saturation signals.
- [ ] Acceptance: Recall improves on the frozen set without unbounded scans; candidateLimitReached/mayHaveMore remain accurate and include usable continuation through narrower filters, bounded expansion or paging. A detail read alone cannot recover an unreturned identity. Report latency and false positives.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-08

**Define event, validity, capture and verification time**\
Status: **PLANNED** · Priority: P0 · Wave: W1 · Owner role: Backend\
Dependencies: ME-01, ME-02 · Validation: [V-08](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-08)

- [ ] Scope: Document temporal fields and missing-time behavior. Add freshness policy by evidence class, expiry/review handling and source-change revalidation without fabricating observation dates.
- [ ] Acceptance: Late imports do not look like new observations; future/expired/superseded/conflicting evidence stays labeled; missing volatility tags are not interpreted as proof of freshness or staleness.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-09

**Qualify current-state parity across surfaces**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W1 · Owner role: Backend\
Dependencies: ME-05, ME-06 · Validation: [V-09](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-09)

- [ ] Scope: Use the shared projection in search, HTTP, MCP, PWA and host views. Preserve explicit nulls, terminal status, classified attention and follow-up semantics.
- [ ] Acceptance: All relevant surfaces agree on effective state and provenance; reads do not change knowledge, progress, authority or external execution; legitimate telemetry/cache/cursor bookkeeping is allowed; closed/paused/retired cases retain legitimate attention.
- [ ] Evidence: Partial: Batch 1 task-state parity passed in HTTP, compact/legacy MCP and
  PWA synthetic checks. The deployed MCP task-state canary agrees with dossier.
  Ranking, freshness,
  lifecycle and the remaining cross-surface scenarios are still open.

### ME-10

**Add budgeted search summaries**\
Status: **PLANNED** · Priority: P0 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-02, ME-03, ME-05 · Validation: [V-10](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-10)

- [ ] Scope: Design additive summary/detail and total-budget options. Short cards retain identity, provenance, date/freshness, relevant snippet, task state and recovery; canonical/working/source evidence stay distinct.
- [ ] Acceptance: Declared representation stays within budget or returns a specific error; omitted bodies/lists are explicit; required information survives; legacy calls remain compatible.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-11

**Protect current context and improve budget remedies**\
Status: **PLANNED** · Priority: P0 · Wave: W2 · Owner role: Backend\
Dependencies: ME-02, ME-03, ME-05 · Validation: [V-11](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-11)

- [ ] Scope: Reuse packing for resume/work-context/search. Prioritize current state, next action, authority, active uncertainty and recovery over history; keep a pointer when checkpoint text is omitted.
- [ ] Acceptance: Impossible protected cores fail clearly; legacy vs structured and oversized-result remedies differ; no arbitrary truncation or identical deterministic retry hides missing context.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-12

**Implement progressive, version-aware evidence reads**\
Status: **PLANNED** · Priority: P1 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-10, ME-11 · Validation: [V-12](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-12)

- [ ] Scope: Expand only selected hits through bounded record/source reads. Include total/returned counts and recovery for truncated evidence and freshness references; detect changed revisions.
- [ ] Acceptance: All declared omissions are recoverable; detail matches its hit/source revision or discloses change; consumers do not treat an incomplete page as complete.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-13

**Expose scoped filters through MCP**\
Status: **PLANNED** · Priority: P1 · Wave: W2 · Owner role: Backend\
Dependencies: ME-02 · Validation: [V-13](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-13)

- [ ] Scope: Add project/task/date/type/source filters using existing backend behavior where possible. Specify whether each date is event, valid, import or write time.
- [ ] Acceptance: Filtering, counts, pagination and snippets respect selected scope; missing/invalid filters are explicit; current clients preserve documented defaults.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-14

**Index detailed sources and excerpts with FTS**\
Status: **PLANNED** · Priority: P1 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-02, ME-13 · Validation: [V-14](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-14)

- [ ] Scope: Add a separate derived FTS5 source/excerpt path and an explicit source_evidence result kind. Preserve source identity/version and avoid creating canonical records merely for indexing.
- [ ] Acceptance: Source-only synthetic facts are discoverable; whole-question LIKE is no longer the only route; snippets have evidence labels and cannot masquerade as accepted truth.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-15

**Make index lifecycle incremental and reconstructible**\
Status: **PLANNED** · Priority: P1 · Wave: W2 · Owner role: Backend\
Dependencies: ME-14 · Validation: [V-15](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-15)

- [ ] Scope: Define bounded backfill, restart/resume, index versioning, consistency checks, update/delete/redact propagation and rebuild controls. Measure write lock/WAL and storage impact.
- [ ] Acceptance: Interrupted rebuild resumes safely; stale/redacted/deleted fragments cannot be delivered; index removal does not destroy authority; migration/recovery gate is satisfied before release.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-16

**Preserve source representations, offsets and redaction**\
Status: **PLANNED** · Priority: P0 · Wave: W2 · Owner role: Backend\
Dependencies: ME-12, ME-14 · Validation: [V-16](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-16)

- [ ] Scope: Declare normalized/original representations and each offset unit. Keep code-point paging and UTF-16 excerpt compatibility explicit; verify spans after normalization and redaction.
- [ ] Acceptance: Diacritics, emoji, combining characters and boundary pages resolve to the advertised text; redaction precedes disclosure; no offset points silently into a different representation.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-17

**Improve RO/EN aliases and exact matching**\
Status: **PLANNED** · Priority: P1 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-02, ME-03, ME-07 · Validation: [V-17](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-17)

- [ ] Scope: Extend existing aliases only for measured misses. Compare equivalent paraphrases, broad terms, phrase queries and exact names/IDs; record failures left for semantic experiments.
- [ ] Acceptance: Relevant equivalence improves without false confidence, exact-match or abstention regression; held-out scores and remaining misses are reported.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-18

**Fix reviewer and review-status attribution**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W1 · Owner role: Integration\
Dependencies: ME-01 · Validation: [V-18](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-18)

- [ ] Scope: Update the companion review producer to use actual source reviewer, repository, resourceKind, PR, head, attested base, status and meaningful change. Missing base remains unknown. Distinguish running/completed/failure and awaiting disposition.
- [ ] Acceptance: Attribution matches source evidence for each reviewer; developer dispositions are not owner approval; external source/deployed producer versions are linked privately.
- [ ] Evidence: Local candidate and synthetic regression evidence are recorded in
  [Batch 2](docs/plans/2026-11-16-memory-evolution/BATCH_2.md). Official
  exact-head reviews, CI, integration and deployed readback remain pending;
  no production completion is claimed.

### ME-19

**Preserve review event identity and replay safety**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W1 · Owner role: Integration\
Dependencies: ME-18 · Validation: [V-19](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-19)

- [ ] Scope: Keep repository/resourceKind/source identity plus content version and saved retry payload. Test changed head, same-head base change, edited body with unchanged status, exact retry, out-of-order delivery, numeric-ID collisions across resource kinds and equal text across separate scopes.
- [ ] Acceptance: Exact retries do not create new events; legitimate revisions survive; no URL/title/global-text deduplication; uncertain delivery is reconciled before replay; identity-format migration preserves historical keys and payloads.
- [ ] Evidence: Local candidate and synthetic regression evidence are recorded in
  [Batch 2](docs/plans/2026-11-16-memory-evolution/BATCH_2.md). Official
  exact-head reviews, CI, integration and deployed readback remain pending;
  no production completion is claimed.

### ME-20

**Project current reviews by PR, reviewer and head**\
Status: **PLANNED** · Priority: P1 · Wave: W1 · Owner role: Integration\
Dependencies: ME-18, ME-19 · Validation: [V-20](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-20)

- [ ] Scope: Build a current review view with explicit reviewed head, attested base or unknown, resource kind/version, status and developer disposition; make older versions expandable with source links.
- [ ] Acceptance: Old-head or running reviews cannot satisfy current-head completion; missing/failed polls remain unknown; history and source authors remain recoverable.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-21

**Represent unchanged monitoring as structured observations**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Integration\
Dependencies: ME-01 · Validation: [V-21](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-21)

- [ ] Scope: Use semantic change fields and coverage watermarks, last successful observation and failure status. Surface changed facts/incidents/blockers; use a bounded journal for successful no-change observations. Preserve applicable identity/no-replay contracts without waiting for the separate review-bridge implementation.
- [ ] Acceptance: Failed fetch, partial page or missing history is not reported as no change; unchanged polls preserve coverage; omitted blocker text never resolves a blocker.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-22

**Reduce repetitive default context without deleting history**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Backend\
Dependencies: ME-20, ME-21 · Validation: [V-22](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-22)

- [ ] Scope: Select current meaningful observations and expandable history; offer useful interval/final summaries. Any historical projection backfill is scoped, previewed and reversible.
- [ ] Acceptance: Default context shrinks on matched workloads; every underlying version/evidence remains retrievable; equal text for distinct events is preserved; no bulk phrase/URL deletion.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-23

**Curate stable knowledge with explicit review status**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Knowledge\
Dependencies: ME-04, ME-08, ME-22 · Validation: [V-23](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-23)

- [ ] Scope: Define how architecture, constraints, decisions and runbooks are proposed from operational evidence. Keep transient progress separate; reuse existing review/acceptance semantics.
- [ ] Acceptance: Synthesis retains source links and status; proposed volume is not treated as automatic approval debt; no autonomous acceptance, silent contradiction resolution or source erasure.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-24

**Add a compact and conditional project catalogue**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Backend\
Dependencies: ME-03 · Validation: [V-24](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-24)

- [ ] Scope: Provide a small identity/metadata projection, scoped pagination and version/ETag semantics for repeated name-to-ID resolution. Define cache invalidation, renames and same-name projects.
- [ ] Acceptance: Consumers receive only requested fields; conditional responses still authenticate; identity cache never claims runtime freshness; pagination and changes remain detectable.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-25

**Optimize the health consumer while preserving its check**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Integration\
Dependencies: ME-03, ME-24 · Validation: [V-25](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-25)

- [ ] Scope: Update the deployed companion consumer to use compact/conditional reads with periodic fuller semantic checks through the authenticated application perimeter. Use a controlled consumer cohort; ME-27 is required only if the chosen attribution method needs it.
- [ ] Acceptance: Fewer serialized bytes per equivalent qualified check are measured; call rate is reported and reducing it is optional. Auth/application/database failure detection and its timing are preserved; a liveness-only endpoint does not replace the existing semantic check.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-26

**Separate actionable error codes and request shapes**\
Status: **PLANNED** · Priority: P0 · Wave: W4 · Owner role: Backend\
Dependencies: ME-01, ME-03 · Validation: [V-26](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-26)

- [ ] Scope: Diagnose budget, oversized result, schema, workflow/scope, client guard and internal failures with finite codes and format/budget buckets. Provide specific client remedies.
- [ ] Acceptance: Error causes can be measured without private payloads; deterministic failures do not retry unchanged; successful omissions remain separate; existing protection is not weakened.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-27

**Attribute consumers with bounded, trustworthy metadata**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Operations\
Dependencies: ME-03 · Validation: [V-27](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-27)

- [ ] Scope: Introduce finite consumer classes and unknown buckets where useful. Use authenticated server identity for trust; caller clientId remains untrusted metadata. Validate cardinality and privacy.
- [ ] Acceptance: Attribution strength is stated; spoofed clientId grants no authority; no raw IDs/queries/URLs in labels; catalogue-polling attribution can be tested prospectively.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-28

**Size telemetry retention and disclose coverage**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Operations\
Dependencies: ME-01, ME-27, ME-48 · Validation: [V-28](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-28)

- [ ] Scope: Measure retention/cardinality/storage cost before selecting a window long enough for comparable weeks. Preserve restart/reset, missing scrape and migration-gap semantics.
- [ ] Acceptance: Chosen retention fits storage policy; dashboards show actual coverage; unavailable history is not backfilled with invented exact counts. Duplicate scrapes of one instance are deduplicated using justified identity or the aggregate is labeled unreliable. Change and rollback are documented.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-29

**Build an outcome-oriented usage readout**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Evaluation\
Dependencies: ME-03, ME-26, ME-27, ME-28 · Validation: [V-29](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-29)

- [ ] Scope: Reuse current Prometheus metrics for calls/errors/duration/bytes/omissions plus sampled task/retrieval outcomes. Distinguish measured quality from successful HTTP transport.
- [ ] Acceptance: Readout labels windows, denominators, estimates and gaps; code family/actionable alerts are useful; bytes are never called billed tokens; omissions are interpreted in context.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-30

**Pilot existing delta consumption safely**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Integration\
Dependencies: ME-03, ME-31 · Validation: [V-30](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-30)

- [ ] Scope: Select a repeated full-read consumer and adopt existing canonical/working delta cursors, stable watermarks, paging and explicit recovery. Save a cursor only after final-page application.
- [ ] Acceptance: Concurrent writes and interrupted pages lose no events; expired/ahead cursors recover explicitly; canonical/working remain separate; reads/bytes benefit is measured.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-31

**Improve task capture and client workflow discipline**\
Status: **PLANNED** · Priority: P1 · Wave: W4 · Owner role: Integration\
Dependencies: ME-04, ME-11, ME-26 · Validation: [V-31](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-31)

- [ ] Scope: Update guidance for task reuse, structured resume, scoped captures, explicit project notes, dated observations/volatility and evidence references. Cache identity only; reread before fenced writes.
- [ ] Acceptance: Representative clients follow current contracts; scope/revision/idempotency errors have actionable fixes; connection metadata refresh is documented where needed.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-32

**Use evidence-backed relations before a graph stack**\
Status: **PLANNED** · Priority: P2 · Wave: W4 · Owner role: Knowledge\
Dependencies: ME-04, ME-23 · Validation: [V-32](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-32)

- [ ] Scope: Capture a small useful set of dependency/integration/runtime-target relations using existing primitives and stable identities. Resolve names on read and retain evidence status.
- [ ] Acceptance: Relations answer named real questions; guessed hosts and lexical similarity never create authoritative links; a dependency does not prove deployment/health/lifecycle.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-33

**Prototype a source-versioned project brief**\
Status: **PLANNED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-12, ME-23, ME-30 · Validation: [V-33](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-33)

- [ ] Scope: Derive current state, architecture, constraints, decisions, integrations, runbooks, uncertainties and a source index. Track section/source versions and clearly dated operational snapshots.
- [ ] Acceptance: Brief is useful on evaluation tasks, remains a derivative with proposal labels, and keeps previous valid content on generation/fetch failure; drift is visible.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-34

**Track claim provenance and targeted invalidation**\
Status: **PLANNED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-16, ME-33 · Validation: [V-34](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-34)

- [ ] Scope: Bind important claims to source version/hash/span, generation time and validation state. Detect changed supporting sources and target revalidation.
- [ ] Acceptance: Source change does not imply falsehood; affected claims become stale/unknown pending verification; unaffected claims survive; history and exact support remain accessible. Resolve support to distinct primary evidence; citation cycles and copied events do not add corroboration.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-35

**Run a bounded OpenWiki-style repository pilot**\
Status: **GATED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-03, ME-33, ME-34, ME-49 · Validation: [V-35](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-35)

- [ ] Scope: Select one repository and a defined architecture/runbook question set. Compare a source-grounded wiki and MCP/agent navigation with current retrieval; keep private sources private.
- [ ] Acceptance: Predeclared usefulness/cost and drift cases pass, or pilot is explicitly stopped/deferred; provider/access terms are checked; no generated wiki becomes authority.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-36

**Test thematic summaries with atomic refresh watermarks**\
Status: **GATED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-03, ME-30, ME-33, ME-49 · Validation: [V-36](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-36)

- [ ] Scope: Adapt Hindsight-style full/delta refresh for selected sections. Skip unnecessary inference when relevant sources have not changed; retain traces and atomic content/watermark updates.
- [ ] Acceptance: Failed or partial refresh preserves previous content and watermark; concurrent updates are recoverable; no-change avoids needless model calls. Summary citation cycles or copied events add no evidence/confidence; insufficient primary support is explicit. Record adopt/adapt/defer/stop.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-37

**Test conservative consolidation proposals**\
Status: **GATED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-03, ME-19, ME-22, ME-23, ME-34, ME-49 · Validation: [V-37](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-37)

- [ ] Scope: Evaluate Mem0-style merge/supersede/synthesize as proposals with sources/history. Distinguish same entity from possibly related and event time from write time.
- [ ] Acceptance: Equal text across scopes is not merged; changed events stay distinct; unsupported synthesis abstains. Repeated reports of one event and circular summaries do not create independent corroboration. Acceptance remains explicit; vendor feature/license parity is checked.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-38

**Test portable derived context for coding agents**\
Status: **GATED** · Priority: P2 · Wave: W5 · Owner role: Knowledge\
Dependencies: ME-03, ME-23, ME-33, ME-49 · Validation: [V-38](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-38)

- [ ] Scope: Evaluate a Letta-inspired versioned export with small index and progressive detail. Define schema, freshness, privacy and guarded write-back through ContextKeep.
- [ ] Acceptance: Export is reconstructible and useful; edits cannot bypass scope/revision/review; stale exports are labeled; it is never represented as a disaster-recovery copy or second truth store.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-39

**Compare API embeddings, fusion and optional reranking**\
Status: **GATED** · Priority: P2 · Wave: W6 · Owner role: Retrieval\
Dependencies: ME-03, ME-06, ME-14, ME-15, ME-17, ME-49 · Validation: [V-39](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-39)

- [ ] Scope: Proceed only for material held-out misses after lexical/currentness fixes. Compare API embeddings plus lexical fusion and optional bounded reranking using a versioned derived index.
- [ ] Acceptance: Benefit, latency, reads and actual API cost justify complexity; scope/provenance/abstention do not regress; timeout/stale/delete/redact paths and lexical fallback pass; otherwise stop.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-40

**Decide whether a temporal graph is justified**\
Status: **GATED** · Priority: P3 · Wave: W6 · Owner role: Knowledge\
Dependencies: ME-03, ME-32, ME-49 · Validation: [V-40](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-40)

- [ ] Scope: Identify dependency/time questions not solved by existing relations/joins. If material, compare a small derived graph/Graphiti-style experiment including provenance, validity and operations.
- [ ] Acceptance: Specific unanswered questions improve enough to justify synchronization/DB costs, or graph work is explicitly deferred; no graph database is introduced without this evidence.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-41

**Maintain client and host compatibility**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W7 · Owner role: Integration\
Dependencies: ME-03 · Validation: [V-41](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-41)

- [ ] Scope: For each release's affected contracts, update public MCP/HTTP documentation, ContextKeep Workflows and relevant UI/host metadata. Prefer additive defaults and versioned resource advertisement when bundled UI changes. Do not wait for unrelated future features.
- [ ] Acceptance: Old clients retain documented behavior; new clients discover fields/tools after required metadata refresh; no silent budget, resource URI or representation change.
- [ ] Evidence: Batch 1 subset: additive search projection, MCP 2.22.0 / schema 19,
  compatibility documentation, compact/legacy reads and 9 host-widget modes
  passed the release checks. Deployed capability discovery confirms the qualified
  build and contract; compatibility duties continue for later programme releases.

### ME-42

**Plan and qualify each staged rollout**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: ME-03 · Validation: [V-42](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-42)

- [ ] Scope: For every release, record selected item IDs, server/index/consumer order, mixed-version behavior, canary, feature controls and external repository dependencies.
- [ ] Acceptance: Consumers never require undeployed fields; canary and rollback decisions are explicit; implemented, published and runtime-verified statuses remain separate.
- [ ] Evidence: Batch 1 subset: exact source, required reviews, CI, release manifest and
  rollback plan are qualified. Activation, the deployed canary and independent
  recovery of the candidate-produced snapshot passed. See [release qualification](docs/plans/2026-11-16-memory-evolution/BATCH_1.md#qualified-source-and-reviews).

### ME-43

**Verify migration, index rebuild and recovery**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Operations\
Dependencies: ME-01, ME-48 · Validation: [V-43](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-43)

- [ ] Scope: For any affected index/schema release, verify recovery point, compatible runtime/database rollback, bounded backfill, storage reserve and scratch cleanup using established policy.
- [ ] Acceptance: Failure/restart/rollback drill succeeds on isolated data; redaction/delete stay correct; singular writer preserved; code-only work does not create unnecessary production copies.
- [ ] Evidence: Batch 1 subset: 84 operational tests passed, including 11 new runtime-kit
  identity/layout cases. Isolated snapshot recovery and same-clone candidate
  compatibility passed with cleanup confirmed privately. A subsequent independent
  restore qualified the new candidate-produced snapshot and backup format, with
  matching artifact checksums and cleanup. Broader migration/index drills remain
  applicable to their future releases.

### ME-44

**Complete exact-head reviews and release qualification**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: ME-42 · Validation: [V-44](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-44)

- [ ] Scope: For application changes, obtain required Codex Connector/DSH current-head reviews, explicit dispositions and CI; qualify deployed behavior and matching runtime/source identities.
- [ ] Acceptance: Required checks and review closure are evidenced for the delivered revision; a merge/command alone is not called deployment or verification; private operational proof stays private.
- [ ] Evidence: Batch 1 subset: [Codex review](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6912299583),
  [DSH review](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6913356673),
  [version-bound disposition](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6913458554),
  required CI and all 12 release-gate stages passed for `c13f1d6e1efcf1693082c014c66acdcf6ff85c1b`.
  Grouped review closure and deployed MCP/task-state behavior were read back
  privately. Independent recovery of the candidate-produced snapshot also passed;
  the wider programme's release duties remain open.

### ME-45

**Measure post-release outcomes against matched baseline**\
Status: **PLANNED** · Priority: P1 · Wave: W7 · Owner role: Evaluation\
Dependencies: ME-03, ME-44 · Validation: [V-45](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-45)

- [ ] Scope: For each release's affected behavior, compare canary and representative post-release windows for applicable quality, errors, reads, bytes, latency and resources. Control sample/traffic/retention differences and retain failed scenarios. Use bounded evidence before ME-29 exists; the full dashboard is not a prerequisite.
- [ ] Acceptance: Changes and limits are quantified on comparable populations; regressions have dispositions; no selective threshold changes or vendor-score extrapolation.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-46

**Keep the private evidence ledger and handoffs complete**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: ME-01 · Validation: [V-46](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-46)

- [ ] Scope: Map every audit section/finding to tracker IDs, private source/version evidence and eventual commit/test/deployment references. Preserve concise task-scoped checkpoints and unresolved limits.
- [ ] Acceptance: All audit findings are accounted for without publishing private metrics/identities; handoff points to exact artifacts; planning completion is distinct from feature completion.
- [ ] Evidence: Batch 1 evidence, exact run identities, review closure and recovery receipts
  are preserved in task-scoped private memory. This tracker records sanitized
  scope and public references; the programme-wide ledger remains a rolling duty.

### ME-47

**Regress authority, scope, uncertainty and no-replay invariants**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Backend\
Dependencies: ME-03 · Validation: [V-47](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-47)

- [ ] Scope: Apply integrated negative controls to new search/index/summary/client paths: untrusted source instructions, scope crossing, stale fences, truncated evidence, unresolved runs and closed tasks.
- [ ] Acceptance: No read starts execution, resolves blockers or promotes reports; uncertain effects are reconciled rather than replayed; every applicable hard gate passes before its release.
- [ ] Evidence: Batch 1 applicable regression controls passed: original authority/provenance,
  current-task classification, project scope, terminal precedence, explicit
  unknowns/nulls and no business-state mutation on read. Existing uncertainty,
  no-replay and privacy gates remain in force. Future changed paths still need
  their own controls.

### ME-48

**Measure capacity before infrastructure changes**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W4 · Owner role: Operations\
Dependencies: ME-01 · Validation: [V-48](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-48)

- [ ] Scope: Measure DB main/WAL/index growth, query/backfill latency, lock contention, service resource trends and retention impact. Use realistic bounded workloads and existing storage policy.
- [ ] Acceptance: Report trends and separate transient peaks from leaks/bottlenecks; growth fits reserve; no SQLite replacement or hardware claim is based on a single snapshot.
- [ ] Evidence: Batch 1 release/recovery capacity and cleanup were observed privately.
  These are bounded qualification measurements, not a growth trend or evidence
  for replacing storage. The planned longitudinal workload study remains open.

### ME-49

**Maintain research and pilot decision records**\
Status: **PLANNED** · Priority: P2 · Wave: W0 · Owner role: Evaluation\
Dependencies: ME-02, ME-03 · Validation: [V-49](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-49)

- [ ] Scope: Establish initial candidate dispositions in W0; recheck primary documentation, releases, feature/license availability, API support, cost and data flow at each pilot start. Record adopt/adapt/defer/stop for every candidate in the research ledger. A pilot needs its candidate-specific readiness record, not completion of every other experiment.
- [ ] Acceptance: OpenWiki/Hindsight/Mem0/Letta/Graphiti/hybrid/QMD/Augment/LangMem/evaluation references all have a disposition; vendor claims remain distinct from local measurements.
- [ ] Evidence: pending. Add exact PR/commit, acceptance result and applicable release
  or experiment disposition; retain private details in ContextKeep.

### ME-50

**Maintain tracker coverage and programme closure**\
Status: **IN_PROGRESS** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: none · Validation: [V-50](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-50)

- [ ] Scope: Use this tracker as the only active checklist. Assign actual owners at start; update dependencies, evidence, decisions and status with work. Keep archived trackers historical.
- [ ] Acceptance: No orphan/missing items or invalid dependencies; done requires applicable evidence, deferred/stopped requires rationale; unresolved work is handed off rather than silently omitted.
- [ ] Evidence: Batch 1 source/review/test evidence and remaining work are mapped here and
  in [BATCH_1.md](docs/plans/2026-11-16-memory-evolution/BATCH_1.md).
  All 50 item IDs and dependencies are retained. Programme closure remains open.

## Definition of completion

For every changed item, record date, actual assignee, scope, exact version,
validation evidence, unresolved limitations and the next action. Update the index
and item status together. If a dependency is already satisfied by a concurrent
change, verify it and link its evidence instead of reimplementing it.

No item is complete merely because it has a checkbox, a merged PR, a successful
command or an attractive summary. A test not run is **not run**; a feature not
deployed is **not deployed**; an inaccessible target remains **unverified**.

Check all finding IDs F01–F20 in PLAN.md against item IDs before programme closure.
Keep IDs stable. Add new items with new IDs; do not recycle or remove an item
because it was deferred. Preserve previous decisions and archived trackers.

## Evidence record template

Use the following fields for each meaningful update. Public entries contain only
synthetic or sanitized technical evidence.

- Date / item ID / actual assignee:
- Status before → after:
- Scope and exact source version:
- PR / commit / review dispositions:
- Validation IDs and results (pass / fail / not run / not applicable, with reason):
- Runtime verification or experiment disposition:
- Private evidence saved in ContextKeep:
- Known limits / blockers / next action:

## Dated programme updates

- **2026-11-16 — Plan established.** Consolidated the usage/retrieval/ingestion review
  and external memory research into 50 items, 20 finding groups and 50 acceptance
  scenarios. All feature work remains planned or gated. This documentation update
  does not deploy code, migrate data, install services or change project/task state.

- **2026-11-16 — Batch 1 delivered and verified.** Development agent;
  ME-05 IMPLEMENTED → VERIFIED → DONE. Candidate `c13f1d6e1efcf1693082c014c66acdcf6ff85c1b`
  was merged as `a8fea680edd317db84d0fc6dcb40b241546c540e` with an identical source tree.
  Both required reviews, explicit dispositions, CI and all 12 release-gate stages
  passed. The full gate includes 1,348 functional and 84 operational tests plus
  6 synthetic performance gates. Activation, capability discovery and the deployed
  task-state canary passed. Independent recovery of the new candidate-produced
  snapshot passed, qualifying the backup producer as well as the runtime.
  ME-01/02/03, the wider ME-09 contract and rolling release duties stay open.
  Next bounded correctness work: ME-18/19, alongside the private evaluation corpus.
  The existing LOW `deepmerge` advisory and follow-up remain documented in
  [Batch 1 limits](docs/plans/2026-11-16-memory-evolution/BATCH_1.md#known-limits-and-next-work).
