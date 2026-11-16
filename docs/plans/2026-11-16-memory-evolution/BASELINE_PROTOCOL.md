# Memory evolution baseline and first-release protocol

Date: 2026-11-16\
Status: **protocol prepared; execution results must be recorded separately**\
Inspected source: `ab5104186412dd6588bba0d1c6fc93e58ffd31ff`\
Programme: [PLAN.md](PLAN.md) · [validation catalogue](VALIDATION.md) · [tracker](../../../MEMORY_EVOLUTION_TRACKER.md)

## 1. Scope and evidence boundary

This protocol extends the existing evaluation system for ME-01, ME-02 and ME-03.
The first implementation slice is ME-05: expose the effective operational state of
a task in search while preserving its original record and authority. This file is
a protocol, not a claim that a baseline, test, private corpus or deployment passed.

Use synthetic fixtures in public Git. Keep natural questions, operational
identities, exact runtime observations, response bodies and the private evidence
manifest outside public Git. Read production through bounded existing interfaces;
do not clone the production database to construct this benchmark. Public evidence
can point to commits, synthetic test cases and sanitized outcomes.

A completed subset of the baseline can support a specifically documented first
release. It does not complete the programme-wide ME-01/ME-02/ME-03 requirements.
Record the subset, remaining prerequisites and applicable V cases in the tracker.
Any required but unexecuted release check stays NOT RUN or BLOCKED. This protocol
does not waive the repository's [review and release requirements](../../../AGENTS.md).

## 2. What the existing evaluators measure

The inventory below comes from source inspection at the revision above. Numerical
thresholds are code assertions or decision criteria, not newly measured results.

| Existing surface | Inspected coverage | Meaning and limit |
| --- | --- | --- |
| [Main corpus](../../../apps/server/src/evals/ai-memory-corpus.json) and [harness](../../../apps/server/src/evals/ai-memory-harness.ts) | 61 synthetic questions: 25 RO, 36 EN; isolated temporary store; no provider calls | Identity retrieval, evidence-link presence, local latency and local payload size. The report's current candidate is `aiFirst`; top-level legacy fields are retained for compatibility. |
| [Held-out corpus](../../../apps/server/src/evals/ai-memory-heldout.json) and [runner](../../../apps/server/src/evals/ai-memory-heldout.ts) | 63 synthetic questions: 26 RO, 37 EN; 24 tagged `ckr_independent` | Frozen retrieval coverage and semantic/relation decision signals. Query normalization prevents exact normalized duplicates; it does not establish independence of paraphrases or underlying facts. |
| [Resume evaluator](../../../apps/server/src/evals/context-value-resume.ts) and [test](../../../apps/server/test/cv-resume-evaluator.test.ts) | Four preselected synthetic contexts, at 4,000 / 6,000 / 9,500 character ceilings; no provider calls | Explicitly `presentation_fidelity_not_retrieval_benchmark`. Required-string retention and declared read proxies do not measure an agent's answer or task success. |
| [Synthetic fixture](../../../apps/server/src/evals/ai-memory-fixture.ts) | Directly seeded records, sources and evidence links; task status is open, blocked or null | No operational task-progress history. This fixture cannot reproduce an originally blocked task becoming done through valid progress. |
| [Operational regression tests](../../../apps/server/test/consistency-remediation.test.ts), [task navigation](../../../apps/server/test/task-navigation.test.ts) and [dossier tests](../../../apps/server/test/operational-dossier.test.ts) | Effective task state, progress identity, explicit terminal precedence and later follow-up examples | Useful setup patterns and state oracles for the new search contract. These existing tests do not, by themselves, prove search parity. |

The main and held-out runners call the search service directly. They choose
working scope from the case's `working_memory` category and otherwise use
canonical scope. They do not evaluate an agent choosing a scope, the complete MCP
`search_context` representation, or all-scope search behavior.

Existing `currentnessCorrect` means that every expected current record appears
in the top ten and every forbidden record is absent. It does not inspect effective
task state, progress provenance or the answer implied by a returned record.
Existing evidence coverage checks a supporting evidence relation on a retrieved
target; it is not an entailment or independent-corroboration test.

### 2.1 Preserve three different threshold contracts

