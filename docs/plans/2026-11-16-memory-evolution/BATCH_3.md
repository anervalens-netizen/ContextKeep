# Batch 3: private corpus and descriptive baseline

Date: 2026-11-16\
Programme items: ME-01 / ME-02 / ME-03; evidence for ME-24 / ME-25 / ME-44 / ME-46 / ME-48 / ME-50\
Accountable role: development agent; independent gold and split review

## Status and scope

**The private corpus freeze and limited measured baseline are independently
verified. All 40 predeclared live observations were collected once, with failures
retained. The public helper passes 49 tests; both required reviews and CI passed.
The complete private archive passed independent readback. The version-bound
disposition is recorded and grouped review closure was read back.**
The broader ME-01 / ME-02 / ME-03 items remain IN_PROGRESS. This batch prepares
and measures a descriptive baseline. The bounded offline preflight correction
passed its technical qualification. Application runtime, ranking, aliases, production
configuration and existing synthetic retrieval quality floors remain unchanged;
no application deployment is required.

The inspected public source baseline is
`0356372130661674062996e7cc8ae4ab515a1a13`. Exact source/runtime differences,
built-artifact identity, collection windows and operational receipts are retained
in the private manifest. The
[baseline protocol](BASELINE_PROTOCOL.md) remains the governing protocol; the
[public preflight helper](../../../scripts/evaluation/README.md) is the target
of the bounded completeness correction described below. The private helper copy,
scorer and corpus used for the measurement remain frozen.

| Component | Qualified scope | Remaining limit |
| --- | --- | --- |
| Natural corpus | 40 reviewed formulations from 20 real evidence episodes; canonical first freeze registered privately before tuning | A purpose-selected test set, not a sample of observed user queries |
| Independent review | Gold claims, authority, temporal scope and split separation reviewed independently of retrieval results | Hashes and structural validation do not replace semantic review |
| Population and usage collection | Retained populations and stored activity separated from sampled counter increases; gaps and resets recorded | No complete historical call ledger or continuous resource history claimed |
| Private offline scorer | 32 synthetic guard tests and independent code review; exact input/hash and observed-field contracts | These tests do not establish retrieval quality or useful agent outcomes |
| Live tool observations | All 40 fixed contracts collected once; independent verification passes with a display-rounding note and no substantive discrepancies; retrieval misses retained; complete archive independently read back | A limited descriptive baseline; agent outcomes remain unmeasured |
| Public preflight correction | Eight explicit source-backed truncation flags: two freshness-reference flags and six packing flags on allowed read-tool responses; 49 tests, both required reviews and CI pass | Offline guard qualification does not establish runtime or agent outcomes |
| Agent evaluation | NOT_RUN | Answer/action correctness, semantic abstention and useful-resumption time need a separate run |

## Corpus identity and independence

The questions are investigator-authored natural-language formulations grounded
in actual evidence. They are explicitly labeled as such and are not reported as
historical user utterances or usage logs. The frozen corpus contains:

- 20 Romanian and 20 English formulations, paired by evidence episode.
- 10 development and 10 held-out episodes: 20 cases in each split.
- Four cases in each of the protocol's ten coverage groups.
- Six explicit abstention cases and ten operational task-state cases.
- 37 selected complete evidence captures, with full MCP envelopes and hashes.

Each translation pair remains on one side of the split. Separate review checks
question, intent, task/source identity and semantic episode overlap. Known audit
examples remain in development. The private registry preserves the first approved
freeze, case/split hashes, review bindings and held-out exposure history. Changing
an output filename cannot reset that identity. An independently justified label
correction requires a new version and retention of the original result.

The 40 formulations represent **20 episodes**, not 40 independent observations.
Development and held-out cases have different project distributions and content
density. Their source-only cases also use different surfaces: search versus a
direct source read with a supplied identity. Split score differences therefore
do not isolate generalization quality. Project and scope selection are supplied
by the evaluator; agent selection and planning are not measured.

Source-only details are absent from a record's short text. They can still appear
in its bounded supporting evidence as well as in a direct `get_source` response.
These recovery paths do not establish ranked source discovery.

### Completeness review and guard correction

Independent review found two candidate captures with truncated supplementary
freshness-reference lists. Those captures were retained outside the gold set and
replaced by complete original-source captures before the freeze. Claims were
narrowed where a source alone could not establish a record's accepted status.
No flag was removed and no validator assertion was weakened.

The baseline public helper's enumerated completeness checks did not cover
`supportReferencesTruncated` and `possiblyRelatedReferencesTruncated` in freshness
reference summaries. **ME-02 includes a bounded correction** covering these two
fields and six explicit packing flags on allowed read-tool responses. The eight
source-backed guards reject true or malformed values while retaining valid
boolean false values. The helper passes 49 tests. Four new parameterized tests
cover all eight flags for true, false, invalid types and fail-closed freeze
behavior. The single test `test_known_nested_truncation_flags_block_gold`
reproduced eight failing subtests against the base helper. This is the result
of that test, not the aggregate for all four added tests. The required reviews
and CI passed; the documentation precision note is addressed by this wording.
The private baseline helper, scorer, corpus and measured outputs are not changed
to apply this later correction. A structural READY result remains insufficient
without independent examination of all relevant completeness metadata. A terminal
excerpt page supports only the reviewed claim scope; it is not proof that all
project or evidence history was returned.

## Frozen observation method

The predeclaration fixes 38 `search_context` invocations and two `get_source`
invocations, one observation per case, in a fixed sequential order. It specifies
the exact queries, project/scope choices, history flags and limits before any
retrieval observations. There is no warmup or automatic query retry. Production
cache state and concurrent workload are uncontrolled. Failed or weak results
must remain in the report; they do not authorize a corrected query or selective
rerun.

