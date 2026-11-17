# Batch 6 — source-attributed catalogue monitoring and SQLite capacity observer

Date: 2026-11-17

Scope: **ME-27 / V-27 PARTIAL, ME-48 / V-48 PARTIAL, ME-45 remains IN_PROGRESS**

Predecessors: [Batch 4](BATCH_4.md) and [Batch 5](BATCH_5.md)

## Delivered in a bounded scope

| Component | Source and evidence | Qualified result |
| --- | --- | --- |
| Known local catalogue consumer | [Command Center PR #55](https://github.com/anervalens-netizen/astancu-website/pull/55) | Current-head reviews and CI passed, 907 Python regressions passed, guarded deployment retained unrelated owner integration; a live signed 44-project catalogue and multiple subsequent private-journal observations passed |
| Primary SQLite capacity observer | [ContextKeep PR #31](https://github.com/anervalens-netizen/ContextKeep/pull/31) | Source reviews and full CI passed; guarded install on the primary succeeded, first read-only systemd SQLite/WAL observation passed, hourly timer enabled |
| Backup and health | Existing recovery and owner-health channels | Primary service remained active; independent mirror status continued to report valid SQLite integrity and backup checksums; broader source/owner-health stages remain separate from this observer |
| Public status | [Main tracker](../../../MEMORY_EVOLUTION_TRACKER.md), [validation](VALIDATION.md) | 50 original items preserved; ME-27 moves to IN_PROGRESS, ME-48 stays IN_PROGRESS; neither acceptance gate is prematurely marked complete |

The **known local executor** reports finite full/compact/conditional response
bytes, the corresponding page/restart counts and source mode through the
service-private journal. Its class is assigned by the executor itself, not
from an untrusted MCP clientId or user-agent. The shared upstream MCP bearer
cannot identify individual other consumers; they remain explicitly
**unattributed**. No individual/project/session labels or response payloads
are stored in metrics. The measured traffic does not support a claim about all
MCP clients, total CPU or provider costs.

The SQLite sampler is a separate **read-only, primary-only** observation
component. It does not change ContextKeep's database schema, binary, backup
policy, or MCP transport. It requires an effective read-only mount, verifies
the existing shared restore exclusion lease, bounds expensive index scans,
and emits one private journal event or a generic failure. A stopped WAL
store with an eligible clean main may return an explicit partial file-only
observation: this is **not** a successful database integrity check. A busy,
inaccessible, corrupt/truncated or incompatible store is not reclassified as
healthy. See [capacity observer operational contract](../../../ops/CAPACITY_SAMPLER.md).

## Review and recovery record

The first DSH reviewer for PR #31 failed due to a provider usage limit.
An isolated native DSH DeepSeek read-only recovery reviewer was run against
exact public source identities. Each revised source head was re-reviewed
rather than substituting the old verdict. The last review and source
disposition are retained on [PR #31](https://github.com/anervalens-netizen/ContextKeep/pull/31).
The original failed ticket remains historical evidence; the recovery did
not retroactively turn it into a successful run.

Reviews identified and the corrected tests covered WAL/SHM write hazards,
exclusive restore overlap, busy versus stopped file-only classification,
read snapshot consistency, inaccessible mains, zero-length WAL, empty/corrupt
sidecars and fully truncated or forged short SQLite files. The final scoped
review found no confirmed source defect remaining. Deliberately **not**
claimed: a full SQLite integrity validation inside the observer, indefinite
absence of races on an active filesystem, or a full historical traffic study.

## What must still be measured

- **V-27 remains PARTIAL.** Only the known local executor is source-attributed.
  Expanding attribution needs trustworthy transport/server identity, not a
  client-supplied name. Measure historical label cardinality and journal
  retention before adding classes or reporting all-consumer trends.
- **V-45 remains PARTIAL.** A comparable, prospective same-daypart measurement
  is still required for this known executor. Preserve each actual request
  type, periodic full controls, restarts, errors, elapsed time and missing
  events. Existing retrospective mixed-client percentages are not causal
  production comparisons.
- **V-48 remains PARTIAL.** First service-run SQLite observation and active
  timer are confirmed; the first timer-triggered event and at least one later
  hourly event are separate readback gates. Measure same-store main/WAL/index
  footprint across representative days, with backup identity and journal
  retention. Keep an isolated synthetic write/lock/backfill workload separate
  from the production primary. Do not infer a memory leak, database growth
  or need for a storage migration from one instantaneous reading.

## Operational guardrails and continuation

Keep the timer enabled on the primary only. An operator should disable it
during planned exclusive restores, then restore the timer after the recovery
control passes; its short shared-lease window can otherwise make an exclusive
restore return a retryable conflict. Never enable this timer on a passive
standby or expose the private journal event through a public endpoint.

The verified source, immutable PR/review/CI references and public contracts
belong here. Exact host-specific receipt paths, backup manifest identities,
timestamps, data sizes and private logs are retained in ContextKeep task
evidence. A completed setup is **not** an observed longitudinal result.

Continue with actual scheduled samples and same-cohort outcome evaluation,
then revisit the acceptance gates. The broader 50-item programme is still
in progress, and no Batch 4 functionality is reopened.