| Contract | Existing rule | How to use it |
| --- | --- | --- |
| Main synthetic candidate assertions | Recall@10, identity currentness and abstention >= 0.95; exact-identifier Recall@10 = 1; eligible evidence coverage = 1; local p95 < 75 ms | Preserve the assertions in [ai-memory-eval.test.ts](../../../apps/server/test/ai-memory-eval.test.ts). These are main-corpus checks, not live-service SLOs. |
| Frozen held-out non-regression assertions | Overall Recall@10 >= 0.8627; currentness >= 0.5385; eligible evidence coverage >= 0.8571; abstention >= 0.0833 | Preserve [ckr-quality-gate.test.ts](../../../apps/server/test/ckr-quality-gate.test.ts). All 24 independent cases additionally require perfect applicable recall/currentness/evidence or abstention; six are abstention cases. |
| Held-out semantic/relation decision | The runner uses 0.95 for overall and selected category metrics to produce `PILOT_WARRANTED` or `CLOSED_NOT_NEEDED` | These are experiment-decision signals. [ai-memory-heldout.test.ts](../../../apps/server/test/ai-memory-heldout.test.ts) accepts either decision; it does not assert that every metric reaches 0.95. A signal is not authorization or sufficient evidence to start a pilot. |

The held-out file is frozen at SHA-256:

```text
09c419f27eb508786c48fe68db92fc82fd897e1ccd80177e5dd9f276e0c49921
```

ME-05 must not change this corpus, its hash or its quality floors to obtain a pass.
Keep its new task-state contract separate. A successful task-state change does
not establish a retrieval improvement on unrelated paraphrase or source-search
cases. Conversely, an unmet aspirational held-out 0.95 signal is not evidence that
a preserved existing CI floor failed.

## 3. Private baseline manifest

Freeze the following before comparing implementations. Use one private manifest
with a version, content hash, collection time and evidence references.

| Area | Required fields |
| --- | --- |
| Implementation identity | Source commit, dirty paths/diff identity, built shared artifact hash, deployed build/contract/schema versions, client version and discrepancy notes |
| Observation boundary | UTC timestamps, requested timezone, explicit inclusive/exclusive window bounds, collection time, covered duration, migration/reset boundaries and missing periods |
| Corpus identity | Case version/hash, split version/hash, evidence-episode grouping, expected-answer version, fixture clock, allowed history and evaluation surface |
| Collection method | Exact bounded query/tool arguments, applicable scope, limit/budget, continuation/omission flags, output identity and collection errors |
| Population definitions | Records, sources, task progress, handoffs, correlated runs, relations, deltas and volatile records counted separately; event time distinguished from capture time |
| Usage coverage | Exact stored counts distinguished from sampled counter increases; first samples, resets, partial windows and retention gaps explicit |
| Resource conditions | Host role and runtime identity privately, concurrent workload, warm/cold state, repetitions, absolute limits, intended latency comparison and any provider spend cap |
| Decision status | Observed fact, interpretation, unknown and recommendation distinguished; each gate PASS / FAIL / BLOCKED / NOT RUN with its evidence |

A description or checkout is not proof of the active runtime. A successful
transport response is not proof that the tool returned complete context or that
an agent completed its task. No observed usage in a retained window does not mean
a feature has never been used.

For the first release, freeze at least the source/runtime identities, the exact
task-state reproduction, expected state/provenance, read-only probe arguments,
test corpus identities and measurement definitions. Continue collecting the
broader population and usage manifest under ME-01; do not label that whole item
complete from this narrower record.

## 4. Private natural-question corpus design

Target **40 cases**, within the planned 30–50 range. Aim for 20 RO and 20 EN.
The table defines coverage, not actual private questions or known answers.

