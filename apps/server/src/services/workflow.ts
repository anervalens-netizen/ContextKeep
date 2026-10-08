import { taskSelectionPredicate, type TaskSelection } from "./task-selection.js";
import { enqueueExecutionEvent } from "./workflow-events.js";
import { taskDossier, getTaskProgress, effectiveTaskState, taskNavigationPage } from "./operational-dossier.js";
import { randomUUID } from "node:crypto";
import { captureWork } from "./capture-work.js";
import { writeAudit } from "./audit.js";
import { runReconciliation } from "./run-reconciliation-read.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { requireTaskScope } from "./task-scope.js";
import { latestCheckpointFor } from "./checkpoint-context.js";
import { getBlockerState } from "./blockers.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { verificationProof, currentEvidenceValidity } from "./run-evidence.js";

export interface WorkflowRun {
  reconciliation?: ReturnType<typeof runReconciliation>;
  id: string;
  projectId: string;
  taskId: string;
  operationKey: string;
  inputHash: string;
  device: string;
  identity: string;
  externalJobId: string | null;
  status: string;
  revision: number;
  leaseToken: string | null;
  leaseUntil: string | null;
  criteriaJson: string;
  verification: string;
  verificationRecordId: string | null;
  createdAt: string;
  updatedAt: string;
}
const columns = `id,project_id AS projectId,task_id AS taskId,operation_key AS operationKey,
 input_hash AS inputHash,device,identity,external_job_id AS externalJobId,status,revision,
 lease_token AS leaseToken,lease_until AS leaseUntil,criteria_json AS criteriaJson,verification,
 verification_record_id AS verificationRecordId,created_at AS createdAt,updated_at AS updatedAt`;
