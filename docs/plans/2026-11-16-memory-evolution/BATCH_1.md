# Batch 1: effective task state and release prerequisites

Date: 2026-11-16  
Status: qualified, merged, deployed and recovery-verified; ME-05 DONE

This is a bounded delivery within the [memory evolution programme](../../../MEMORY_EVOLUTION_TRACKER.md).
It addresses ME-05, the task-state subset of ME-09, and the evaluation and recovery
prerequisites relevant to this release. It does not close the wider baseline,
ranking, source indexing or conditional pilot work.

## Problem and resulting behavior

Search returned the task record's original status even when dossier/resume already
derived a different current state from valid progress. A blocked task could
therefore appear blocked in search after an evidence-backed completion report.

The new optional `taskState` includes effective state, state source, progress
identity and provenance, and a read-only resume pointer. The original
`taskStatus`, record review status, evidence basis and freshness remain available.
The PWA shows the effective state, the original status and links to the exact
state/progress records. Proposed progress is visibly proposed.

A dedicated `SearchRecordDto` prevents the projection from being repeated in
unrelated MCP tool schemas. The existing 200,000-byte tool-catalogue gate remains
unchanged. This additive interface is MCP **2.22.0**, schema **19**, with the
existing protocol, contract identifier and panel resource.

## State and scope invariants

- Reuse dossier precedence. Explicit terminal task state retains precedence over
  later open/blocked reports; an audited status change can supersede a report
  about an older task revision. A text/review revision alone is insufficient.
- Preserve the latest valid report even when the task record supplies the winning
  state. Do not transform a proposed report into accepted knowledge.
- Use the existing actual-task classifier, including legacy task identity.
  Evidence-only actions, rejected/superseded records and records without a
  project do not gain a current task projection.
- Keep `progress: null` explicit. Unknown effective state remains unknown,
  including when the inspected task record is available as provenance.
- Preserve current canonical/working/all scope behavior and compact/legacy
  response compatibility. A resume pointer does not reopen or execute anything.
- Preserve business-state tables on read. Existing telemetry/cache bookkeeping
  is a separate concern.

The implementation resolves only selected task IDs, using at most three
additional SQL calls. It does not construct a full dossier per hit. Constant
query count is not a claim of constant latency for arbitrarily large histories;
the existing performance gate and subsequent measured workload work remain
applicable.

For task-record provenance, `recordedAt` carries the task update time, consistent
with dossier. For progress provenance it carries report capture time. The UI
labels these as `task updated` and `report recorded`; neither is event/validity
time.

## Recovery prerequisite

The runtime-kit producer and validator support an explicit application-only
layout for deployments whose transport service is managed separately:

- Producer: `ensure_runtime_kit(..., include_tunnel=False)`.
- Consumer: `validate_runtime_kit(..., expected_tunnel=False)`.
- The manifest declares schema version, full release SHA, Node SHA-256 and exact
  component presence. Its release must match `release/SOURCE_SHA`.
- The application-only mode requires the manifest and rejects tunnel members,
  malformed identity, mismatched Node content and an incompatible existing kit.
- Default legacy behavior still requires the tunnel and accepts compatible
  historical kits. Callers must select the expected layout explicitly.
- A manifest is self-description. Consumers must compare it with an independently
  trusted snapshot/runtime receipt and verify the archive checksum.

This is format/identity support, not proof that any operator's installed backup
job has changed or that production recovery passed. Deployment identity checks,
installation, independent recovery, capacity and private receipts remain
operator qualification duties. Public fixtures contain no production data.

## Targeted verification before the full release gate

| Evidence | Result |
| --- | --- |
| New backend scenarios against the original implementation | 3 failures at the missing projection; dossier preconditions passed |
| New backend projection suite | 8 tests passed |
| Projection + MCP contract suites after schema isolation | 42 tests passed |
| Tool catalogue | 193,305 bytes; unchanged maximum 200,000 |
| PWA task-state, freshness and record-link suites | 14 tests passed, including 5 new task-state cases |
| Server and PWA typecheck | Passed |
| Operational recovery suite | 84 tests passed, including 11 new runtime-kit contract cases |
| Frozen held-out corpus | Unchanged; its existing CI floors are not redefined |
| Full candidate release gate, independent reviews and CI | Passed for the exact candidate; detailed below |
| Isolated snapshot recovery and candidate compatibility | Passed on one restored clone; private receipts retained |
| Deployed MCP contract and original task-state regression | Passed; exact runtime matches the qualified candidate |
| Final candidate-produced snapshot recovery | Passed independently; archive, runtime-kit and receipt checksums matched |

The original global-DTO attempt exceeded the tool-catalogue limit and was
corrected before publication. The gate was not weakened.

Reproducible sources:

- [Search projection](../../../apps/server/src/services/task-search-state.ts)
- [Backend regression cases](../../../apps/server/test/search-task-state.test.ts)
- [PWA component](../../../apps/web/src/components/RecordCard.tsx)
- [PWA regression cases](../../../apps/web/test/search-task-state.test.tsx)
- [Runtime-kit helper](../../../ops/backup-three-hosts.py)
- [Recovery regression cases](../../../ops/test_recovery.py)
- [Release gate](../../../scripts/release-gate.mjs)

## Qualified source and reviews