| Primary coverage group | Target cases | Required distinction |
| --- | ---: | --- |
| Current runtime or migration state | 4 | Current evidence versus an older relevant accepted statement |
| Original task status versus effective progress | 4 | Returned identity versus the task's actual current operational state |
| Explicit closure and later follow-up | 4 | Closed task versus new follow-up; no implicit reopening |
| Authority, scope and provenance | 4 | Accepted knowledge versus proposed observations and their evidence |
| Versioned events and review history | 4 | Current event version versus older version or a different reviewer/head |
| Details present only in sources | 4 | Missing record text versus recoverable source/excerpt evidence |
| Exact identifiers and bounded recovery | 4 | Identifier match, stable recovery pointer and unavailable target |
| RO/EN wording and aliases | 4 | Equivalent intent, diacritics and natural paraphrases |
| Monitoring, blockers and dependencies | 4 | Repetition versus a meaningful change or unresolved next action |
| Unknown information and coverage limits | 4 | Evidence-based abstention, unresolved conflict and missing observations |
| **Total** | **40** | Categories may overlap; assign one primary group for counts. |

Across these groups, include at least six explicit abstention cases and at least
eight operational task-state cases. Secondary tags do not create additional
independent questions.

Use two independent evidence episodes per coverage group where available, with a
RO/EN pair for each episode. Assign one entire episode to development and the
other to held-out: 20 development and 20 held-out cases, each with ten RO and ten
EN. Preserve the question pair on the same side of the split. Do not force these
quotas by inventing private facts or duplicating one underlying episode.

Known failures already used in an audit belong in the development/regression set.
Choose held-out episodes and questions that have not been used to tune the
candidate. If only previously inspected audit examples are available, label them
audit regressions; do not claim independent held-out performance.

### 4.1 Required private case fields

- Stable case ID, corpus version, language, primary group and secondary categories.
- Natural question, intended consumer task and allowed tool/scope contract.
- Underlying evidence-episode/group ID and immutable split assignment.
- Valid answer time, event/effective/capture times where relevant, permitted
  historical scope, and collection time.
- Expected relevant record/source/task identities, plus forbidden or historical
  identities where their exclusion is part of the question.
- Expected original status, effective state, state source, progress identity,
  provenance and resume/recovery pointer for task cases.
- Expected answer claims with supporting evidence and unresolved conflict notes.
- Expected abstention and its reason, rather than an empty relevance list alone.
- Required next action or explicit absence of an action; forbidden actions such
  as replay, implicit acceptance or reopening.
- Measurement eligibility and denominator rules for each score.
- Evidence references, verifier, freeze time and case-content hash.

Verify each expected outcome from its evidence before freezing it. A proposed
agent report remains a proposed report. A newer observation does not automatically
invalidate an older accepted constraint. A missing receipt or telemetry interval
must remain unknown where the evidence cannot establish the answer.

### 4.2 Split and change control

Group all translations, paraphrases, near duplicates and questions about the same
task/fact episode together before assigning splits. Check normalized text, but
also review source/task identities and episode overlap. Exact query uniqueness
alone is insufficient.

Freeze question text, expected identities, time semantics and split membership
before ranking, alias or budget tuning. Do not move a failing held-out case into
development after seeing its score. Correct a mislabeled answer only with an
independent reason, a new corpus version and preservation of the original result.
Mark a held-out set as consumed once its results are used for tuning.

Publish only independently authored synthetic equivalents. Keep private
questions, their operational identifiers and raw outputs in the private ledger.
An artifact hash establishes identity, not correctness or independence.

## 5. Score retrieval, presentation and agent usefulness separately

| Measure | Definition and denominator |
| --- | --- |
| Recall@5 / Recall@10 | Relevant identities retrieved divided by expected relevant identities, per answerable case; macro-average eligible cases and report category/language counts. Report record and source recall separately. Empty-target abstention cases are not recall successes. |
| Identity currentness | Existing current-record presence / forbidden-record absence rule, over cases with a temporal identity oracle |
| Effective task-state correctness | Exact agreement of effective state, state source and relevant progress/state pointers with the frozen operational oracle; compare raw task status separately |
| Scope/provenance fidelity | Whether the returned authority, scope and evidence class remain correct, including an accepted task whose operational progress is proposed |
| Evidence coverage | Retrieved supporting links; separately assess whether answer claims are supported and whether supporting reports derive from distinct primary evidence |
| Presentation fidelity | Required information retained within the stated budget, accurate omissions and usable recovery references |
| Abstention | Correctly unknown among cases that require abstention; also report false abstentions on answerable cases |
| Agent answer/action correctness | A separately executed agent gives the supported answer and selects the permitted next action without forbidden writes, replay or reopening |
| Additional reads / useful-resumption time | Observed tool reads and elapsed time needed to reach the frozen answer/action criterion; local service-call proxies must retain their proxy label |
| Size and cost | Logical structured characters, logical UTF-8 bytes, complete serialized MCP-result UTF-8 bytes, and actual provider tokens/cost recorded as separate quantities |
| Latency and resources | Surface-specific distributions, sample count, warm/cold conditions and matched workload; no live MCP latency claim from a local service timer |

