import type { ServiceDeps } from "./import.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";

export type RunEvidenceInput = {
  runId: string;
  runRevision: number;
  externalJobId: string | null;
};
type EvidenceRun = {
  id: string;
  projectId: string;
  taskId: string;
  revision: number;
  externalJobId: string | null;
  device: string;
  identity: string;
  status: string;
  inputHash: string;
  criteriaJson: string;
};
type Binding = {
  run_id: string;
  run_revision: number;
  external_job_id: string | null;
  observation_hash: string;
  captured_evidence_hash: string;
};
function readRun(deps: ServiceDeps, runId: string): EvidenceRun | undefined {
  return deps.sqlite
    .prepare(
      `SELECT id,project_id AS projectId,task_id AS taskId,
    revision,external_job_id AS externalJobId,device,identity,status,
    input_hash AS inputHash,criteria_json AS criteriaJson FROM workflow_runs WHERE id=?`,
    )
    .get(runId) as EvidenceRun | undefined;
}
function observationHash(run: EvidenceRun): string {
  // Verification itself increments revision. The execution identity/result does not change.
  return sha256(
    JSON.stringify([
      run.id,
      run.projectId,
      run.taskId,
      run.externalJobId,
      run.device,
      run.identity,
      run.status,
      run.inputHash,
      run.criteriaJson,
    ]),
  );
}
export function validateRunEvidence(
  deps: ServiceDeps,
  projectId: string,
  taskId: string | undefined,
  input: RunEvidenceInput,
) {
  const run = readRun(deps, input.runId);
  if (!taskId || !run || run.projectId !== projectId || run.taskId !== taskId)
    throw new ApiError(
      409,
      "evidence_run_mismatch",
      "Capture run evidence in its exact task and project.",
    );
  if (
    run.revision !== input.runRevision ||
    run.externalJobId !== input.externalJobId
  )
    throw new ApiError(
      409,
      "evidence_receipt_mismatch",
      "Read the current run and its exact executor receipt before capturing evidence.",
    );
  if (
    !["completed", "failed", "cancelled", "lost", "not_started"].includes(
      run.status,
    )
  )
    throw new ApiError(
      409,
      "evidence_run_not_terminal",
      "Read the terminal executor result before capturing verification evidence.",
    );
  return { ...input, observationHash: observationHash(run) };
}
export function bindRunEvidence(
  deps: ServiceDeps,
  recordId: string,
  binding: ReturnType<typeof validateRunEvidence>,
) {
  const capturedProof = proofState(deps, recordId);
  if (!capturedProof?.hasEvidence)
    throw new ApiError(
      409,
      "verification_evidence_missing",
      "Capture evidence before binding its inspected snapshot.",
    );
  deps.sqlite
    .prepare(
      `INSERT OR IGNORE INTO workflow_run_evidence
    (record_id,run_id,run_revision,external_job_id,observation_hash,captured_evidence_hash,captured_at) VALUES(?,?,?,?,?,?,?)`,
    )
    .run(
      recordId,
      binding.runId,
      binding.runRevision,
      binding.externalJobId,
      binding.observationHash,
      capturedProof.hash,
      new Date().toISOString(),
    );
  const saved = deps.sqlite
    .prepare("SELECT * FROM workflow_run_evidence WHERE record_id=?")
    .get(recordId) as Binding;
  if (
    saved.run_id !== binding.runId ||
    saved.run_revision !== binding.runRevision ||
    saved.external_job_id !== binding.externalJobId ||
    saved.observation_hash !== binding.observationHash ||
    saved.captured_evidence_hash !== capturedProof.hash
  )
    throw new ApiError(
      409,
      "evidence_binding_conflict",
      "This report is already bound to another result or inspected proof snapshot. Capture a distinct fresh report.",
    );
}
type ProofRecord = {
  id: string;
  project_id: string;
  evidence_basis: string;
  review_status: string;
  revision: number;
  [key: string]: unknown;
};
type ProofEvidence = {
  excerpt_id: string;
  relation: string | null;
  observed_at: string | null;
  artifact_ref: string | null;
  exact_text_hash: string;
  exact_text: string;
  content_hash: string;
  redaction_state: string;
};
function proofFromRows(
  record: ProofRecord | undefined,
  evidence: ProofEvidence[],
) {
  if (!record) return null;
  // Acceptance alone is not a semantic edit; changed content or evidence still invalidates the snapshot.
  const {
    review_status: _status,
    revision: _revision,
    ...semanticRecord
  } = record;
  return {
    record,
    hasEvidence: evidence.length > 0,
    hash: sha256(JSON.stringify([semanticRecord, evidence])),
  };
}
function proofState(deps: ServiceDeps, recordId: string) {
  const record = deps.sqlite
    .prepare(
      `SELECT id,project_id,type,subject,predicate,value_json,text,
    evidence_basis,review_status,revision,source_event_at FROM records WHERE id=?`,
    )
    .get(recordId) as ProofRecord | undefined;
  if (!record) return null;
  const evidence = deps.sqlite
    .prepare(
      `SELECT re.excerpt_id,re.relation,re.observed_at,re.artifact_ref,
    se.exact_text_hash,se.exact_text,s.content_hash,s.redaction_state FROM record_evidence re
    JOIN source_excerpts se ON se.id=re.excerpt_id JOIN sources s ON s.id=se.source_id
    WHERE re.record_id=? ORDER BY re.excerpt_id`,
    )
    .all(recordId) as ProofEvidence[];
  return proofFromRows(record, evidence);
}
export function verificationProof(
  deps: ServiceDeps,
  runId: string,
  recordId: string,
) {
  const run = readRun(deps, runId)!;
  const binding = deps.sqlite
    .prepare("SELECT * FROM workflow_run_evidence WHERE record_id=?")
    .get(recordId) as Binding | undefined;
  if (!binding)
    throw new ApiError(
      409,
      "verification_evidence_unbound",
      "Capture a new report with runEvidence { runId, runRevision, externalJobId } after inspecting the exact executor receipt.",
    );
  if (
    binding.run_id !== run.id ||
    binding.run_revision !== run.revision ||
    binding.external_job_id !== run.externalJobId ||
    binding.observation_hash !== observationHash(run)
  )
    throw new ApiError(
      409,
      "verification_evidence_stale",
      "Evidence belongs to a different or older run result. Read the run and capture fresh correlated evidence.",
    );
  const proof = proofState(deps, recordId);
  if (
    !proof?.hasEvidence ||
    proof.record.project_id !== run.projectId ||
    proof.record.evidence_basis !== "agent_report" ||
    !["proposed", "accepted"].includes(proof.record.review_status)
  )
    throw new ApiError(
      409,
      "verification_evidence_missing",
      "Verification evidence is unavailable or retracted.",
    );
  if (binding.captured_evidence_hash !== proof.hash)
    throw new ApiError(
      409,
      "verification_evidence_changed",
      "The report or evidence changed since the inspected capture. Inspect and capture a distinct fresh report before verifying.",
    );
  return {
    recordRevision: proof.record.revision,
    evidenceHash: proof.hash,
    observationHash: binding.observation_hash,
  };
}
export type EvidenceValidity = {
  status: "pending" | "valid" | "changed" | "retracted" | "legacy_unbound";
  recordId: string | null;
  verifiedRecordRevision: number | null;
  currentRecordRevision: number | null;
  verifiedAt: string | null;
};
type ValidityRun = {
  id: string;
  revision: number;
  verification: string;
  verificationRecordId: string | null;
};
type VerificationReceipt = {
  run_id: string;
  run_revision: number;
  record_id: string;
  record_revision: number;
  evidence_hash: string;
  observation_hash: string;
  verified_at: string;
};
function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size)
    result.push(values.slice(i, i + size));
  return result;
}
function inClause(count: number) {
  return Array.from({ length: count }, () => "?").join(",");
}
export function currentEvidenceValidityMany(
  deps: ServiceDeps,
  runs: ValidityRun[],
): Map<string, EvidenceValidity> {
  const results = new Map<string, EvidenceValidity>();
  const candidates = runs.filter(
    (run) => run.verification !== "pending" && !!run.verificationRecordId,
  );
  for (const run of runs) {
    results.set(run.id, {
      status: "pending",
      recordId: run.verificationRecordId,
      verifiedRecordRevision: null,
      currentRecordRevision: null,
      verifiedAt: null,
    });
  }
  if (candidates.length === 0) return results;

  const recordIds = [
    ...new Set(candidates.map((run) => run.verificationRecordId!)),
  ];
  const proofRecords = new Map<string, ProofRecord>();
  const proofEvidence = new Map<string, ProofEvidence[]>();
  for (const group of chunks(recordIds)) {
    const records = deps.sqlite
      .prepare(
        `SELECT id,project_id,type,subject,predicate,value_json,text,
      evidence_basis,review_status,revision,source_event_at FROM records
      WHERE id IN (${inClause(group.length)})`,
      )
      .all(...group) as ProofRecord[];
    for (const record of records) proofRecords.set(record.id, record);

    const evidenceRows = deps.sqlite
      .prepare(
        `SELECT re.record_id AS record_id,re.excerpt_id,re.relation,re.observed_at,re.artifact_ref,
      se.exact_text_hash,se.exact_text,s.content_hash,s.redaction_state FROM record_evidence re
      JOIN source_excerpts se ON se.id=re.excerpt_id JOIN sources s ON s.id=se.source_id
      WHERE re.record_id IN (${inClause(group.length)}) ORDER BY re.record_id,re.excerpt_id`,
      )
      .all(...group) as Array<ProofEvidence & { record_id: string }>;
    for (const row of evidenceRows) {
      const { record_id, ...evidence } = row;
      const list = proofEvidence.get(record_id) ?? [];
      list.push(evidence);
      proofEvidence.set(record_id, list);
    }
  }

  const proofs = new Map<string, ReturnType<typeof proofFromRows>>();
  for (const recordId of recordIds)
    proofs.set(
      recordId,
      proofFromRows(
        proofRecords.get(recordId),
        proofEvidence.get(recordId) ?? [],
      ),
    );

  const runIds = [...new Set(candidates.map((run) => run.id))];
  const receipts = new Map<string, VerificationReceipt>();
  const currentRuns = new Map<string, EvidenceRun>();
  for (const group of chunks(runIds)) {
    const receiptRows = deps.sqlite
      .prepare(
        `SELECT run_id,run_revision,record_id,record_revision,evidence_hash,observation_hash,verified_at
      FROM workflow_verification_receipts WHERE run_id IN (${inClause(group.length)})`,
      )
      .all(...group) as VerificationReceipt[];
    for (const receipt of receiptRows)
      receipts.set(`${receipt.run_id}:${receipt.run_revision}`, receipt);

    const runRows = deps.sqlite
      .prepare(
        `SELECT id,project_id AS projectId,task_id AS taskId,
      revision,external_job_id AS externalJobId,device,identity,status,
      input_hash AS inputHash,criteria_json AS criteriaJson FROM workflow_runs
      WHERE id IN (${inClause(group.length)})`,
      )
      .all(...group) as EvidenceRun[];
    for (const current of runRows) currentRuns.set(current.id, current);
  }

  for (const run of candidates) {
    const result = results.get(run.id)!;
    const proof = proofs.get(run.verificationRecordId!) ?? null;
    result.currentRecordRevision = proof?.record.revision ?? null;
    const receipt = receipts.get(`${run.id}:${run.revision}`);
    if (receipt) {
      result.verifiedRecordRevision = receipt.record_revision;
      result.verifiedAt = receipt.verified_at;
    }
    if (
      !proof ||
      !["proposed", "accepted"].includes(proof.record.review_status)
    ) {
      results.set(run.id, { ...result, status: "retracted" });
      continue;
    }
    if (!receipt) {
      results.set(run.id, { ...result, status: "legacy_unbound" });
      continue;
    }
    const current = currentRuns.get(run.id);
    if (
      !current ||
      receipt.record_id !== run.verificationRecordId ||
      !proof.hasEvidence ||
      receipt.evidence_hash !== proof.hash ||
      receipt.observation_hash !== observationHash(current)
    ) {
      results.set(run.id, { ...result, status: "changed" });
      continue;
    }
    results.set(run.id, { ...result, status: "valid" });
  }
  return results;
}
export function currentEvidenceValidity(
  deps: ServiceDeps,
  run: ValidityRun,
): EvidenceValidity {
  return currentEvidenceValidityMany(deps, [run]).get(run.id)!;
}
