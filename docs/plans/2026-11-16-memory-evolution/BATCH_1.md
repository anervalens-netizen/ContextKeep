# Batch 1: effective task state and release prerequisites

Date: 2026-11-16  
Status: implemented candidate; targeted checks passed; full release qualification pending

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
| Full candidate release gate, independent reviews and CI | Pending in this candidate document |
| Deployed behavior and independent recovery | Pending; private receipts required |

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