Existing harness `contextBytes` measures its local JSON payload before the MCP
envelope. Existing `toolCallsProxy` counts the harness's direct service calls.
The complete MCP result may contain text serialization and structured data.
Measure the complete result once as serialized; do not infer billed tokens from
characters or bytes. If token receipts are unavailable, tokens and cost are
unmeasured, not zero. The synthetic harness's zero provider calls is a statement
about that harness.

Use matched case/fixture versions, clock, scope, limits and client behavior for
before/after comparisons. Predeclare the number of repetitions and warm/cold
procedure before collecting latency results; do not rerun selectively until the
candidate looks faster. Report all failures, sample sizes and per-case deltas.

Keep the existing local p95 assertion unchanged. Predeclare any additional
absolute latency/resource ceiling and permitted regression in the private
manifest before measuring the candidate. The plan's efficiency targets remain
targets until a feasible matched baseline exists. ME-05 adds truthful metadata;
it does not promise the payload reduction assigned to later budget work.

Agent evaluation requires its own frozen model/version, prompt, tool policy,
input budget, stopping rule, repetitions and spend cap. Keep all operational
actions simulated or read-only. Score against evidence independent of the answer
generator. If no such run occurs, report agent usefulness as NOT RUN even when
retrieval and presentation checks pass.

## 6. ME-05 contract gates

Add a separate synthetic API/MCP regression suite. Create tasks and progress
through existing application interfaces so their real scope, revision and
provenance behavior is exercised. Reuse the state model already covered by
[task navigation](../../../apps/server/test/task-navigation.test.ts),
[consistency remediation](../../../apps/server/test/consistency-remediation.test.ts)
and [usage hardening](../../../apps/server/test/usage-hardening.test.ts).
Do not solve this coverage gap by editing the frozen retrieval fixture.

The search task projection may be an optional nested object. Its concrete DTO
must preserve the following semantics, with original `taskStatus` separately
inspectable. Ordinary actions and non-task records must not acquire invented task
state.

| Case | Required result |
| --- | --- |
| Originally blocked task, then valid done progress | Search agrees with dossier/structured resume on effective done state, state source and progress pointer; raw blocked status is unchanged. |
| Proposed task and working-memory scope | Working/all search exposes correctly labeled operational state; canonical membership and acceptance rules are preserved. |
| Accepted task with proposed operational progress | Accepted record identity/status remain accepted; the progress's separate proposed provenance remains explicit. No implicit promotion occurs. |
| Explicit terminal task status | Existing terminal precedence wins over older or conflicting nonterminal progress. |
| Later checkpoint after closure | Task remains terminal; a follow-up is represented as a follow-up with a usable recovery/resume reference. |
| Invalid, withdrawn or stale progress | Search uses the same admissibility and fallback rules as the existing operational projection. No independent search-specific state algorithm. |
| Non-task action, project note or unknown task role | No fabricated effective task state or cross-task pointer. |
| Scope, filters and bounded results | Project/task scope, canonical/working/all behavior, limits and pagination remain correct. Projection enriches selected eligible hits without widening membership. |
| Compact and legacy response forms | Existing duplicate-alias compatibility remains unchanged except where compact mode already omits it; relevant task metadata is consistent across forms. |
| Multiple eligible task hits | Query work is batched and bounded. Assert the relevant query-count behavior or demonstrate absence of per-hit growth; a compile-only check is insufficient. |
| Read-only parity and recovery | Search, dossier and resume agree; recovery pointers resolve in the same scope; task records, progress and executor/business state are unchanged by reads. |

