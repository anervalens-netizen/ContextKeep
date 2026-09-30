# Execution evidence and current validity

MCP 2.13 adds optional `runEvidence` to `capture_work` and delegated
`capture_working_memory`. Schema 19 stores explicit report/run bindings and
append-only verification receipts. Ordinary project/task captures remain valid
without this field. New `verify_run` calls require a bound report; an unrelated
same-task report is not proof of an execution, even when recently written.

## Capture and verify

1. Read the selected task and its existing run. Do not restart its executor.
2. Inspect the exact executor receipt and relevant output/artifacts.
3. Capture an evidence-linked report in that same project and task with:

```json
{
  "runEvidence": {
    "runId": "11111111-1111-4111-8111-111111111111",
    "runRevision": 4,
    "externalJobId": "synthetic-executor-receipt"
  }
}
```

These values are fictional examples. Read actual identifiers and the current
revision from the run. The server validates the terminal state, project, task,
revision and executor receipt before saving anything. A null `externalJobId`
is supported only when the run itself has no receipt, such as an uncertain/lost
start; it is not a substitute for inspecting a real completed job.

The capture seals the complete inspected report and evidence fingerprint after
all excerpts are attached. A concurrent report edit or evidence addition cannot
be certified by a later verification call, even when the report revision stays
unchanged. Capture a distinct freshly inspected report after a change; an
existing binding is immutable. Owner acceptance alone does not change that
semantic snapshot.

4. Call `verify_run` with the current run revision and the captured report ID.
   This creates an immutable verification receipt containing the run/result
   identity, report revision and evidence fingerprint. Verification increments
   the run revision but does not accept the report or close the task.
5. Read the task again. Report completion separately only when the latest
   verification is passed and its current evidence is valid.

The server establishes correlation, not semantic truth. The agent remains
responsible for inspecting the actual executor result and deciding whether the
stated criteria were met. A timestamp or a report saying “passed” is not a
replacement for that inspection.

## Historical verdict versus current proof

`execution.verification` preserves the historical verdict.
`execution.evidenceValidity.status` reports its present support:

| Status           | Meaning                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `pending`        | No completed verification is recorded.                                               |
| `valid`          | The correlated report and supporting evidence still match the verification receipt.  |
| `changed`        | Report semantics, supporting evidence or executor result changed after verification. |
| `retracted`      | The report is no longer available as proposed/accepted evidence.                     |
| `legacy_unbound` | A historical verdict predates explicit binding; no new binding is fabricated.        |

Owner acceptance alone is not a semantic edit. A changed report body or evidence
set is. Evidence restoration can make an unchanged retained receipt valid again.
Re-verification uses a fresh capture bound to the current run revision and
appends another receipt; previous receipts are retained.

An existing closed task is not silently reopened after migration or evidence
retraction. Its dossier shows the warning. A _new_ successful-completion report
or reported continuation cannot rely on invalid/legacy proof. Inspect the
retained executor receipt, capture correlated evidence and verify again. Do not
re-run the job merely to obtain a fresh identifier.

## Compatibility and errors

Existing ordinary capture payloads and installed application identifiers remain
supported. Clients that verify executions must refresh tool metadata and supply
`runEvidence`; there is deliberately no silent fallback that certifies an old
unrelated report. `verification_evidence_unbound`, `verification_evidence_stale`,
`verification_evidence_changed`,
`evidence_receipt_mismatch` and `evidence_run_mismatch` identify recoverable input
or correlation problems. Read current state and reconcile rather than re-keying
an uncertain mutation. Retrying the same intended write uses the same
idempotency key and identical arguments.

New evidence is still an unreviewed agent report. Run verification, operational
task progress and canonical knowledge remain independent.