export function getRun(
  deps: ServiceDeps,
  projectId: string,
  taskId: string,
  runId: string,
): WorkflowRun {
  requireTaskScope(deps, projectId, taskId);
  const run = deps.sqlite
    .prepare(
      `SELECT ${columns} FROM workflow_runs WHERE id=? AND project_id=? AND task_id=?`,
    )
    .get(runId, projectId, taskId) as WorkflowRun | undefined;
  if (!run)
    throw new ApiError(
      404,
      "run_not_found",
      "Run does not belong to this task.",
    );
  return { ...run, reconciliation: runReconciliation(deps, run.id) };
}
export function publicRun(run: WorkflowRun) {
  const { leaseToken: _lease, inputHash, criteriaJson, ...result } = run;
  const recoveryIdentity = ["job_start_uncertain", "lost"].includes(run.status)
    ? { operationKey: run.operationKey, inputHash, device: run.device, identity: run.identity }
    : null;
  return { ...result, criteria: JSON.parse(criteriaJson) as string[],
    ...(recoveryIdentity ? { recoveryIdentity } : {}) };
}
type Scope = { projectId: string; taskId: string };
type RunScope = Scope & { runId: string };
export function reserveRun(
  deps: ServiceDeps,
  input: Scope & {
    operationKey: string;
    inputHash: string;
    device: string;
    identity: string;
    criteria: string[];
  },
) {
  return deps.sqlite.transaction(() => {
    requireTaskScope(deps, input.projectId, input.taskId);
    const existing = deps.sqlite
      .prepare(
        `SELECT ${columns} FROM workflow_runs WHERE project_id=? AND task_id=? AND operation_key=?`,
      )
      .get(input.projectId, input.taskId, input.operationKey) as
      WorkflowRun | undefined;
    if (existing) {
      if (
        existing.inputHash !== input.inputHash ||
        existing.device !== input.device ||
        existing.identity !== input.identity ||
        existing.criteriaJson !== JSON.stringify(input.criteria)
      )
        throw new ApiError(
          409,
          "run_operation_conflict",
          "Operation key already identifies different input.",
        );
      return { run: publicRun(existing), replay: true };
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    deps.sqlite
      .prepare(
        `INSERT INTO workflow_runs(id,project_id,task_id,operation_key,input_hash,device,identity,criteria_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.projectId,
        input.taskId,
        input.operationKey,
        input.inputHash,
        input.device,
        input.identity,
        JSON.stringify(input.criteria),
        now,
        now,
      );
    return {
      run: publicRun(getRun(deps, input.projectId, input.taskId, id)),
      replay: false,
    };
  })();
}
export function beginRun(
  deps: ServiceDeps,
  input: RunScope & { revision: number },
) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (run.revision !== input.revision)
      throw new ApiError(
        409,
        "run_revision_conflict",
        "Read the current run revision.",
      );
    if (run.status !== "reserved")
      throw new ApiError(
        409,
        "job_start_uncertain",
        "Start was already reserved. Inspect the executor by operation key; do not replay the effect.",
      );
    const leaseToken = randomUUID(),
      now = new Date(),
      leaseUntil = new Date(now.getTime() + 30000).toISOString();
    // Persist uncertainty BEFORE invoking any external executor. Expiry never authorizes a new start.
    deps.sqlite
      .prepare(
        "UPDATE workflow_runs SET status='job_start_uncertain',revision=revision+1,lease_token=?,lease_until=?,updated_at=? WHERE id=?",
      )
      .run(leaseToken, leaseUntil, now.toISOString(), run.id);
    return {
      run: publicRun(getRun(deps, input.projectId, input.taskId, run.id)),
      leaseToken,
    };
  })();
}
export function attachJob(
  deps: ServiceDeps,
  input: RunScope & {
    leaseToken: string;
    externalJobId: string;
    inputHash?: string;
  },
) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (input.inputHash && run.inputHash !== input.inputHash)
      throw new ApiError(
        409,
        "run_input_conflict",
        "Executor input differs from the reserved operation hash.",
      );
    if (run.leaseToken !== input.leaseToken)
      throw new ApiError(
        409,
        "run_lease_conflict",
        "The start reservation belongs to another attempt.",
      );
    if (run.externalJobId) {
      if (run.externalJobId !== input.externalJobId)
        throw new ApiError(
          409,
          "run_job_conflict",
          "Run already has another executor job.",
        );
      return { run: publicRun(run) };
    }
    if (run.status !== "job_start_uncertain")
      throw new ApiError(
        409,
        "run_state_conflict",
        "Run cannot attach a job in this state.",
      );
    deps.sqlite
      .prepare(
        "UPDATE workflow_runs SET external_job_id=?,status='running',revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(input.externalJobId, new Date().toISOString(), run.id);
    return {
      run: publicRun(getRun(deps, input.projectId, input.taskId, run.id)),
    };
  })();
}
export type ReconcileUncertainRunInput = RunScope & {
  revision: number;
  operationKey: string;
  inputHash: string;
  device: string;
  identity: string;
  disposition: "attached" | "not_started" | "lost";
  externalJobId: string | null;
  evidenceText: string;
  evidenceSource: string;
  observedAt: string;
};
/** Records an inspected caller conclusion, never invokes an executor or grants a new start. */
export function reconcileUncertainRun(deps: ServiceDeps, input: ReconcileUncertainRunInput, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (run.revision !== input.revision)
      throw new ApiError(409, "run_revision_conflict", "Read the exact current run revision before reconciliation.");
    const lateLostReceipt = run.status === "lost" && run.externalJobId === null &&
      run.reconciliation?.disposition === "lost" && input.disposition === "attached";
    if ((run.status !== "job_start_uncertain" && !lateLostReceipt) || run.externalJobId !== null)
      throw new ApiError(409, "run_state_conflict",
        "Only an uncertain start, or a previously reconciled lost start with a newly discovered exact receipt, can be reconciled.");
    if (run.operationKey !== input.operationKey || run.inputHash !== input.inputHash || run.device !== input.device || run.identity !== input.identity)
      throw new ApiError(409, "run_identity_conflict", "Reconciliation requires the exact reserved operation, input hash, device and identity.");
    if (!["attached", "not_started", "lost"].includes(input.disposition) ||
      (input.disposition === "attached" ? !input.externalJobId?.trim() : input.externalJobId !== null) ||
      !input.evidenceText.trim() || !input.evidenceSource.trim() || !Number.isFinite(Date.parse(input.observedAt)))
      throw new ApiError(400, "run_reconciliation_evidence_required", "Supply an explicit conclusion and inspected evidence/source/time; attach only an exact existing receipt. Missing bounded history is not evidence of non-start.");
    const status = input.disposition === "attached" ? "running" : input.disposition;
    const evidence = captureWork(deps, {
      projectId: input.projectId, taskId: input.taskId,
      outcome: `Caller reconciled uncertain run ${run.id} as ${input.disposition}.`,
      evidenceText: input.evidenceText, title: "Uncertain run reconciliation", eventAt: input.observedAt,
      recordType: "fact", subject: "run-reconciliation", progressUpdates: [],
      predicate: "run_reconciliation",
      structuredValueJson: { kind: "run_reconciliation", ...input },
      dedupIdentity: `run-reconciliation:${run.id}:${run.revision}`,
    }, ctx);
    const updated = deps.sqlite.prepare(`UPDATE workflow_runs SET status=?,external_job_id=?,
      verification='pending',verification_record_id=NULL,lease_token=NULL,lease_until=NULL,
      revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status=?`)
      .run(status, input.externalJobId, new Date().toISOString(), run.id, input.revision, run.status);
    if (updated.changes !== 1) throw new ApiError(409, "run_revision_conflict", "Run changed during reconciliation.");
    writeAudit(deps.db, { ...ctx, action: "run.reconciled", targetType: "workflow_run", targetId: run.id,
      before: { status: run.status, revision: run.revision, externalJobId: run.externalJobId },
      after: { disposition: input.disposition, revision: run.revision + 1, externalJobId: input.externalJobId, evidenceRecordId: evidence.outcome.recordId },
      detail: { projectId: input.projectId, taskId: input.taskId, operationKey: input.operationKey,
        inputHash: input.inputHash, device: input.device, identity: input.identity,
        evidenceSource: input.evidenceSource, evidenceText: input.evidenceText, observedAt: input.observedAt, executionStarted: false },
    });
    return { run: publicRun(getRun(deps, input.projectId, input.taskId, run.id)),
      evidenceRecordId: evidence.outcome.recordId, executionStarted: false, acceptedTaskUnchanged: true };
  })();
}
export type ObservationInput = RunScope & {
  eventKey: string;
  externalJobId: string;
  device: string;
  identity: string;
  status: "completed" | "failed" | "cancelled" | "lost";
  exitCode: number | null;
  observedAt: string;
};
/** MCP observations are UTC ISO instants. Retain arbitrary fractional precision:
 * Date.parse would collapse distinct sub-millisecond events. Do not rewrite raw
 * payloads/rows, which are part of immutable observation hashes and retries. */
function observationTimeKey(value: string): string {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return `${seconds}.${fraction.replace(/0+$/, "")}`;
}
export function observeRun(deps: ServiceDeps, input: ObservationInput) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (
      run.externalJobId !== input.externalJobId ||
      run.device !== input.device ||
      run.identity !== input.identity
    )
      throw new ApiError(
        409,
        "run_job_conflict",
        "Observation does not identify this executor job.",
      );
    const hash = sha256(
      JSON.stringify([
        input.externalJobId,
        input.device,
        input.identity,
        input.status,
        input.exitCode,
        input.observedAt,
      ]),
    );
    const prior = deps.sqlite
      .prepare(
        "SELECT input_hash AS hash FROM workflow_observations WHERE run_id=? AND event_key=?",
      )
      .get(run.id, input.eventKey) as { hash: string } | undefined;
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(
          409,
          "observation_conflict",
          "Event key has different content.",
        );
      return { run: publicRun(run), duplicate: true };
    }
    // A late observation may refine a lost result; older/conflicting terminal facts remain in the journal.
    const previous = deps.sqlite
      .prepare(
        "SELECT observed_at AS at FROM workflow_observations WHERE run_id=? ORDER BY rtrim(observed_at, 'Z') DESC LIMIT 1",
      )
      .get(run.id) as { at: string } | undefined;
    const id = randomUUID(),
      now = new Date().toISOString();
    deps.sqlite
      .prepare("INSERT INTO workflow_observations VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        run.id,
        input.eventKey,
        hash,
        input.status,
        input.exitCode,
        input.observedAt,
        now,
      );
    const apply = !previous || observationTimeKey(input.observedAt) > observationTimeKey(previous.at);
    if (apply)
      deps.sqlite
        .prepare(
          "UPDATE workflow_runs SET status=?,verification='pending',verification_record_id=NULL,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(input.status, now, run.id);
    const updated = getRun(deps, input.projectId, input.taskId, run.id);
    if (apply)
      enqueueExecutionEvent(
        deps,
        {
          projectId: input.projectId,
          taskId: input.taskId,
          runId: run.id,
          revision: updated.revision,
          status: input.status,
          verification: "pending",
        },
        input.observedAt,
        input.eventKey,
      );
    return {
      run: publicRun(updated),
      duplicate: false,
      applied: apply,
      observationId: id,
    };
  })();
}
export function verifyRun(
  deps: ServiceDeps,
  input: RunScope & {
    revision: number;
    recordId: string;
    verdict: "passed" | "failed";
  },
) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (run.revision !== input.revision)
      throw new ApiError(
        409,
        "run_revision_conflict",
        "Read the latest run before verifying.",
      );
    if (!["completed", "failed", "cancelled", "lost", "not_started"].includes(run.status))
      throw new ApiError(
        409,
        "run_not_terminal",
        "Read the executor result before verification.",
      );
    if (input.verdict === "passed" && run.status !== "completed")
      throw new ApiError(
        409,
        "run_not_successful",
        "Unknown or unsuccessful execution cannot be verified as passed.",
      );
    const evidence = deps.sqlite
      .prepare(
        `SELECT r.id FROM records r JOIN workflow_task_records tr ON tr.record_id=r.id
   WHERE r.id=? AND tr.task_id=? AND r.project_id=? AND r.evidence_basis='agent_report'
   AND r.review_status IN ('proposed','accepted') AND EXISTS(SELECT 1 FROM record_evidence re WHERE re.record_id=r.id)`,
      )
      .get(input.recordId, input.taskId, input.projectId);
    if (!evidence)
      throw new ApiError(
        409,
        "verification_evidence_missing",
        "Capture verification evidence in this same task first.",
      );
    const proof = verificationProof(deps, run.id, input.recordId);
    const verifiedAt = new Date().toISOString();
    deps.sqlite
      .prepare(
        "UPDATE workflow_runs SET verification=?,verification_record_id=?,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(input.verdict, input.recordId, verifiedAt, run.id);
    deps.sqlite.prepare(`INSERT INTO workflow_verification_receipts
      (run_id,run_revision,record_id,record_revision,evidence_hash,observation_hash,verdict,verified_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(run.id,run.revision+1,input.recordId,proof.recordRevision,proof.evidenceHash,proof.observationHash,input.verdict,verifiedAt);
    return {
      run: { ...publicRun(getRun(deps, input.projectId, input.taskId, run.id)),
        evidenceValidity: currentEvidenceValidity(deps, getRun(deps, input.projectId, input.taskId, run.id)) },
      taskUpdated: false,
    };
  })();
}
export function getTaskView(
  deps: ServiceDeps,
  input: Scope & { offset?: number; limit?: number },
) {
  const task = requireTaskScope(deps, input.projectId, input.taskId),
    limit = input.limit ?? 20,
    offset = input.offset ?? 0;
  const total = (
    deps.sqlite
      .prepare("SELECT count(*) AS n FROM workflow_runs WHERE task_id=?")
      .get(input.taskId) as { n: number }
  ).n;
  const runs = (
    deps.sqlite
      .prepare(
        `SELECT ${columns} FROM workflow_runs WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(input.taskId, limit, offset) as WorkflowRun[]
  ).map(run => ({...publicRun(run),reconciliation:runReconciliation(deps,run.id),evidenceValidity:currentEvidenceValidity(deps,run)}));
  const records = deps.sqlite
    .prepare(
      `SELECT r.id,r.text,r.subject,r.review_status AS reviewStatus,r.evidence_basis AS evidenceBasis,r.recorded_at AS recordedAt,r.revision
 FROM records r JOIN workflow_task_records tr ON tr.record_id=r.id WHERE tr.task_id=?
 ORDER BY r.recorded_at DESC,r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(input.taskId, limit, offset);
  const totalRecords = (
    deps.sqlite
      .prepare(
        "SELECT count(*) AS n FROM workflow_task_records WHERE task_id=?",
      )
      .get(input.taskId) as { n: number }
  ).n;
  return {
    task,
    dossier: taskDossier(deps, input.projectId, input.taskId),
    latestCheckpoint: latestCheckpointFor(
      deps.db,
      input.projectId,
      input.taskId,
    ),
    blockers: getBlockerState(deps, input.projectId, {
      taskId: input.taskId,
      limit,
      offset,
    }),
    runs,
    records,
    pagination: {
      totalRuns: total,
      totalRecords,
      offset,
      limit,
      nextOffset:
        offset + limit < Math.max(total, totalRecords) ? offset + limit : null,
    },
    semantics:
      "Execution completion, verification and task progress are separate. Reports remain unreviewed unless explicitly accepted.",
  };
}
export function listTasks(
  deps: ServiceDeps,
  projectId: string,
  offset = 0,
  limit = 50,
  selection: TaskSelection = "all_actions",
  q?: string,
  view?: "recent" | "attention" | "active",
) {
  if(view) return taskNavigationPage(deps,projectId,offset,limit,selection,view,q);
  const query = q?.trim();
  const search = query ? " AND instr(lower(r.subject),lower(?)) > 0" : "";
  const parameters = query ? [projectId, query] : [projectId];
  const selected = taskSelectionPredicate(selection);
  const rows = deps.sqlite
    .prepare(
      `SELECT id,project_id AS projectId,subject,text,task_status AS taskStatus,review_status AS reviewStatus,revision FROM records r WHERE project_id=? AND type='action' AND review_status IN ('accepted','proposed') AND ${selected}${search} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
    )
    .all(...parameters, limit, offset);
  const total = (
    deps.sqlite
      .prepare(
        `SELECT count(*) AS n FROM records r WHERE project_id=? AND type='action' AND review_status IN ('accepted','proposed') AND ${selected}${search}`,
      )
      .get(...parameters) as { n: number }
  ).n;
  return {
    selection,
    items: rows.map((row) => {
      const r = row as { id: string; taskStatus: string | null; revision: number };
      const operationalProgress = getTaskProgress(deps, r.id);
      const state = effectiveTaskState(deps, r, operationalProgress);
      return { ...r, operationalProgress, effectiveState: state.state, stateSource: state.stateSource };
    }),
    total,
    offset,
    limit,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