Predeclare eligible cases and assert **all** of these applicable state, authority,
scope and read-only invariants. Internal telemetry/cache bookkeeping is not a
business-state mutation. Report attention, execution completion and verification
separately from task closure; effective done status alone does not prove every
historical execution is verified.

Use the minimum relevant regression set. Add a failing reproduction on the
unchanged implementation, then run the same scenario against the candidate.
Preserve exact commands, source/diff identity and red/green outcomes. If the old
implementation is not executed, label the evidence source-based rather than
claiming a reproduced baseline failure.

## 7. Existing executable commands

Run from the repository root with its installed toolchain. The commands below
exist at the inspected revision. Their presence here does not mean they were run.

Capture implementation identity:

```sh
git rev-parse HEAD
git status --short
```

Run the main, frozen independent quality and resume-presentation checks:

```sh
pnpm test:focused test/ai-memory-eval.test.ts test/ckr-quality-gate.test.ts test/cv-resume-evaluator.test.ts
```

The quality-gate suite already runs the held-out evaluation and includes a
negative control proving that a degraded independent result fails. If the
held-out corpus validator or decision-shape path is changed, also run:

```sh
pnpm test:focused test/ai-memory-heldout.test.ts
```

Capture the detailed main-corpus report, including `aiFirst`,
`legacyBaseline` and `resumeQuality`:

```sh
pnpm --filter @contextkeep/server eval:ai-memory
```

Run the existing state/scope/compatibility regressions relevant to search
projection changes:

```sh
pnpm test:focused test/search.test.ts test/memory-context.test.ts test/task-navigation.test.ts test/consistency-remediation.test.ts test/usage-hardening.test.ts test/operational-dossier.test.ts test/mcp-result-contract.test.ts
```

The separate [ME-05 regression suite](../../../apps/server/test/search-task-state.test.ts)
was added during this implementation slice. Run the same command for its failing
baseline reproduction and candidate result, with the relevant source/diff identity:

```sh
pnpm test:focused test/search-task-state.test.ts
```

The file existing is not evidence that its cases passed.

The [focused-test helper](../../../scripts/run-focused-tests.mjs) records source
SHA and dirty paths, builds the shared package, records the shared DTO artifact
hash and runs the requested server tests with one worker. Check failures at each
stage. A source SHA alone does not identify uncommitted edits.

The root [package scripts](../../../package.json) also provide `pnpm typecheck`,
`pnpm check:privacy`, `pnpm check:privacy:history`, `pnpm test:functional`,
`pnpm test:performance` and `pnpm release:gate`. Use the repository's applicable
release qualification; this focused protocol does not substitute for required CI,
reviews, deployment verification or recovery readiness.

## 8. Readiness and result recording

For each case or command, record input/fixture version, source and artifact
identity, environment, timestamps, expected and actual outcome, coverage,
limitations and a durable evidence reference. Separate synthetic local evidence
from deployed read-only evidence. Public results must be privacy-safe.

| Work item | Sufficient evidence for the first slice | What remains outside that claim |
| --- | --- | --- |
| ME-01 | Frozen source/runtime identity and precise task-state reproduction manifest | Full population, usage-window and resource baseline until actually collected and verified |
| ME-02 | Frozen ME-05 synthetic cases and privately verified matching questions | The complete 30–50 private-question corpus, independent split and wider source/currentness coverage until completed |
| ME-03 | Existing threshold semantics preserved; task-state gates and relevant measurement protocol fixed before comparison | Broader outcome metrics, worked examples, provider measurements and agent usefulness until evaluated |
| ME-05 | Applicable contract cases pass; original records preserved; review/CI/release and deployed read obligations have evidence | Ranking, source indexing, payload budgets and programme-wide cross-surface currentness work |
| ME-45 / ME-46 / ME-50 | Matched observations, private evidence and tracker updates for this release | Unmeasured post-release benefit and remaining programme work |

Keep ME-01/ME-02/ME-03 IN_PROGRESS while their wider acceptance remains unfinished.
Distinguish ME-05 IMPLEMENTED, VERIFIED and DONE according to the tracker; code
existence is not release completion. A favorable retrieval metric cannot cancel
a state/provenance violation. A passed state contract cannot establish agent task
efficacy or close unrelated programme items.
