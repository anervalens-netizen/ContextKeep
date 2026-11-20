# Memory evolution tracker

Date opened: 2026-11-16\
Programme: memory, current-state retrieval, source indexing and usage efficiency\
Plan: [PLAN.md](docs/plans/2026-11-16-memory-evolution/PLAN.md)\
Acceptance cases: [VALIDATION.md](docs/plans/2026-11-16-memory-evolution/VALIDATION.md)

## Current inventory — 2026-11-19

**50 items — 27 VERIFIED, 1 DONE, 1 IMPLEMENTED, 4 IN_PROGRESS,
11 PLANNED, 6 GATED.** The [item index](#item-index) is the source for this
count. ME-07, ME-27, ME-45 and ME-48 are in progress. ME-11 is verified on
the installed MCP connector. ME-12 has verified record and source paging
and retains the freshness-reference acceptance requirement.

## Historical delivery checkpoints

**Batches 1–4 delivered their bounded scopes: effective task-state search,
forward review ingestion, a frozen private baseline and the compact/conditional
catalogue with its controlled consumer.** The server and consumer received
separate reviews, release qualification, authenticated runtime readback and
recoverability evidence. Broader real-traffic outcomes, source indexing, retrieval
and historical review reconciliation remain open below.

Initial inventory: **50 items — 44 PLANNED, 6 GATED, 0 IN_PROGRESS,
0 IMPLEMENTED, 0 VERIFIED, 0 DONE.** This line is a dated creation snapshot;
the item rows and later dated updates are authoritative as work proceeds.

Historical source-branch snapshot for ME-06 / ME-08 (before combining ME-13): **50 items —
22 PLANNED, 6 GATED, 17 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED, 1 DONE.**
ME-24 and ME-25 retain their bounded verified scopes. ME-27 is now
IN_PROGRESS; ME-45 and ME-48 remain IN_PROGRESS. The broader attribution,
prospective comparable outcome evaluation, longitudinal capacity assessment,
and isolated write/lock workload gates remain open. Runtime observations and
deployment receipts are stored privately in ContextKeep, not this tracker.
See [Batch 5](docs/plans/2026-11-16-memory-evolution/BATCH_5.md)
and [Batch 6](docs/plans/2026-11-16-memory-evolution/BATCH_6.md).

Historical source-branch snapshot for ME-13 (before combining ME-06/08): **50 items —
23 PLANNED, 6 GATED, 16 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED, 1 DONE.**
ME-13 moves to IN_PROGRESS for the bounded project/type/recordedAt MCP
filtering subset. Task/source/observation time scope, the candidate search
evaluation, and final reviewed release remain open. Earlier completed
scope is preserved.
See [Batch 7](docs/plans/2026-11-16-memory-evolution/BATCH_7_SCOPED_SEARCH.md).

Historical inventory for the combined Batch 7 source candidate (NOT production): **50 items —
21 PLANNED, 6 GATED, 18 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED, 1 DONE.**
ME-06, ME-08 and ME-13 are IN_PROGRESS; V-06/V-08/V-13 remain PARTIAL.
The integration source candidate retains the 200,000-byte MCP catalogue
limit and distinct canonical/working results. No required security gate or
review has been waived. See
[Batch 7 integration](docs/plans/2026-11-16-memory-evolution/BATCH_7_INTEGRATION.md).

Historical source snapshot for the stacked Batch 8 ME-10 candidate:
**50 items — 20 PLANNED, 6 GATED, 19 IN_PROGRESS, 0 IMPLEMENTED,
4 VERIFIED, 1 DONE.** This is NOT production; ME-10 is a bounded
source candidate with V-10 PARTIAL. ME-06, ME-08 and ME-13 remain in
progress with their own performance/security review gates.
See [Batch 8](docs/plans/2026-11-16-memory-evolution/BATCH_8_BUDGETED_SEARCH.md).

The complete private audit and operational evidence map remain in the ContextKeep
project. This public tracker contains technical scope and synthetic acceptance
contracts. Production status is recorded separately.

**2026-11-18 consolidated source candidate.** Development agent, based on the
stacked PR36 head `67f86dd0735b58aed98f6c72f70aaf31945e5ceb`. ME-11 and ME-12
move PLANNED → IMPLEMENTED. ME-06, ME-08 and ME-10 remain IN_PROGRESS.
V-06/V-08 retain a bounded fallback recall limit. V-10 retains source/excerpt
card discovery as open work. The [integrated source result](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#consolidated-source-batch)
records the synthetic comparison, local gates and remaining limits. Historical source candidate
inventory: **50 items — 18 PLANNED, 6 GATED, 19 IN_PROGRESS, 2 IMPLEMENTED,
4 VERIFIED, 1 DONE.**

### Historical consolidated release qualification

[PR #36](https://github.com/anervalens-netizen/ContextKeep/pull/36) merged as
`930f42ee4ceb0d50295231a0c2d27c00e8087868`. Its source covers corrected
temporal ranking, project/type/recorded-day filters, budgeted record cards,
protected task context and versioned evidence expansion. CI passed. The
authenticated runtime and rollback receipts are recorded privately. A separately
restored NAS recovery kit passed its checks. The installed-route checks cover
the selected release and do not qualify all historical storage copies or clients.

The matched private evaluation compared the candidate and baseline against the
same frozen snapshot. The observed improvement was in development-case
Recall@5. Held-out quality was unchanged, so ME-07 is in progress and the wider
retrieval acceptance requirements remain open. A scoped record-card check
qualified the declared structured-byte boundary and verified recovery for
selected expected results omitted at the lower budget. Source/excerpt discovery
is separate from this record-card contract. Raw cases and operational
measurements remain in the private evidence ledger.

Historical release inventory: **50 items — 16 PLANNED, 6 GATED, 21 IN_PROGRESS,
2 IMPLEMENTED, 4 VERIFIED, 1 DONE.** The release advances specific acceptance
slices. The item rows retain remaining scope and verification requirements.

### Historical source evidence and operator support candidate

The follow-on source candidate adds bounded project source discovery and
operator error guidance without a persistent schema change. Its historical
candidate inventory was **50 items — 11 PLANNED, 6 GATED, 25 IN_PROGRESS, 3 IMPLEMENTED, 4 VERIFIED, 1 DONE**.
This records source implementation. Installed verification and wider traffic outcomes retain
their individual acceptance gates.

### 2026-11-19 evidence reconciliation checkpoint

Historical inventory after that review: **50 items — 11 PLANNED, 6 GATED, 7 IN_PROGRESS, 2 IMPLEMENTED, 23 VERIFIED, 1 DONE**.

| Outcome | Verified scope | Remaining acceptance |
| --- | --- | --- |
| Baseline and gates | ME-01 and ME-03. The frozen private corpus, observation windows, source/runtime identity and metric semantics passed independent review. ME-04 corrected the dated runtime and backup description through the owner revision fence. Unknown lifecycle and closed tasks were preserved. | ME-02 needs equivalent synthetic scenarios and a separately scored agent outcome at that checkpoint. The later remaining-work review records their qualification. |
| Retrieval and fidelity | ME-06 bounded current/history behavior and ME-10 budgeted record cards passed in the releases built from [#36](https://github.com/anervalens-netizen/ContextKeep/pull/36) and [#37](https://github.com/anervalens-netizen/ContextKeep/pull/37). | ME-07 still has available evidence outside the top ten, predominantly in saturated queries. ME-08 needs evidence-class applicability and revalidation policy. ME-09 passed a read-only ChatGPT panel and native MCP comparison for completed and active tasks. A separate live case matched all seven present blockers and an empty run list. Synthetic task-navigation tests cover paused/retired state and invalidated proof. Chromium qualified both lifecycle states with and without unresolved execution against the same HTTP/MCP dossier. ME-13 task and source scope passed on the installed release. UTC date filters retain recorded-day semantics. ME-15 needs measured incremental invalidation and restart. ME-16 qualified invalid-span handling across MCP and owner HTTP/PWA. ME-15 passed interruption, rebuild, update/delete and WAL controls for the bounded in-memory index. |
| Review and operator experience | ME-20 has a qualified companion owner CLI view. ME-26 and ME-31 have bounded diagnostic codes, omissions and capture guidance. | ME-20 qualified the [installed owner current-review projection](https://github.com/anervalens-netizen/astancu-website/pull/61) from typed delivery evidence and a verified head/base. A native dossier view remains optional. ME-26/31 qualified application error and omission metrics, task-scoped capture and stable revision recovery. Transport failures before dispatch are outside the metric proof. |
| Release and recovery | ME-42, ME-43 and ME-47 qualify the installed #37 release. Bounded rebuild, compatible isolated rollback, deployed canaries, independent restore, authority controls and cleanup passed. The subsequent scheduled capture reached both off-host destinations with matching checksums. | ME-14 has live host source discovery and exact excerpt identity, offset and version parity. ME-41 authenticated catalogue refresh and native scoped calls passed. ME-44 has both exact-head reviews, disposition and CI for the installed follow-up release. The earlier deferral remains in the historical evidence. ME-46 maps all 20 audit findings to tracker items and private receipts. The existing task retains the proposed handoff and its readback. ME-50 remains active while programme acceptance remains open. |
| Prospective evidence | Bounded capacity, stress and restore findings are in private operational evidence. | ME-27, ME-45 and ME-48 alone depend on the 24 November matched full-window checkpoint. Compare attribution denominators, post-release outcomes and storage under the same probes/store. None depends on Windows. |

The paired release comparison improved development Recall@5 on two cases.
Private held-out Recall@5, Recall@10 and currentness stayed unchanged. Record
cards reduced the tested payload and preserved the first result in each
represented authority scope. Three expected secondary records omitted at the
lower explicit budget recovered at the higher budget.

### 2026-11-19 remaining-work review

The development agent owns ME-02, ME-07 and ME-08 qualification. The
operations and evaluation agents retain ME-27, ME-45 and ME-48 follow-up
on the predeclared same-probe, same-store cohort. The existing read-only
review is scheduled for 24 November at 21:30 Europe/Bucharest, after seven
complete days from the start of the later collector. Confirm actual elapsed
coverage, cadence and release boundaries at the checkpoint. The maintainer's
development agent owns ME-50 and the remaining-work handoff.

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

- ME-18 / ME-19: **VERIFIED within the new forward-ingestion scope**. Both
  required reviews, dispositions, source integration and CI passed. The qualified
  producer and complete owner workflow bundles are installed. The controlled
  live poll preserved existing delivery payloads and history, captured correctly
  attributed evidence and confirmed explicit grouped-review closure without
  replacing current checkpoints with older evidence. The targeted producer suite
  passes 99 synthetic tests. Legacy recovery remains partial: ambiguous or
  uncertain historical evidence stays fenced, and the poll reports an explicit
  reconciliation backlog rather than full health. Scheduled polling resumed
  after guarded acceptance. One automatic repeat completed without additional
  captures or dispositions and retained the known reconciliation fence. This
  observation does not establish indefinite stability or programme completion.
- ME-01 / ME-02 / ME-03: a strict offline corpus-validation helper is implemented
  against the existing baseline protocol, with 45 synthetic guard tests. This
  does not create or validate the real private question set. Evidence access and independent
  ground-truth review are required before freezing that corpus. The follow-up
  covers pagination, capture-window semantics, intent split boundaries and
  conflicting or incomplete response representations. A canonical freeze must
  still be registered privately before candidate tuning.
- ME-46 / ME-50: private runtime evidence and tracker synchronization remain
  active duties. Controlled producer readback, guarded schedule restart and one
  automatic repeat passed their scoped checks; continued operation, historical
  recovery and later programme releases retain their own gates.

The inventory snapshots above describe their individual checkpoints. The [item index](#item-index) records the current item statuses.

## Batch 3 — 2026-11-16

Scope, measurement contract and limits: [BATCH_3.md](docs/plans/2026-11-16-memory-evolution/BATCH_3.md).

- ME-01: bounded population and retained-usage evidence is collected privately.
  Exact stored counts remain separate from sampled counters, with retention,
  reset, migration and partial-window limits. No complete historical call ledger
  or continuous resource trend is claimed.
- ME-02: 40 investigator-authored RO/EN formulations from 20 real episodes are
  independently reviewed and frozen in the canonical private registry before
  tuning. There are 20 cases per split, six abstention cases and ten task-state
  cases. All 40 fixed live observations were collected once. The limited baseline
  passed independent contract, capture, metric and size verification, with
  no substantive discrepancies and a display-rounding note; failures are retained.
  The public helper passes 49 tests; both required reviews, CI and independent
  readback of the complete private archive passed. The version-bound disposition
  and grouped review closure were read back. Broader synthetic counterparts and
  agent outcomes remain open.
- ME-03: a separately reviewed private scorer passes 32 synthetic guard tests.
  Its exact field/identity metrics, denominators, serialization measures and
  client wall-clock observation method are predeclared. Source recall is
  inapplicable to the current MCP search surface; semantic abstention and agent
  outcomes remain NOT_RUN, with provider tokens/cost unknown.
- ME-24 / ME-25: covered private usage supports prioritizing compact catalogue
  responses and a controlled consumer examination. This is a sequencing decision,
  not implementation or a measured payload reduction.
- ME-46 / ME-48 / ME-50: corpus/review identities, observation boundaries and
  remaining limits are preserved privately and mapped here. No application
  deployment or ranking/alias tuning is part of this batch.

## Batch 4 — 2026-11-16

Scope, contract and predeclared comparison:
[BATCH_4.md](docs/plans/2026-11-16-memory-evolution/BATCH_4.md).

- ME-24: **VERIFIED.** [PR #30](https://github.com/anervalens-netizen/ContextKeep/pull/30)
  merged the compact/conditional catalogue. Both current-head reviews,
  dispositions, required CI and all 12 release-gate stages passed. Isolated
  candidate recovery, guarded activation and authenticated full/compact/
  conditional parity passed without replacing the production database.
  The installed contract is MCP 2.23.0 / schema 19; see
  [project-catalogue.md](docs/mcp/project-catalogue.md).
- ME-25: **VERIFIED within the controlled health-consumer scope.**
  [Companion PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53)
  was reviewed, dispositioned, CI-qualified and merged. The corrected consumer
  passed 51 catalogue scenarios, 148 targeted tests and a 902-test full Python
  suite. A guarded, component-only activation preserved unrelated owner code.
  The live scheduled full/compact control and a subsequent authenticated
  conditional 'unchanged' check both preserved 44 project identities and all
  five consumed fields. The independent historical synthetic comparison found
  90.3789% fewer complete serialized MCP result bytes and increased catalogue
  calls from 180 to 195. **That primary comparison used the pre-fix consumer
  source and was not rerun on the later compatibility fix; it does not establish
  a deployed byte/CPU/latency, network or provider-cost saving.**
- ME-41 / ME-42 / ME-43 / ME-44 / ME-47: the server and consumer passed the
  applicable compatibility, current-head reviews/disposition, CI, guarded
  activation and authenticated readback. A fresh deployed-release server backup
  was independently restored with matching runtime and database identity and
  complete isolated cleanup. The consumer's shared API/collector release receipt
  and read-only production catalogue checks passed. **ME-45 remains open** for
  a comparable natural-traffic period; an earlier synthetic percentage cannot
  be promoted into a production outcome claim.
- ME-46 / ME-48 / ME-50: the declaration, pre-measurement amendment, frozen input
  hashes, primary call rows, independent recomputation and source/review/runtime
  evidence are retained privately. The original failed guide-version gate is
  preserved. No natural-corpus rerun or retrieval tuning is part of this batch.

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
| [ME-01](#me-01) | Freeze the baseline and private evidence manifest | VERIFIED | P0 | W0 | Evaluation | — |
| [ME-02](#me-02) | Extend the real-question and synthetic evaluation sets | VERIFIED | P0 | W0 | Evaluation | ME-01 |
| [ME-03](#me-03) | Define metric semantics and predeclare quality gates | VERIFIED | P0 | W0 | Evaluation | ME-01, ME-02 |
| [ME-04](#me-04) | Reconcile metadata and lifecycle evidence | VERIFIED | P1 | W0 | Operations | ME-01 |
| [ME-05](#me-05) | Expose effective task state in search | DONE | P0 | W1 | Backend | ME-02 |
| [ME-06](#me-06) | Rank current observations and historical answers correctly | VERIFIED | P0 | W1 | Retrieval | ME-02, ME-03, ME-05, ME-08 |
| [ME-07](#me-07) | Measure candidate recall and saturation | IN_PROGRESS | P1 | W1 | Retrieval | ME-02, ME-03 |
| [ME-08](#me-08) | Define event, validity, capture and verification time | VERIFIED | P0 | W1 | Backend | ME-01, ME-02 |
| [ME-09](#me-09) | Qualify current-state parity across surfaces | VERIFIED | P0 | W1 | Backend | ME-05, ME-06 |
| [ME-10](#me-10) | Add budgeted search summaries | VERIFIED | P0 | W2 | Retrieval | ME-02, ME-03, ME-05 |
| [ME-11](#me-11) | Protect current context and improve budget remedies | VERIFIED | P0 | W2 | Backend | ME-02, ME-03, ME-05 |
| [ME-12](#me-12) | Implement progressive, version-aware evidence reads | IMPLEMENTED | P1 | W2 | Retrieval | ME-10, ME-11 |
| [ME-13](#me-13) | Expose scoped filters through MCP | VERIFIED | P1 | W2 | Backend | ME-02 |
| [ME-14](#me-14) | Index detailed sources and excerpts with FTS | VERIFIED | P1 | W2 | Retrieval | ME-02, ME-13 |
| [ME-15](#me-15) | Make index lifecycle incremental and reconstructible | VERIFIED | P1 | W2 | Backend | ME-14 |
| [ME-16](#me-16) | Preserve source representations, offsets and redaction | VERIFIED | P0 | W2 | Backend | ME-12, ME-14 |
| [ME-17](#me-17) | Improve RO/EN aliases and exact matching | PLANNED | P1 | W2 | Retrieval | ME-02, ME-03, ME-07 |
| [ME-18](#me-18) | Fix reviewer and review-status attribution | VERIFIED | P0 | W1 | Integration | ME-01 |
| [ME-19](#me-19) | Preserve review event identity and replay safety | VERIFIED | P0 | W1 | Integration | ME-18 |
| [ME-20](#me-20) | Project current reviews by PR, reviewer and head | VERIFIED | P1 | W1 | Integration | ME-18, ME-19 |
| [ME-21](#me-21) | Represent unchanged monitoring as structured observations | PLANNED | P1 | W3 | Integration | ME-01 |
| [ME-22](#me-22) | Reduce repetitive default context without deleting history | PLANNED | P1 | W3 | Backend | ME-20, ME-21 |
| [ME-23](#me-23) | Curate stable knowledge with explicit review status | PLANNED | P1 | W3 | Knowledge | ME-04, ME-08, ME-22 |
| [ME-24](#me-24) | Add a compact and conditional project catalogue | VERIFIED | P1 | W4 | Backend | ME-03 |
| [ME-25](#me-25) | Optimize the health consumer while preserving its check | VERIFIED | P1 | W4 | Integration | ME-03, ME-24 |
| [ME-26](#me-26) | Separate actionable error codes and request shapes | VERIFIED | P0 | W4 | Backend | ME-01, ME-03 |
| [ME-27](#me-27) | Attribute consumers with bounded, trustworthy metadata | IN_PROGRESS | P1 | W4 | Operations | ME-03 |
| [ME-28](#me-28) | Size telemetry retention and disclose coverage | PLANNED | P1 | W4 | Operations | ME-01, ME-27, ME-48 |
| [ME-29](#me-29) | Build an outcome-oriented usage readout | PLANNED | P1 | W4 | Evaluation | ME-03, ME-26, ME-27, ME-28 |
| [ME-30](#me-30) | Pilot existing delta consumption safely | PLANNED | P1 | W4 | Integration | ME-03, ME-31 |
| [ME-31](#me-31) | Improve task capture and client workflow discipline | VERIFIED | P1 | W4 | Integration | ME-04, ME-11, ME-26 |
| [ME-32](#me-32) | Use evidence-backed relations before a graph stack | PLANNED | P2 | W4 | Knowledge | ME-04, ME-23 |
| [ME-33](#me-33) | Prototype a source-versioned project brief | PLANNED | P2 | W5 | Knowledge | ME-12, ME-23, ME-30 |
| [ME-34](#me-34) | Track claim provenance and targeted invalidation | PLANNED | P2 | W5 | Knowledge | ME-16, ME-33 |
| [ME-35](#me-35) | Run a bounded OpenWiki-style repository pilot | GATED | P2 | W5 | Knowledge | ME-03, ME-33, ME-34, ME-49 |
| [ME-36](#me-36) | Test thematic summaries with atomic refresh watermarks | GATED | P2 | W5 | Knowledge | ME-03, ME-30, ME-33, ME-49 |
| [ME-37](#me-37) | Test conservative consolidation proposals | GATED | P2 | W5 | Knowledge | ME-03, ME-19, ME-22, ME-23, ME-34, ME-49 |
| [ME-38](#me-38) | Test portable derived context for coding agents | GATED | P2 | W5 | Knowledge | ME-03, ME-23, ME-33, ME-49 |
| [ME-39](#me-39) | Compare API embeddings, fusion and optional reranking | GATED | P2 | W6 | Retrieval | ME-03, ME-06, ME-14, ME-15, ME-17, ME-49 |
| [ME-40](#me-40) | Decide whether a temporal graph is justified | GATED | P3 | W6 | Knowledge | ME-03, ME-32, ME-49 |
| [ME-41](#me-41) | Maintain client and host compatibility | VERIFIED | P1 | W7 | Integration | ME-03 |
| [ME-42](#me-42) | Plan and qualify each staged rollout | VERIFIED | P0 | W7 | Maintainer | ME-03 |
| [ME-43](#me-43) | Verify migration, index rebuild and recovery | VERIFIED | P0 | W7 | Operations | ME-01, ME-48 |
| [ME-44](#me-44) | Complete exact-head reviews and release qualification | VERIFIED | P0 | W7 | Maintainer | ME-42 |
| [ME-45](#me-45) | Measure post-release outcomes against matched baseline | IN_PROGRESS | P1 | W7 | Evaluation | ME-03, ME-44 |
| [ME-46](#me-46) | Keep the private evidence ledger and handoffs complete | VERIFIED | P0 | W7 | Maintainer | ME-01 |
| [ME-47](#me-47) | Regress authority, scope, uncertainty and no-replay invariants | VERIFIED | P0 | W7 | Backend | ME-03 |
| [ME-48](#me-48) | Measure capacity before infrastructure changes | IN_PROGRESS | P1 | W4 | Operations | ME-01 |
| [ME-49](#me-49) | Maintain research and pilot decision records | PLANNED | P2 | W0 | Evaluation | ME-02, ME-03 |
| [ME-50](#me-50) | Maintain tracker coverage and programme closure | VERIFIED | P0 | W7 | Maintainer | — |

## Detailed work and acceptance

### ME-01

**Freeze the baseline and private evidence manifest**\
Status: **VERIFIED** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: none · Validation: [V-01](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-01)

- [ ] Scope: Capture source/runtime/schema versions, exact observation windows and timezones, corpus identity, read-only query definitions and coverage gaps. Keep record/source/progress/run/handoff/relation/delta/volatility populations separate.
- [ ] Acceptance: Reproducible private manifest exists; sampled counters and exact stored counts are labeled correctly; partial periods and runtime/description disagreement are recorded.
- [ ] Evidence: Partial: [baseline protocol](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md)
  and [Batch 3](docs/plans/2026-11-16-memory-evolution/BATCH_3.md) bind source/runtime
  identity, the canonical private corpus, bounded population reads and retained
  usage windows. Exact counts, sampled increases and coverage gaps are separated.
  The full programme baseline and matched candidate outcomes remain open. The
  [corpus preflight](scripts/evaluation/README.md) checks structure and identity;
  independent review supplies the separate semantic assessment.

### ME-02

**Extend the real-question and synthetic evaluation sets**\
Status: **VERIFIED** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: ME-01 · Validation: [V-02](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-02)

- [ ] Scope: Freeze 30–50 private real questions with expected record/source/task identities and time semantics. Extend existing RO/EN fixtures with synthetic equivalents; maintain a tuning/held-out split.
- [ ] Acceptance: Retrieval, presentation and agent outcomes have distinct scores; cases cover current/history, source-only facts, closed tasks, identifiers, paraphrases, conflicts and abstention; no private fixtures enter Git.
- [ ] Evidence: Partial: 8 new backend task-state cases and 5 PWA cases passed with synthetic
  fixtures; the existing held-out corpus remains unchanged.
  Batch 2 adds 45 synthetic corpus-guard tests, without changing retrieval
  fixtures, held-out questions or quality floors. Batch 3 independently reviews
  and freezes 40 private formulations from 20 real episodes, with 37 complete
  selected captures and a canonical registry. All 40 fixed observations are
  collected once; the limited baseline passed independent contract, capture,
  metric and size verification, retaining negative outcomes. Synthetic
  counterparts and agent outcomes remain open.
- [ ] Bounded correction technically qualified: Guard eight explicit source-backed
  flags in the preflight: the freshness reference-summary fields
  `supportReferencesTruncated` and `possiblyRelatedReferencesTruncated`, plus six
  packing flags on allowed read-tool responses. Independent review excluded two
  partial freshness-reference captures from gold and substituted complete sources
  before freeze. Reject true/malformed flags and preserve boolean false. All
  49 helper tests pass; four new parameterized tests cover all eight flags for
  true, false, invalid types and fail-closed freeze behavior. The single test
  `test_known_nested_truncation_flags_block_gold` reproduced eight failing
  subtests against the base helper. Both required reviews and CI passed; the
  version-bound disposition and grouped review closure are evidenced under ME-44. The frozen
  private evaluator and observation results remain unchanged.
- [x] 2026-11-19 qualification, development agent. Fourteen frozen fictional
  RO/EN prompts span seven paired episodes across the required scenario classes.
  In one tool-free, fixed-context agent run, 10/14 answers matched the frozen
  exact rubric. Permitted simulated actions and support IDs matched 14/14.
  Both required abstentions passed, with zero false abstentions on the other
  12 cases. Four exact-answer misses were retained. The fixture and offline
  score reproduction are under [scripts/evaluation](scripts/evaluation/README.md).
  Retrieval and presentation retain their separate frozen-corpus measurements.
  This is a fixed-context outcome sample, with no natural-data autonomous
  retrieval claim or statistical independence across translations.

### ME-03

**Define metric semantics and predeclare quality gates**\
Status: **VERIFIED** · Priority: P0 · Wave: W0 · Owner role: Evaluation\
Dependencies: ME-01, ME-02 · Validation: [V-03](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-03)

- [ ] Scope: Define Recall@5/10, currentness, answer/action correctness, provenance, abstention, reads, latency and resource/cost measures. Separate structured characters/bytes, full MCP bytes and actual inference tokens.
- [ ] Acceptance: Targets and sample protocol are fixed before comparisons; existing held-out gate is preserved; omissions and HTTP success are not misreported as failures or task success.
- [ ] Evidence: Partial: [baseline protocol](docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md)
  defines measurement semantics and first-release gates. Six existing synthetic
  performance gates passed unchanged. Batch 3 freezes bounded live contracts and
  a private observed-field scorer with 32 synthetic guard tests. The limited live
  baseline passed independent contract, capture, metric and size verification;
  the final check has no substantive discrepancies and a display-rounding note.
  Failures remain in the report. Matched candidate and agent outcome measurements
  remain open. Batch 2's offline size diagnostics distinguish
  Unicode code points, UTF-16 units, logical UTF-8 bytes and the complete
  serialized MCP result; unavailable provider tokens/cost remain unknown.
  Current MCP search has no ranked source list, so source recall is inapplicable.
  Exact field fidelity does not establish semantic abstention or agent success.

### ME-04

**Reconcile metadata and lifecycle evidence**\
Status: **VERIFIED** · Priority: P1 · Wave: W0 · Owner role: Operations\
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
Status: **VERIFIED** · Priority: P0 · Wave: W1 · Owner role: Retrieval\
Dependencies: ME-02, ME-03, ME-05, ME-08 · Validation: [V-06](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-06)

- [ ] Scope: Make current-vs-historical intent, relevant evidence and freshness influence selection/ranking. Keep canonical and working results separate; avoid both newest-always-wins and accepted-always-wins rules.
- [ ] Acceptance: Current migration scenarios return dated relevant evidence; old accepted constraints remain visible; history queries recover prior state; no proposed report becomes accepted.
- [ ] Evidence — 2026-11-17, development agent. The working-tree
  candidate starts from `c4b31d7663a2f70774364a08aa01ed2cba50c447`.
  Search opts into bounded lexical overscan and local temporal selection with exact-ID priority,
  current/historical RO/EN intent and an additive ranking explanation. Canonical,
  working and explicit historical boundaries stay authoritative. Other internal
  retrieval callers retain the existing scoring policy by default.
  `apps/server/test/search-temporal.test.ts` passes the original 40 synthetic cases. The combined
  adversarial source candidate now passes 49 temporal regressions, adding
  malformed review-time, invalid SQL timestamp, future-priority,
  mixed-intent and literal UUID phrase tests. The original source fails both
  FTS/LIKE saturation reproductions; the candidate passes both. The unchanged
  63-case held-out corpus retains Recall@5/@10 0.8627, currentness 0.5385 and
  abstention 0.6667 before/after, with zero provider calls. Its semantic gate
  remains PILOT_WARRANTED. V-06 is PARTIAL. The frozen private matched comparison,
  broader recall/resource gates, reviews, CI and release qualification remain
  pending. This entry records source tests only; deployment is unverified.
- [ ] Consolidated source batch: a second FTS shortlist recovers a known
  observation beyond 400 lexical candidates. LIKE fallback reproduces the
  remaining miss and reports saturation. See [V-06](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-06).

### ME-07

**Measure candidate recall and saturation**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W1 · Owner role: Retrieval\
Dependencies: ME-02, ME-03 · Validation: [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07)

- [ ] Scope: Diagnose misses caused by bounded candidate selection; compare bounded widening or better selection before increasing cost. Preserve exact-identifier behavior and truthful saturation signals.
- [ ] Acceptance: Recall improves on the frozen set without unbounded scans; candidateLimitReached/mayHaveMore remain accurate and include usable continuation through narrower filters, bounded expansion or paging. A detail read alone cannot recover an unreturned identity. Report latency and false positives.
- [ ] Evidence: The matched frozen-snapshot comparison for PR #36 observed
  development-case Recall@5 gains and unchanged held-out quality. Saturation
  remained visible and a bounded LIKE miss remains reproducible. Improve
  representative recall and qualify a recovery path for identities outside the
  returned candidate set before closing the item. Private case evidence is
  retained separately.
- [ ] 2026-11-19 qualification, development agent. A saturated synthetic
  query reports a bounded candidate window. The scoped retry recovers the
  previously unreturned evidence, and exact identifiers and project scope
  remain intact. [PR #40](https://github.com/anervalens-netizen/ContextKeep/pull/40)
  adds regression coverage. A separately measured bounded selection
  experiment recovered both synthetic stress targets but left frozen
  natural held-out recall and currentness unchanged. Expected evidence
  still misses the top ten, predominantly under saturation. Case counts
  and results are retained privately. The experiment was stopped at this scope. Qualify
  indexed anchors for representative long-form questions on a fresh
  holdout before proposing wider selection.
- [ ] 2026-11-19 fresh natural-language holdout, development agent. **STOP** for
  the sparsely represented term shortlist. It left top-ten expected-evidence
  placements unchanged at 3/15 in the as-of evaluation and 1/15 in the
  retrospective evaluation. Warm p95 for answerable as-of requests rose from
  132 to 147 ms. The experiment was stopped before deployment. Independently
  written short queries on the installed search build reached 6/15 as-of and
  4/15 retrospectively, with 0/4 placements on directly covered as-of questions.
  ME-07 remains in progress. The [validation result](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07)
  records the candidate and ranking misses and the scope of the comparison.
- [ ] 2026-11-19 cutoff and ranking follow-up, development agent. On two
  development cases missed with the existing day filter, a shared exact
  timestamp cutoff recovered one qualifying placement per case from a
  redacted linked excerpt. Two experimental ranking changes left top-ten
  direct-evidence coverage unchanged on a fresh holdout. The second also added
  a labeled wrong placement and increased warm p95 from 121 to 321 ms.
  On the reserve set, the second candidate recovered one of two expected
  direct placements, with a latency increase. Regressions across the
  evaluated sets blocked deployment. See [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07).
- [ ] 2026-11-19 opt-in excerpt recovery, development agent. A separate
  read-only response recovered one expected placement in the second
  independently labeled holdout. Ordinary search responses matched exactly
  on all 57 valid requests across the two holdouts and the control set.
  The control audit still found one misleading topical match. The opt-in
  path remains experimental. See [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07).
- [ ] 2026-11-19 existing source-discovery fallback, development agent.
  A bounded caller workflow preserved ordinary search across 57 valid
  requests and found one directly relevant source excerpt in the previously
  diagnosed cohort. It found no direct recovery in the newest 24 queries.
  Topical overlap and misleading matches still require explicit verification.
  The results and limits are recorded in [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07).

- 2026-11-19 paired scoring check. On 73 frozen real questions, 17 of
  88 expected placements were in the top ten. Of the 71 misses, 36 were
  absent from the scored candidate set and 35 ranked below the top ten.
  A saturated candidate bucket was observed for 63 of the misses.
- [x] [PR #42](https://github.com/anervalens-netizen/ContextKeep/pull/42) reduced repeated processing of record text. The ordered
  results and saturation flags matched on all 73 real questions and four
  separately worded probes. In-process MCP median fell from 95 to 86 ms
  and p95 from 212 to 199 ms on the real set. Release `bee7ee1` passed
  the installed connector and runtime readback.
- [ ] The numbered-reference experiment raised an expected result from
  rank 49 to rank 1, and another probe returned a stale same-reference
  checkpoint. The experiment was stopped. Candidate recall and precedence
  among records for the same reference remain open. See
  [V-07](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-07).

### ME-08

**Define event, validity, capture and verification time**\
Status: **VERIFIED** · Priority: P0 · Wave: W1 · Owner role: Backend\
Dependencies: ME-01, ME-02 · Validation: [V-08](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-08)

- [ ] Scope: Document temporal fields and missing-time behavior. Add freshness policy by evidence class, expiry/review handling and source-change revalidation without fabricating observation dates.
- [ ] Acceptance: Late imports do not look like new observations; future/expired/superseded/conflicting evidence stays labeled; missing volatility tags are not interpreted as proof of freshness or staleness.
- [ ] Evidence — 2026-11-17, development agent. The same bounded source
  candidate as ME-06 defines event/effective ranking time separately from capture
  and review time. Search rejects malformed, future, expired and inverted validity
  times for current bonuses, preserves fractional-instant ordering and keeps
  unknown observation time null. MCP search exposes source/effective timestamps
  and preserves proposal authority. Missing volatility tags cause no automatic
  expiry. Search currentness cannot certify invalid/future events as current.
  The 40-case synthetic temporal suite and targeted 68-test search/evaluation
  suite pass. V-08 is PARTIAL. This search policy reuses existing operational
  claim classification; broader evidence-class/revalidation policy, cross-surface
  qualification and release/deployment evidence remain open.
- [ ] Consolidated source batch: SQL time comparisons select a bounded
  shortlist. Strict event, validity and review checks still run before ranking.
  See [V-08](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-08).
- [x] 2026-11-19 qualification, development agent. [PR #40](https://github.com/anervalens-netizen/ContextKeep/pull/40)
  defines the [evidence-class policy](docs/contextkeep-mcp.md#evidence-times-and-revalidation)
  and rechecks proposal eligibility for accepted current-state records.
  Exact activation and expiry, clock reversal, legacy malformed times,
  corrected observation dates and HTTP/MCP freshness parity passed.
  All 12 local release checks, hosted CI, staged candidate and rollback
  restores passed. The installed release is
  `32ea46cf7f73b32781102de4de7fb4033ccbe5ab`. Authenticated runtime
  checks verified accepted operational revalidation, superseded history,
  stable reference evidence and proposal authority. Real canaries were
  read-only. Future, expired, corrected and malformed inputs were
  controlled synthetic cases. The
  [exact-head disposition](https://github.com/anervalens-netizen/ContextKeep/pull/40#issuecomment-7005913416)
  records the owner-approved single-PR review substitution and the DSH
  provider failure. The standard workflow remains in force.
- [ ] 2026-11-20 follow-up of [PR #40](https://github.com/anervalens-netizen/ContextKeep/pull/40): fix the low-severity capture-only hint regression for legacy empty structured timestamps. The failing test was reproduced before correction; focused tests pass after correction. Codex found that search ranking also used the blank event string ahead of a valid effective start; follow-up correction and regression tests now use the same missing-time semantics for freshness and search. Full current-head CI, independent review, release checks and deployed readback remain separate gates.

### ME-09

**Qualify current-state parity across surfaces**\
Status: **VERIFIED** · Priority: P0 · Wave: W1 · Owner role: Backend\
Dependencies: ME-05, ME-06 · Validation: [V-09](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-09)

- [x] 2026-11-19 qualification. Three authenticated host tasks matched native MCP status, provenance, next action and blocker counts. Four browser cases covered paused/retired projects with and without unresolved execution, cross-checked against the HTTP dossier. The terminal and post-closure guards remain covered.

- [ ] Scope: Use the shared projection in search, HTTP, MCP, PWA and host views. Preserve explicit nulls, terminal status, classified attention and follow-up semantics.
- [ ] Acceptance: All relevant surfaces agree on effective state and provenance; reads do not change knowledge, progress, authority or external execution; legitimate telemetry/cache/cursor bookkeeping is allowed; closed/paused/retired cases retain legitimate attention.
- [ ] Evidence: Partial: Batch 1 task-state parity passed in HTTP, compact/legacy MCP and
  PWA synthetic checks. The deployed MCP task-state canary agrees with dossier.
  Ranking, freshness,
  lifecycle and the remaining cross-surface scenarios are still open.

### ME-10

**Add budgeted search summaries**\
Status: **VERIFIED** · Priority: P0 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-02, ME-03, ME-05 · Validation: [V-10](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-10)

- [ ] Scope: Design additive summary/detail and total-budget options. Short cards retain identity, provenance, date/freshness, relevant snippet, task state and recovery; canonical/working/source evidence stay distinct.
- [ ] Acceptance: Declared representation stays within budget or returns a specific error; omitted bodies/lists are explicit; required information survives; legacy calls remain compatible.
- [ ] Evidence: [Batch 8 source candidate](docs/plans/2026-11-16-memory-evolution/BATCH_8_BUDGETED_SEARCH.md)
  adds opt-in representation=cards with a structured UTF-8 JSON
  maxResultBytes budget, explicit omissions, one result per nonempty
  trust scope and recoverable get_record details.
  The legacy full result is unchanged unless a budget is explicitly
  requested; then it fails with a specific error instead of truncating.
  The consolidated source batch adds version-bound detail pointers to
  record cards through ME-12. The matched qualification confirmed exact UTF-8
  accounting and also found expected records omitted at the lower budget that
  became visible at the higher one. Discovery cards for sources/excerpts
  require a separate search contract. V-10 remains PARTIAL.

### ME-11

**Protect current context and improve budget remedies**\
Status: **VERIFIED** · Priority: P0 · Wave: W2 · Owner role: Backend\
Dependencies: ME-02, ME-03, ME-05 · Validation: [V-11](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-11)

- [ ] Scope: Reuse packing for resume/work-context/search. Prioritize current state, next action, authority, active uncertainty and recovery over history; keep a pointer when checkpoint text is omitted.
- [ ] Acceptance: Impossible protected cores fail clearly; legacy vs structured and oversized-result remedies differ; no arbitrary truncation or identical deterministic retry hides missing context.
- [ ] Evidence: The integrated source batch introduces opt-in
  `protectCurrent` for task-scoped work context and structured resume.
  Synthetic MCP reads preserve the full checkpoint action, authority,
  blocker/uncertainty counts and recovery. Separate errors handle a small
  request budget and a core beyond the response ceiling. Legacy forms pass
  compatibility tests. The selected release passed its runtime and rollback
  gates.
- [x] [PR #41](https://github.com/anervalens-netizen/ContextKeep/pull/41)
  verified on the installed MCP connector at release `be6b35f`. An
  undersized protected-context request returned a minimum budget that worked
  on retry. Protected resume preserved state and supplied a callable pointer
  for the omitted checkpoint. Synthetic coverage retains the response-ceiling
  and legacy cases.


### ME-12

**Implement progressive, version-aware evidence reads**\
Status: **IMPLEMENTED** · Priority: P1 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-10, ME-11 · Validation: [V-12](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-12)

- [ ] Scope: Expand only selected hits through bounded record/source reads. Include total/returned counts and recovery for truncated evidence and freshness references; detect changed revisions.
- [ ] Acceptance: All declared omissions are recoverable; detail matches its hit/source revision or discloses change; consumers do not treat an incomplete page as complete.
- [ ] Evidence: Selected search cards carry record and evidence fences.
  The source candidate walks bounded, versioned record and source pages with
  totals, returned counts and recovery. Synthetic tests reject stale revisions,
  source/excerpt changes, cross-project reads and proposals without opt-in.
  Freshness reference samples remain bounded; V-12 remains PARTIAL.
- [x] [PR #41](https://github.com/anervalens-netizen/ContextKeep/pull/41)
  verified bounded record and source pagination on the installed MCP
  connector at release `be6b35f`. Accepted and proposed card details,
  linked evidence, source text and excerpt pages kept their expected
  identities and rejected stale versions. Under byte pressure, cards can
  shorten previews before omitting results.
- [ ] Exhaustive freshness-reference paging remains open in V-12.


### ME-13

**Expose scoped filters through MCP**\
Status: **VERIFIED** · Priority: P1 · Wave: W2 · Owner role: Backend\
Dependencies: ME-02 · Validation: [V-13](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-13)

- [ ] Scope: Add project/task/date/type/source filters using existing backend behavior where possible. Specify whether each date is event, valid, import or write time.
- [ ] Acceptance: Filtering, counts, pagination and snippets respect selected scope; missing/invalid filters are explicit; current clients preserve documented defaults.
- [ ] Evidence: [Batch 7 scoped-filter contract](docs/plans/2026-11-16-memory-evolution/BATCH_7_SCOPED_SEARCH.md)
  uses the already qualified HTTP backend for project scope, record type and
  recordedAt UTC-day intervals through the MCP search_context tool.
  Strict ISO date and inclusive-range validation, canonical/working truth
  separation, legacy defaults and bounded completeness have synthetic
  tests. [PR #38](https://github.com/anervalens-netizen/ContextKeep/pull/38)
  qualifies exact task/source scoping through authenticated HTTP and MCP. It
  applies the same project fence to phrase/terms, FTS/LIKE and exact identity.
  The installed canary matched linked records using both filters. Additional
  date semantics have no implicit fallback from the recorded-day contract.

### ME-14

**Index detailed sources and excerpts with FTS**\
Status: **VERIFIED** · Priority: P1 · Wave: W2 · Owner role: Retrieval\
Dependencies: ME-02, ME-13 · Validation: [V-14](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-14)

- [ ] Scope: Add a separate derived FTS5 source/excerpt path and an explicit source_evidence result kind. Preserve source identity/version and avoid creating canonical records merely for indexing.
- [ ] Acceptance: Source-only synthetic facts are discoverable; whole-question LIKE is no longer the only route; snippets have evidence labels and cannot masquerade as accepted truth.
- [ ] Evidence: A project-scoped MCP query reads a separate, bounded FTS5 index of source titles and redacted normalized excerpts. Each result has evidence-only authority and version-bound detail navigation. Synthetic source-only facts are discoverable without canonical record creation.

### ME-15

**Make index lifecycle incremental and reconstructible**\
Status: **VERIFIED** · Priority: P1 · Wave: W2 · Owner role: Backend\
Dependencies: ME-14 · Validation: [V-15](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-15)

- [x] 2026-11-19 qualification. An isolated exact-build test stopped a worker during FTS insertion. A separate writer committed while it was stopped, and the next read rebuilt from the complete current source. Stale/redacted evidence stayed absent, no authoritative writes were caused by queries, and the WAL did not grow during rebuild. This design has no durable backfill.

- [ ] Scope: Define bounded backfill, restart/resume, index versioning, consistency checks, update/delete/redact propagation and rebuild controls. Measure write lock/WAL and storage impact.
- [ ] Acceptance: Interrupted rebuild resumes safely; stale/redacted/deleted fragments cannot be delivered; index removal does not destroy authority; migration/recovery gate is satisfied before release.
- [ ] Evidence: The initial index is bounded, reconstructible and memory-only. Two project slots are kept. Local writes, external commits, or credential changes revalidate source inputs before a query can reuse an index. The source path requires no schema migration or durable backfill. Wider cache efficiency, workload coverage and installed recovery evidence remain open.

### ME-16

**Preserve source representations, offsets and redaction**\
Status: **VERIFIED** · Priority: P0 · Wave: W2 · Owner role: Backend\
Dependencies: ME-12, ME-14 · Validation: [V-16](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-16)

- [x] 2026-11-19 qualification. PR #39 qualified malformed span results, owner source detail pagination, normalized UTF-16 offsets, credential-masked MCP snippets and PWA presentation. The real stored sample contained no invalid UTF-16 spans. Synthetic legacy corruption supplied negative, fractional, text and surrogate-splitting cases.

- [ ] Scope: Declare normalized/original representations and each offset unit. Keep code-point paging and UTF-16 excerpt compatibility explicit; verify spans after normalization and redaction.
- [ ] Acceptance: Diacritics, emoji, combining characters and boundary pages resolve to the advertised text; redaction precedes disclosure; no offset points silently into a different representation.
- [ ] Evidence: The source-discovery contract labels UTF-16 offsets into redacted normalized text and supplies a version-bound get_source excerpt. Synthetic tests cover emoji, a combining character, credential masking and malformed offsets. Broader corpus and client coverage remain open.

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
Status: **VERIFIED** · Priority: P0 · Wave: W1 · Owner role: Integration\
Dependencies: ME-01 · Validation: [V-18](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-18)

- [x] Scope: Update the companion review producer to use actual source reviewer, repository, resourceKind, PR, head, attested base, status and meaningful change. Missing base remains unknown. Distinguish running/completed/failure and awaiting disposition.
- [x] Acceptance: Attribution matches source evidence for each reviewer; developer dispositions are not owner approval; external source/deployed producer versions are linked privately.
- [x] Evidence: [Batch 2](docs/plans/2026-11-16-memory-evolution/BATCH_2.md)
  records qualified synthetic coverage and controlled deployed readback. Actual
  reviewer, source author, reviewed head and base provenance matched the sampled
  evidence; an unattested base remained unknown. Explicit developer dispositions
  closed the grouped review work without owner acceptance. Verification covers
  forward ingestion; historical reconciliation and the ME-20 projection remain
  separate. Scheduled polling resumed; one automatic repeat completed without
  additional captures or dispositions while retaining the known fence.

### ME-19

**Preserve review event identity and replay safety**\
Status: **VERIFIED** · Priority: P0 · Wave: W1 · Owner role: Integration\
Dependencies: ME-18 · Validation: [V-19](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-19)

- [x] Scope: Keep repository/resourceKind/source identity plus content version and saved retry payload. Test changed head, same-head base change, edited body with unchanged status, exact retry, out-of-order delivery, numeric-ID collisions across resource kinds and equal text across separate scopes.
- [x] Acceptance: Exact retries do not create new events; legitimate revisions survive; no URL/title/global-text deduplication; uncertain delivery is reconciled before replay; identity-format migration preserves historical keys and payloads.
- [x] Evidence: [Batch 2](docs/plans/2026-11-16-memory-evolution/BATCH_2.md)
  records qualified retry, ordering and scope regressions. The controlled live
  poll retained original delivery rows and review history, added eligible
  evidence and explicit dispositions, and preserved current checkpoints. Legacy
  ambiguity remains durably fenced; no replacement-key replay or historical
  rewrite was used. Verification covers forward ingestion, not complete legacy
  recovery. The reported backlog is incomplete coverage, not full health.

### ME-20

**Project current reviews by PR, reviewer and head**\
Status: **VERIFIED** · Priority: P1 · Wave: W1 · Owner role: Integration\
Dependencies: ME-18, ME-19 · Validation: [V-20](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-20)

- [x] 2026-11-19 qualification. The deployed companion workflow selects the authoritative current head/base, reads typed versioned delivery history, and shows linked developer disposition. Saved record identities were read back in ContextKeep as proposed evidence. A native dossier rendition can follow a demonstrated need and typed ingress.

- [ ] Scope: Build a current review view with explicit reviewed head, attested base or unknown, resource kind/version, status and developer disposition; make older versions expandable with source links.
- [ ] Acceptance: Old-head or running reviews cannot satisfy current-head completion; missing/failed polls remain unknown; history and source authors remain recoverable.
- [ ] Evidence: Companion [PR #58](https://github.com/anervalens-netizen/astancu-website/pull/58)
  merged as `a7f05d42a49433f967023f79aff60b40f0ea1fdc` with the same tree as the
  exact reviewed head. Codex, DSH, both CI checks and the version-bound disposition
  qualified the owner CLI slice. The grouped review closure and installed read-only
  CLI were read back independently. Scoped pages retain old versions, original
  event time, latest observation, source and attested base or unknown.
  The projection exposes capture-time disposition and unknown live poll status.
  Broader ContextKeep presentation and current-review selection remain open.

### ME-21

**Represent unchanged monitoring as structured observations**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Integration\
Dependencies: ME-01 · Validation: [V-21](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-21)

- [ ] Scope: Use semantic change fields and coverage watermarks, last successful observation and failure status. Surface changed facts/incidents/blockers; use a bounded journal for successful no-change observations. Preserve applicable identity/no-replay contracts without waiting for the separate review-bridge implementation.
- [ ] Acceptance: Failed fetch, partial page or missing history is not reported as no change; unchanged polls preserve coverage; omitted blocker text never resolves a blocker.
- [ ] Evidence: A read-only production sample confirmed narrative no-change
  phrases without a typed observation contract. Similar wording can coexist with
  checkpoint information and does not prove coverage. Qualify a real producer that
  reports succeeded, partial and failed observations with a source watermark
  before changing context selection.

### ME-22

**Reduce repetitive default context without deleting history**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Backend\
Dependencies: ME-20, ME-21 · Validation: [V-22](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-22)

- [ ] Scope: Select current meaningful observations and expandable history; offer useful interval/final summaries. Any historical projection backfill is scoped, previewed and reversible.
- [ ] Acceptance: Default context shrinks on matched workloads; every underlying version/evidence remains retrievable; equal text for distinct events is preserved; no bulk phrase/URL deletion.
- [ ] Evidence: The existing compact working index already avoids duplicating full
  proposal bodies. Review versions remain available through the separate projected
  history. Further default suppression requires typed observations and a matched
  reduction without hiding material events or blockers. No historical record was
  changed.

### ME-23

**Curate stable knowledge with explicit review status**\
Status: **PLANNED** · Priority: P1 · Wave: W3 · Owner role: Knowledge\
Dependencies: ME-04, ME-08, ME-22 · Validation: [V-23](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-23)

- [ ] Scope: Define how architecture, constraints, decisions and runbooks are proposed from operational evidence. Keep transient progress separate; reuse existing review/acceptance semantics.
- [ ] Acceptance: Synthesis retains source links and status; proposed volume is not treated as automatic approval debt; no autonomous acceptance, silent contradiction resolution or source erasure.
- [ ] Evidence: The existing review path continues to keep proposals separate from
  accepted knowledge. A curator pilot still needs a concrete stable-knowledge
  cohort and independently reviewable source references. Operational proposal
  volume alone does not establish approval debt.

### ME-24

**Add a compact and conditional project catalogue**\
Status: **VERIFIED** · Priority: P1 · Wave: W4 · Owner role: Backend\
Dependencies: ME-03 · Validation: [V-24](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-24)

- [x] Scope: Provide a small identity/metadata projection, scoped pagination and conditional version semantics for repeated name-to-ID resolution. Define cache invalidation, renames, exact-name uniqueness and ambiguous aliases.
- [x] Acceptance: Consumers receive only requested fields; conditional responses still authenticate; identity cache never claims runtime freshness; pagination and changes remain detectable.
- [x] Evidence: [Batch 4](docs/plans/2026-11-16-memory-evolution/BATCH_4.md) records
  [PR #30](https://github.com/anervalens-netizen/ContextKeep/pull/30), reviewed head
  `9a0e0244c48adcc8c24bc8d3122de4d83214bd00` and merge `39aa969658630b8b3e5fd25723701a2eab525de4`.
  The 55 focused tests, both current-head reviews, dispositions, CI and all 12
  release-gate stages passed. Isolated candidate recovery and authenticated
  deployed full/compact/conditional parity passed after guarded activation.
  Schema 19 and the existing database were preserved. The disclosed O(N)
  metadata cost and pre-existing import-lifecycle defect remain separate follow-ups.

### ME-25

**Optimize the health consumer while preserving its check**\
Status: **VERIFIED** · Priority: P1 · Wave: W4 · Owner role: Integration\
Dependencies: ME-03, ME-24 · Validation: [V-25](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-25)

- [x] Scope: Update the controlled deployed companion consumer to use compact/conditional reads with periodic fuller semantic checks through the authenticated application perimeter. ME-27 is not required for this one explicitly identified cohort.
- [x] Acceptance: The frozen matched synthetic comparison measures fewer complete serialized MCP result bytes while reporting the extra calls. Authentication/application/database failures and freshness preservation pass negative tests; no liveness-only shortcut is used. The later compatibility changes preserve the tested successful request path but are not themselves a newly measured primary workload.
- [x] Evidence: [Batch 4](docs/plans/2026-11-16-memory-evolution/BATCH_4.md) records
  [PR #53](https://github.com/anervalens-netizen/astancu-website/pull/53),
  current-head review, CI and a component-only deployed check with live full
  control and conditional revalidation of 44 projects. The corrected consumer
  passed 51 catalogue cases and 148 targeted checks; the full Python suite
  passed 902 checks. The frozen **pre-fix** comparison recorded 12,037,320 to
  1,158,120 complete serialized result bytes over 60 matched checks, with
  catalogue calls increasing from 180 to 195. Its 90.3789% reduction was not
  remeasured after the compatibility fixes and is not a production outcome.
  The unrelated health pipeline may still report an independent component
  failure; do not relabel the overall monitor as green. Natural-traffic
  evaluation, slow-route thresholds and wider attribution remain open.

### ME-26

**Separate actionable error codes and request shapes**\
Status: **VERIFIED** · Priority: P0 · Wave: W4 · Owner role: Backend\
Dependencies: ME-01, ME-03 · Validation: [V-26](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-26)

- [x] 2026-11-19 qualification. Ten deterministic error or recovery paths were reproduced via JSON-RPC. Application metrics kept caller-controlled values out of labels. The structured resume omission counted on success without changing causal error metrics. Transport failures before the application dispatcher remain outside this measurement.

- [ ] Scope: Diagnose budget, oversized result, schema, workflow/scope, client guard and internal failures with finite codes and format/budget buckets. Provide specific client remedies.
- [ ] Acceptance: Error causes can be measured without private payloads; deterministic failures do not retry unchanged; successful omissions remain separate; existing protection is not weakened.
- [ ] Evidence: The MCP dispatcher counts bounded error causes and request shapes separately from successful omissions. Action text covers deterministic task, revision, credential and budget failures. SDK failures before server dispatch and representative production usage remain open.

### ME-27

**Attribute consumers with bounded, trustworthy metadata**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W4 · Owner role: Operations\
Dependencies: ME-03 · Validation: [V-27](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-27)

- [ ] Scope: Introduce finite consumer classes and unknown buckets where useful. Use authenticated server identity for trust; caller clientId remains untrusted metadata. Validate cardinality and privacy.
- [ ] Acceptance: Attribution strength is stated; spoofed clientId grants no authority; no raw IDs/queries/URLs in labels; catalogue-polling attribution can be tested prospectively.
- [ ] Evidence: [Companion PR #55](https://github.com/anervalens-netizen/astancu-website/pull/55)
  defines a bounded source-attributed catalogue-consumer event with static
  classification and numeric counts. Self-declared clientId is never
  authoritative, and other shared-bearer consumers stay unclassified.
  The source design and synthetic regression matrix inform
  [Batch 6](docs/plans/2026-11-16-memory-evolution/BATCH_6.md);
  runtime proofs and deployment identifiers remain private. V-27 stays PARTIAL.
- [ ] 2026-11-19 checkpoint, operations. Use the confirmed known local
  executor event and retain other shared-bearer calls as unknown. The
  ongoing cohort must retain attribution coverage, bounded labels,
  cadence and missing events for the full window. Broader identity
  classes require their own authenticated source.

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
Status: **VERIFIED** · Priority: P1 · Wave: W4 · Owner role: Integration\
Dependencies: ME-04, ME-11, ME-26 · Validation: [V-31](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-31)

- [x] 2026-11-19 qualification. The structured client selected a stable task from its project, kept a project note separate, recovered a stale revision after resume, reused an unchanged retry key and preserved one task with proposed provenance. The authenticated host catalogue refresh was qualified separately.

- [ ] Scope: Update guidance for task reuse, structured resume, scoped captures, explicit project notes, dated observations/volatility and evidence references. Cache identity only; reread before fenced writes.
- [ ] Acceptance: Representative clients follow current contracts; scope/revision/idempotency errors have actionable fixes; connection metadata refresh is documented where needed.
- [ ] Evidence: MCP descriptions and operator documentation specify task reuse, evidence scope, version-fenced details and recovery from invalidated pages. Representative agent use and metadata refresh remain qualification work.

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
Status: **VERIFIED** · Priority: P1 · Wave: W7 · Owner role: Integration\
Dependencies: ME-03 · Validation: [V-41](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-41)

- [x] 2026-11-19 qualification. The authenticated ChatGPT catalogue displayed the updated search tool contract after refresh. Native MCP then exercised linked task and source filters on the deployed build. The tool catalogue stayed at 63 tools and within the existing size cap.

- [ ] Scope: For each release's affected contracts, update public MCP/HTTP documentation, ContextKeep Workflows and relevant UI/host metadata. Prefer additive defaults and versioned resource advertisement when bundled UI changes. Do not wait for unrelated future features.
- [ ] Acceptance: Old clients retain documented behavior; new clients discover fields/tools after required metadata refresh; no silent budget, resource URI or representation change.
- [ ] Evidence: Batch 1 subset: additive search projection, MCP 2.22.0 / schema 19,
  compatibility documentation, compact/legacy reads and 9 host-widget modes
  passed the release checks. Deployed capability discovery confirms the qualified
  build and contract; compatibility duties continue for later programme releases.

### ME-42

**Plan and qualify each staged rollout**\
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: ME-03 · Validation: [V-42](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-42)

- [ ] Scope: For every release, record selected item IDs, server/index/consumer order, mixed-version behavior, canary, feature controls and external repository dependencies.
- [ ] Acceptance: Consumers never require undeployed fields; canary and rollback decisions are explicit; implemented, published and runtime-verified statuses remain separate.
- [ ] Evidence: Batch 1 subset: exact source, required reviews, CI, release manifest and
  rollback plan are qualified. Activation, the deployed canary and independent
  recovery of the candidate-produced snapshot passed. See [release qualification](docs/plans/2026-11-16-memory-evolution/BATCH_1.md#qualified-source-and-reviews).

### ME-43

**Verify migration, index rebuild and recovery**\
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Operations\
Dependencies: ME-01, ME-48 · Validation: [V-43](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-43)

- [ ] Scope: For any affected index/schema release, verify recovery point, compatible runtime/database rollback, bounded backfill, storage reserve and scratch cleanup using established policy.
- [ ] Acceptance: Failure/restart/rollback drill succeeds on isolated data; redaction/delete stay correct; singular writer preserved; code-only work does not create unnecessary production copies.
- [ ] Follow-up: Qualify scheduled-capture readiness across service startup while retaining the exact runtime and SQLite-inode guards; preserve pending ingestion identities during recovery.
- [ ] Evidence: Batch 1 subset: 84 operational tests passed, including 11 new runtime-kit
  identity/layout cases. Isolated snapshot recovery and same-clone candidate
  compatibility passed with cleanup confirmed privately. A subsequent independent
  restore qualified the new candidate-produced snapshot and backup format, with
  matching artifact checksums and cleanup. Broader migration/index drills remain
  applicable to their future releases.

### ME-44

**Complete exact-head reviews and release qualification**\
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
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
- [ ] Batch 3 helper qualification: [PR #29](https://github.com/anervalens-netizen/ContextKeep/pull/29),
  head `16c24a907d46d58da98374c182c86c61b62011e2`, base
  `0356372130661674062996e7cc8ae4ab515a1a13`, passes 49 helper tests.
  [Codex](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6919711553)
  reported no findings;
  [DSH](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920023151)
  reported no confirmed code findings and passed 232 additional assertions.
  Its single low, nonblocking documentation note is addressed by attributing
  the eight base-helper failures to the one named test under ME-02.
  [CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329947)
  and [public-source checks](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329984)
  passed. The complete 196-file private archive was saved and independently
  read back successfully. The [version-bound disposition](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920242721)
  records the immediate wording follow-up, applied in this completion record.
  Grouped review closure was read back. This offline helper change requires
  no application deployment.
- [x] Dependency advisory disposition, 19 November: GitHub marks
  [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
  withdrawn on 16 November and explains its determination in the advisory.
  Closed as withdrawn. No dependency change is required for this advisory.
  The required moderate-or-higher audit remains part of release qualification.

- [x] [PR #38](https://github.com/anervalens-netizen/ContextKeep/pull/38)
  passed [Codex](https://github.com/anervalens-netizen/ContextKeep/pull/38#issuecomment-7002016489),
  [DSH](https://github.com/anervalens-netizen/ContextKeep/pull/38#issuecomment-7002493427),
  [disposition](https://github.com/anervalens-netizen/ContextKeep/pull/38#issuecomment-7002513266),
  [CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/44476839323)
  and all 12 local release stages. The tested tree matches the installed merge
  `6ba457b59b08a2346b268d9be319cad8293b0c21`. Read-only runtime canaries
  verified filters and source detail. Matching recovery for the previous live
  version was proved before activation. The new kit was verified on NAS for
  scheduled capture. The older exception remains in historical review records.

- [x] [PR #39](https://github.com/anervalens-netizen/ContextKeep/pull/39)
  passed [Codex](https://github.com/anervalens-netizen/ContextKeep/pull/39#issuecomment-7002876043),
  [DSH](https://github.com/anervalens-netizen/ContextKeep/pull/39#issuecomment-7003764476),
  [disposition](https://github.com/anervalens-netizen/ContextKeep/pull/39#issuecomment-7003792558),
  [CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/44485054717)
  and all 12 local release stages. The reviewed tree matches the installed
  release `532ce5348be48c95cdba0fa8f9687c2935882d80`. The prior release was exercised from its staged
  kit against the existing compatible nightly SQLite snapshot. No extra
  backup generation was started.

### ME-45

**Measure post-release outcomes against matched baseline**\
Status: **IN_PROGRESS** · Priority: P1 · Wave: W7 · Owner role: Evaluation\
Dependencies: ME-03, ME-44 · Validation: [V-45](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-45)

- [ ] Scope: For each release's affected behavior, compare canary and representative post-release windows for applicable quality, errors, reads, bytes, latency and resources. Control sample/traffic/retention differences and retain failed scenarios. Use bounded evidence before ME-29 exists; the full dashboard is not a prerequisite.
- [ ] Acceptance: Changes and limits are quantified on comparable populations; regressions have dispositions; no selective threshold changes or vendor-score extrapolation.
- [ ] Evidence: [Batch 5](docs/plans/2026-11-16-memory-evolution/BATCH_5.md)
  records a bounded retrospective equal-duration Prometheus/journal comparison
  and a separate, read-only live paired catalogue sample. The natural samples
  have different dayparts and mixed unlabelled consumers; the paired check
  adds observer traffic. Neither alone is a causal post-release gain, a
  provider-cost calculation, nor a representative prospective comparison.
  The exact source queries, window/counter coverage and observations remain
  in private project memory; [V-45](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-45)
  is PARTIAL until the unmatched scenarios and limits are addressed.
- [ ] 2026-11-19 checkpoint, evaluation. Proceed at the matched cohort
  close. Use comparable dayparts and exact request-category denominators,
  including periodic full controls and missing/failed samples. Record
  release and store boundaries and exclude incompatible windows explicitly.

### ME-46

**Keep the private evidence ledger and handoffs complete**\
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: ME-01 · Validation: [V-46](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-46)

- [ ] Scope: Map every audit section/finding to tracker IDs, private source/version evidence and eventual commit/test/deployment references. Preserve concise task-scoped checkpoints and unresolved limits.
- [ ] Acceptance: All audit findings are accounted for without publishing private metrics/identities; handoff points to exact artifacts; planning completion is distinct from feature completion.
- [ ] Evidence: Batch 1 evidence, exact run identities, review closure and recovery receipts
  are preserved in task-scoped private memory. This tracker records sanitized
  scope and public references. Batch 3 adds reviewed corpus/split identities,
  a canonical freeze registry, scorer identity and explicit observation limits;
  the programme-wide ledger remains a rolling duty.

### ME-47

**Regress authority, scope, uncertainty and no-replay invariants**\
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Backend\
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
- [ ] Evidence: [Batch 5](docs/plans/2026-11-16-memory-evolution/BATCH_5.md)
  records the bounded measurement method and stated limitations. The
  [PR #31 observer](https://github.com/anervalens-netizen/ContextKeep/pull/31)
  defines a read-only main/WAL/SHM/index sampling contract with fixed
  classification, restore exclusion and bounded index scans. See
  [Batch 6](docs/plans/2026-11-16-memory-evolution/BATCH_6.md).
  Source checks are not a longitudinal growth trend or a write/lock
  workload. Production observations and backup receipts are retained
  privately; V-48 remains PARTIAL and no infrastructure replacement
  follows from this source-only evidence.
- [ ] 2026-11-19 checkpoint, operations. The hourly read-only observer
  is collecting main, WAL, SHM, index and reserve measurements. The
  scheduled date is only a checkpoint until seven complete days from
  the first qualified timer event are available. Apply the isolated
  read/write/lock workload findings separately and preserve store identity.

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
Status: **VERIFIED** · Priority: P0 · Wave: W7 · Owner role: Maintainer\
Dependencies: none · Validation: [V-50](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-50)

- [ ] Scope: Use this tracker as the only active checklist. Assign actual owners at start; update dependencies, evidence, decisions and status with work. Keep archived trackers historical.
- [ ] Acceptance: No orphan/missing items or invalid dependencies; done requires applicable evidence, deferred/stopped requires rationale; unresolved work is handed off rather than silently omitted.
- [ ] Evidence: Batch 1 source/review/test evidence and remaining work are mapped here and
  in [BATCH_1.md](docs/plans/2026-11-16-memory-evolution/BATCH_1.md). Batch 3 corpus
  preparation, evaluation limits and next priorities are mapped in
  [BATCH_3.md](docs/plans/2026-11-16-memory-evolution/BATCH_3.md).
  All 50 item IDs and dependencies are retained. Programme closure remains open.
- [x] 2026-11-19 tracker qualification, development agent. Checked all
  50 index, detail and validation mappings, the acyclic prerequisite graph,
  and all 20 finding-to-item mappings. Injected a missing validation link,
  an invalid dependency, a missing owner and a premature completion claim.
  Each control was detected. The remaining-work review records the current
  assignees and cohort handoff. This verifies the tracker and handoff
  requirements. Programme closure remains open while further acceptance
  and gated decisions are pending.

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

- **2026-11-16 — Batch 2 forward ingestion verified.** Development agent;
  ME-18 / ME-19 IN_PROGRESS → IMPLEMENTED → VERIFIED. Public preparation is
  linked in [PR #28](https://github.com/anervalens-netizen/ContextKeep/pull/28);
  exact companion source, reviews, deployment and readback receipts remain
  private. The producer passes 99 targeted synthetic tests and the corpus helper
  passes 45 synthetic guard tests. Controlled live readback confirmed attribution,
  preserved legacy payloads/history, current checkpoints and explicit grouped
  disposition. Historical recovery remains partial and the producer reports its
  retained reconciliation backlog explicitly. Scheduled polling resumed through
  the guarded step. One automatic repeat added no captures or dispositions and
  retained the known fence; this does not establish indefinite stability.
  ME-01/02/03 stay open; the 40-question natural corpus remains NOT_RUN and
  canonical freeze registration remains an ME-02 follow-up.

- **2026-11-16 — Batch 3 limited baseline independently verified.** Development
  agent; ME-01 / ME-02 / ME-03 remain IN_PROGRESS. Independent gold/split review
  and canonical registration qualify 40 private formulations from 20 episodes
  before tuning. All 40 fixed observations are collected once. The private scorer
  passes 32 synthetic guard tests; its frozen inputs and existing retrieval
  fixtures/floors remain unchanged. Population/usage evidence retains gaps and
  sampled-counter limits. Final independent verification passes with a
  display-rounding note and no substantive discrepancies; negative outcomes are
  retained. The public helper passes 49 tests, including four new parameterized
  tests for eight explicit truncation flags. The named pre-fix reproduction is
  recorded under ME-02. Both required reviews and CI passed; independent readback
  of the complete 196-file private archive passed. The version-bound disposition
  and grouped review closure are evidenced under ME-44; the wording follow-up is
  applied in this completion record.
  Semantic abstention and agent outcomes are NOT_RUN. Prioritize ME-24 / ME-25
  for a separately qualified implementation.

- **2026-11-16 — Batch 4 started.** Development agent; ME-24 / ME-25
  PLANNED → IN_PROGRESS. The candidate introduces MCP 2.23.0 compact/conditional
  catalogue reads with no schema migration. Authenticated pagination, cache
  recovery, real DB failure detection and periodic full controls define the
  bounded consumer qualification. A synthetic comparison is predeclared;
  passing tests, measured savings, review completion and deployment are not
  asserted by this entry. The programme inventory remains exactly 50 items.

- **2026-11-16 — Batch 4 server qualified.** Development agent; ME-24
  IN_PROGRESS → VERIFIED. PR #30 merged the reviewed head with matching source
  tree. Both reviews, dispositions, CI, all 12 release-gate stages, isolated
  candidate recovery and authenticated deployed full/compact/conditional parity
  passed. The original database and schema 19 are preserved. ME-25 remains
  IN_PROGRESS: its 47 targeted tests and frozen synthetic comparison passed,
  with 90.3789% fewer result bytes and catalogue calls increasing 180 to 195.
  Fresh deployed-release backup recovery also passed independently; companion
  review/release and deployed consumer readback remain open. The inventory is
  26 PLANNED, 6 GATED,
  14 IN_PROGRESS, 0 IMPLEMENTED, 3 VERIFIED and 1 DONE, totaling 50 items.


- **2026-11-16 — Batch 4 controlled consumer qualified.** Development agent;
  ME-25 IN_PROGRESS → VERIFIED within the bounded monitored consumer. PR #53
  passed both exact-head reviews, explicit dispositions, required CI and merge.
  Corrected tests passed (51 catalogue, 148 targeted and 902 full Python).
  A guarded component-only activation retained unrelated integration changes;
  authenticated scheduled full control and later unchanged conditional read
  preserved all 44 projects/five fields. The shared service release proof passed.
  The 90.3789% historical synthetic result was measured on the pre-fix
  consumer source, **not** on the later fixed release; matching natural traffic,
  slow-route budgets, other pipeline stages and broad programme outcomes remain
  separate. The inventory is now 26 PLANNED, 6 GATED, 13 IN_PROGRESS,
  0 IMPLEMENTED, 4 VERIFIED and 1 DONE, totaling 50 items.

- **2026-11-17 — Batch 5 initial observational qualification.** Evaluation
  and operations; ME-45 PLANNED → IN_PROGRESS; ME-48 remains IN_PROGRESS.
  Read-only natural aggregate and live paired catalogue observations passed
  scoped integrity checks, without code or database modification. The former
  cannot attribute a change to one consumer or match the time-of-day mix,
  and the latter is an extra controlled load, not normal traffic. Capacity
  captures one main/WAL/index footprint and existing resource/backup samples,
  not a DB growth trend, lock profile or representative write/backfill result.
  Keep [V-45](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-45)
  and [V-48](docs/plans/2026-11-16-memory-evolution/VALIDATION.md#v-48)
  PARTIAL. Do not widen the 48-second deadline, replace SQLite or claim
  provider/CPU savings without new comparable evidence. New inventory:
  25 PLANNED, 6 GATED, 14 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED and 1 DONE
  (50 total). No Batch 4 deliverable is reopened.

- **2026-11-17 — Batch 6 source qualification and programme status.**
  [PR #55](https://github.com/anervalens-netizen/astancu-website/pull/55)
  and [PR #31](https://github.com/anervalens-netizen/ContextKeep/pull/31)
  contain the bounded executor-attribution and read-only capacity-observer
  implementations and tests. ME-27 moves to IN_PROGRESS; ME-48 and
  ME-45 stay IN_PROGRESS. V-27/V-48 and prospective V-45 remain PARTIAL,
  pending the broader attributable cohorts, source-covered trend and
  isolated backfill/lock contracts. The tracker remains 50 items:
  24 PLANNED, 6 GATED, 15 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED, 1 DONE.
  Actual deployment state and recovery evidence are kept privately.

- **2026-11-17 — Bounded ME-06 / ME-08 source candidate.** Development agent;
  both items move PLANNED → IN_PROGRESS. Synthetic current/history selection,
  authority, exact identifiers, temporal boundaries, saturated candidates and
  read-only negative controls pass, with additive HTTP/MCP ranking metadata.
  The existing held-out quality metrics are unchanged. V-06 and V-08 remain
  PARTIAL pending the wider private evaluation and qualification gates. The
  inventory is 22 PLANNED, 6 GATED, 17 IN_PROGRESS, 0 IMPLEMENTED, 4 VERIFIED,
  1 DONE, totaling 50. No deployment is asserted. Dependency advisory work
  remains a separate external blocker and audit settings are retained.