The private scorer consumes captured envelopes offline. It checks frozen corpus,
case, split, evaluator and capture hashes, requires one observation per case,
and rejects changed tool arguments. It adapts the existing record-recall formula
to the MCP `recordId` representation. A frozen identity selector locates the
observed hit before field assertions; a fixed numeric rank or unrelated hit
cannot substitute for the relevant entity. Missing values remain distinct from
explicit nulls and JSON types are preserved.

| Measure | Meaning in this batch |
| --- | --- |
| Record Recall@5 / @10 | Macro-average target identity recall over eligible answerable search cases in the declared canonical or working ranked list; empty-target abstention cases are ineligible |
| Identity currentness | All expected current identities present and no forbidden identity in the declared top ten; separate from task state |
| Task state | Exact agreement of ten frozen fields, including original status, effective state/source, progress identity, separate authority and resume pointer |
| Provenance and presentation | Exact frozen-field fidelity on the selected entity; not semantic entailment or agent success |
| Source Recall@5 / @10 | NOT_APPLICABLE: current MCP search does not expose a ranked source array |
| Direct source read | Recovery of a known source and its representation/provenance; not source discoverability or ranked recall |
| Size | Unicode code points, UTF-16 units, logical UTF-8 bytes and complete serialized MCP-result bytes remain separate |
| Invocation duration | Client wall-clock time around the tool call, including scheduling and transport; descriptive, not monotonic server timing or a live SLO |
| Semantic abstention and agent outcomes | NOT_RUN; an empty search result is not a verified unknown answer |
| Provider tokens and cost | Unknown/null; never derived from characters, bytes or a successful tool response |

Planned eligible counts, scorable counts, unscorable failures and per-case results
remain visible. Canonical and working arrays are not concatenated into an
invented global rank. Bounded-search continuation or saturation flags can coexist
with an observed top-ten score; they do not make the response complete gold
evidence or establish global absence.

Final independent numerical verification at 2026-11-16 14:37:11Z returned
`PASS_WITH_DISPLAY_ROUNDING_NOTE`, with no substantive discrepancies across
frozen contracts, captures, per-case metrics and serialization sizes, and no
missing invocation. The baseline retains scoped retrieval misses and
older-review distractors. Task-state
and provenance failures arose when the relevant target was absent; the evaluated
fields were correct on every returned relevant target. Missing-hit failures do
not establish a metadata regression, and exact field fidelity does not establish
semantic entailment.

Task gold and task search share the application's operational-state logic. Their
agreement measures representation fidelity, not an independent proof of that
underlying algorithm. The existing synthetic task-state controls remain relevant.
The private scorer's 32 tests are separate from the public helper's 49 guard
tests, comprising the existing 45 and four new parameterized tests. Required
reviews and CI passed for the helper correction separately; existing retrieval
fixtures and quality floors remain unchanged.

## Population, usage and next work

The private audit uses bounded reads and separates records, sources, task progress,
handoffs, correlated runs, relations, cursors and volatile records. Creation/import
timestamps describe retained stored activity. They do not count user sessions,
tool calls or automatically approved knowledge. Sampled counter increases retain
their estimation label, reset behavior, first-sample limits and actual coverage.
Missing telemetry is not filled with zero activity. Point resource observations
do not establish growth trends or a need to replace the storage engine.

The covered samples identify catalogue payload as a strong optimization target.
Prioritize the compact/conditional catalogue contract in ME-24 and a controlled
consumer examination in ME-25. Historical tool labels do not establish which
consumer generated every call. Qualification must preserve authenticated
application/database checks and measure matched before/after behavior. Keep
exact error-code/consumer attribution and retention decisions under ME-26–ME-29;
this batch does not implement those changes.

Remaining evaluation work includes synthetic counterparts for additional natural
episodes, matched candidate comparisons, and a separately frozen agent-evaluation
contract. Source discovery requires its own supported retrieval surface. Mark held-out results
consumed when they are used for tuning; do not describe the same set as independent
after that point.

## Review, CI and evidence qualification

The reviewed candidate is [PR #29](https://github.com/anervalens-netizen/ContextKeep/pull/29),
head `16c24a907d46d58da98374c182c86c61b62011e2` against base
`0356372130661674062996e7cc8ae4ab515a1a13`.

- [Codex review](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6919711553)
  reported no findings.
- [DSH review](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920023151)
  reported no confirmed code findings and passed 232 additional assertions.
  Its single low, nonblocking documentation precision note concerned the scope
  of the eight failing pre-fix subtests; the named-test wording above addresses it.
- [CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329947)
  and [public-source checks](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43889329984)
  passed for the candidate.
- The complete 196-file private archive was saved to private backup storage and
  independently read back successfully. Its contents, hashes and paths remain
  private.
- The [version-bound disposition](https://github.com/anervalens-netizen/ContextKeep/pull/29#issuecomment-6920242721)
  records the immediate wording follow-up, applied in this completion record.
  Grouped review closure was read back separately from PR merge state.

ME-44 also retains a pre-existing low dependency follow-up for `deepmerge`:
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).
Runtime exposure is unverified and no patched version is listed in the checked
advisory evidence. The CI audit threshold is `moderate`; a passing run does not
resolve a low advisory. Triage and any remedy remain separate from this helper
change and are tracked under existing programme items.

## Evidence boundary

Private questions, operational identities, raw responses, per-case scores,
measurements and manifests remain outside public Git. The public repository
records only scope, methods, synthetic checks and sanitized dispositions.
The 40 observations and independently verified metrics are retained with their
negative outcomes. Complete archive readback, required reviews and CI are
confirmed above. The version-bound disposition and grouped review closure are
evidenced separately; the wording follow-up is applied in this completion record.
Programme-wide completion and production improvement remain separate claims.