| Identity | Value |
| --- | --- |
| Reviewed base | `ab5104186412dd6588bba0d1c6fc93e58ffd31ff` |
| Reviewed candidate | `c13f1d6e1efcf1693082c014c66acdcf6ff85c1b` |
| Merged source | `a8fea680edd317db84d0fc6dcb40b241546c540e` |
| Candidate and merge tree | `de2ee4e3263837736a8f7885ba3650e970627ae3` |
| Pull request | [#27](https://github.com/anervalens-netizen/ContextKeep/pull/27), merged 2026-11-16 |

Both required reviews cover the exact candidate/base pair:

- [Codex Connector](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6912299583): no confirmed findings.
- [DSH](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6913356673): no confirmed findings.
- [Development-agent disposition](https://github.com/anervalens-netizen/ContextKeep/pull/27#issuecomment-6913458554): version-bound review decisions published; grouped review closure read back privately.

The source was merged locally with the required noreply identities and normal
privacy/history hooks. The merged tree is identical to the reviewed candidate.
Required [candidate CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43837629676/job/133198112423)
and the applicable public-source checks passed before merge. Both
[main CI](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43847450251)
and [Public source boundary](https://github.com/anervalens-netizen/ContextKeep/actions/runs/43847450334)
then completed successfully for the exact merge revision `a8fea680edd317db84d0fc6dcb40b241546c540e`.

## Full release qualification

All **12 release-gate stages passed** for the reviewed candidate. Counts below
describe synthetic qualification; targeted suites above overlap with these totals.

| Gate | Verified result |
| --- | --- |
| Functional tests | 1,348 passed: 15 shared, 852 server, 481 web |
| Operational tests | 84 passed, including 11 new runtime-kit contract cases |
| Performance gates | 6 passed with their existing thresholds |
| Browser navigation | Widths 390, 768, 1023, 1024 and 1280 passed |
| Offline and storage failure behavior | Replay and denied-storage scenarios passed |
| MCP host widget | All 9 existing modes passed |
| Typecheck, context quality and build | Passed |
| Public-data/history and source-map checks | Passed; no public source maps |
| Tool catalogue | 193,305 bytes; 200,000-byte limit unchanged |
| Dependency policy gate | Passed under its existing policy; one existing LOW advisory remains open |

The candidate frontend was rebuilt with the configured telemetry destination
preserved. Browser and widget checks passed again on that artifact, with synthetic
telemetry intercepted during qualification. This is not proof of production
telemetry delivery and does not replace deployed behavior checks.

### Synthetic performance observations

| Scenario | p95 | Measured repetitions |
| --- | ---: | ---: |
| Project brief | 41.22 ms | 40 |
| Task context | 41.67 ms | 40 |
| Working search | 31.99 ms | 40 |
| Dossier attention | 78.19 ms | 40 |
| Portfolio | 255.44 ms | 20 |
| FTS at 10,000 synthetic records | 20.11 ms | 60 |

These are bounded release-gate observations, not a matched before/after comparison
or a claim that production became faster. The private corpus and ME-45 comparison
remain open.

## Deployment qualification

Private operator evidence confirms isolated recovery of the previous snapshot and
candidate compatibility on the same restored database, with schema and record
counts preserved. Temporary processes, sessions and plaintext restore scratch
were removed, and cleanup was checked independently.

Primary activation passed. Independent runtime identity checks and live MCP
capabilities identify the qualified candidate, MCP 2.22.0 and schema 19. The
original task-state canary now returns the historical blocked status together
with effective completion from a proposed progress report, matching the dossier.
The original record's status and review authority remain intact.

The newly produced candidate snapshot was then mirrored to an independent
recovery target and restored with the exact candidate runtime. Archive,
runtime-kit and receipt checksums matched. Schema compatibility, HTTP and
authentication probes, and cleanup passed. This subsequent drill qualifies the
new backup producer and has no separate candidate-compatibility phase.

The earlier same-clone compatibility comparison and the later recovery of a new
snapshot are distinct observations. Private receipts, host identities, paths
and production data remain outside Git.

## Known limits and next work

External reviewer availability remains an operational dependency. A timeout is
not a code verdict. Both exact-candidate reviews listed above completed and their
dispositions were recorded; no unresolved review gate is carried into this release.
The operational recovery details and follow-up remain private.

An existing LOW dependency advisory remains open:
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
affecting `deepmerge` 4.3.1. The resolved path is in the web build toolchain:
`vite-plugin-pwa` → `workbox-build` → `@rollup/plugin-node-resolve` → `deepmerge`.
It is reached through the web package's development dependencies. No patched
version was reported at qualification. The existing dependency gate passed its
configured policy; the advisory is not claimed resolved, and no unqualified
dependency override was introduced.

The next bounded correctness batch is ME-18/19: reviewer/status attribution and
review event identity with replay safety. Build the private evaluation corpus
alongside it, then measure search/ranking and source coverage before entering
semantic retrieval or graph experiments.

## What remains open

[BASELINE_PROTOCOL.md](BASELINE_PROTOCOL.md) documents the existing evaluation
contracts and the private 40-question design. The full private corpus, independent
split, frozen expected identities and matched outcome measurements remain open.
The known audit failure is a development regression case, not an independent
held-out observation. ME-01/02/03 therefore remain IN_PROGRESS.

Search ranking still determines which records are selected. This release changes
the state supplied with a selected task; it does not establish that every natural
language query finds the right task. Source-only retrieval, multilingual recall,
total context budgets, monitoring summaries and semantic/graph experiments retain
their separate tracker items and gates.
