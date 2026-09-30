import { currentEvidenceValidity } from "./run-evidence.js";
import { randomUUID } from "node:crypto";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { requireTaskScope } from "./task-scope.js";
import { captureWork } from "./capture-work.js";
import { getRun } from "./workflow.js";
import { effectiveTaskState, getTaskProgress, latestTaskValue } from "./operational-dossier.js";
import { ApiError } from "../lib/errors.js";

type Scope = { projectId: string; taskId: string };
export type ContinuationMode =
  "off" | "verify_and_report" | "continue_authorized";
export function setContinuationPolicy(
  deps: ServiceDeps,
  input: Scope & {
    expectedPolicyRecordId: string | null;
    mode: ContinuationMode;
    objective: string;
    evidenceText: string;
  },
  ctx: ActorCtx,
) {
  return deps.sqlite.transaction(() => {
    requireTaskScope(deps, input.projectId, input.taskId);
    const prior = latestTaskValue(deps, input.taskId, "continuation_policy");
    if ((prior?.recordId ?? null) !== input.expectedPolicyRecordId)
      throw new ApiError(
        409,
        "continuation_policy_conflict",
        "Read the current policy before updating it.",
      );
    const revision = prior
      ? Number(JSON.parse(prior.valueJson).revision) + 1
      : 1;
    const value = {
      kind: "continuation_policy",
      taskId: input.taskId,
      revision,
      mode: input.mode,
      objective: input.objective,
      previousRecordId: prior?.recordId ?? null,
    };
    const capture = captureWork(
      deps,
      {
        ...input,
        outcome: `Continuation ${input.mode}: ${input.objective}`,
        title: "Task continuation configuration",
        eventAt: null,
        recordType: "fact",
        subject: "continuation-policy",
        progressUpdates: [],
        structuredValueJson: value,
        dedupIdentity: `continuation-policy:${input.taskId}:${revision}`,
      },
      ctx,
    );
    return {
      policy: { ...value, recordId: capture.outcome.recordId },
      requiresNativeSubscription: input.mode !== "off",
      subscriptionCreated: false,
      semantics:
        "Policy configuration is not a host subscription and starts no execution.",
    };
  })();
}
interface ClaimRow {
  runId: string;
  runRevision: number;
  consumerId: string;
  token: string;
  status: string;
  leaseUntil: string;
  resultRecordId: string | null;
  result: string | null;
}
function claimRow(deps: ServiceDeps, runId: string, revision: number) {
  return deps.sqlite
    .prepare(
      `SELECT run_id AS runId,run_revision AS runRevision,consumer_id AS consumerId,
    token,status,lease_until AS leaseUntil,result_record_id AS resultRecordId,result
    FROM workflow_continuations WHERE run_id=? AND run_revision=?`,
    )
    .get(runId, revision) as ClaimRow | undefined;
}
export function claimContinuation(
  deps: ServiceDeps,
  input: Scope & {
    runId: string;
    runRevision: number;
    consumerId: string;
  },
) {
  return deps.sqlite.transaction(() => {
    const task = requireTaskScope(deps, input.projectId, input.taskId);
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    if (run.revision !== input.runRevision)
      return {
        claimed: false,
        reason: "stale_event",
        currentRunRevision: run.revision,
      };
    if (!["completed", "failed", "cancelled", "lost"].includes(run.status))
      return { claimed: false, reason: "execution_not_terminal" };
    if (run.verification !== "pending")
      return { claimed: false, reason: "already_verified" };
    const { state } = effectiveTaskState(deps, task, getTaskProgress(deps, task.id));
    if (state === "done" || state === "cancelled")
      return { claimed: false, reason: "task_closed" };
    const policyRow = latestTaskValue(deps, task.id, "continuation_policy");
    const policy = policyRow
      ? (JSON.parse(policyRow.valueJson) as {
          mode: ContinuationMode;
          objective: string;
        })
      : null;
    if (!policy || policy.mode === "off")
      return { claimed: false, reason: "continuation_disabled" };
    const prior = claimRow(deps, input.runId, input.runRevision);
    if (prior)
      return {
        claimed: false,
        reason:
          prior.status === "claimed"
            ? prior.leaseUntil <= new Date().toISOString()
              ? "recovery_required"
              : "already_claimed"
            : "already_handled",
        resultRecordId: prior.resultRecordId,
        semantics:
          "Lease expiry never authorizes replay of external effects. Inspect the retained result before recovery.",
      };
    const token = randomUUID(),
      now = new Date(),
      leaseUntil = new Date(now.getTime() + 300_000).toISOString();
    deps.sqlite
      .prepare(
        `INSERT INTO workflow_continuations
      (run_id,run_revision,task_id,consumer_id,token,status,lease_until,created_at,updated_at)
      VALUES(?,?,?,?,?,'claimed',?,?,?)`,
      )
      .run(
        run.id,
        input.runRevision,
        task.id,
        input.consumerId,
        token,
        leaseUntil,
        now.toISOString(),
        now.toISOString(),
      );
    return {
      claimed: true,
      token,
      leaseUntil,
      runId: run.id,
      runRevision: input.runRevision,
      objective: policy.objective,
      mode: policy.mode,
      device: run.device,
      identity: run.identity,
      externalJobId: run.externalJobId,
      criteria: JSON.parse(run.criteriaJson) as string[],
      instructions:
        "Read the exact existing executor receipt; verify criteria, capture task evidence, verify_run separately, then finish_continuation. Never restart this job or expand the authorized objective.",
    };
  })();
}
export function finishContinuation(
  deps: ServiceDeps,
  input: Scope & {
    runId: string;
    runRevision: number;
    token: string;
    resultRecordId: string;
    result: "reported" | "needs_owner";
  },
) {
  return deps.sqlite.transaction(() => {
    const run = getRun(deps, input.projectId, input.taskId, input.runId);
    const claim = claimRow(deps, run.id, input.runRevision);
    if (!claim || claim.token !== input.token)
      throw new ApiError(
        409,
        "continuation_claim_conflict",
        "This continuation belongs to another claim.",
      );
    if (claim.status !== "claimed") {
      if (
        claim.resultRecordId !== input.resultRecordId ||
        claim.result !== input.result
      )
        throw new ApiError(
          409,
          "continuation_result_conflict",
          "Continuation already has a different result.",
        );
      return {
        completed: true,
        replay: true,
        resultRecordId: claim.resultRecordId,
      };
    }
    const evidence = deps.sqlite
      .prepare(
        `SELECT r.id FROM records r JOIN workflow_task_records tr ON tr.record_id=r.id
      WHERE tr.task_id=? AND r.id=? AND r.project_id=? AND r.review_status IN ('accepted','proposed')
      AND EXISTS(SELECT 1 FROM record_evidence e WHERE e.record_id=r.id)`,
      )
      .get(input.taskId, input.resultRecordId, input.projectId);
    if (!evidence)
      throw new ApiError(
        409,
        "continuation_evidence_missing",
        "Capture evidence in this task before completing continuation.",
      );
    if (input.result === "reported" && (run.verification === "pending" || currentEvidenceValidity(deps,run).status !== "valid"))
      throw new ApiError(
        409,
        "continuation_verification_pending",
        "Verify the retained execution separately before reporting completion.",
      );
    if (
      input.result === "reported" &&
      run.verificationRecordId !== input.resultRecordId
    )
      throw new ApiError(
        409,
        "continuation_verification_mismatch",
        "Finish with the same evidence used to verify this execution.",
      );
    deps.sqlite
      .prepare(
        `UPDATE workflow_continuations SET status='completed' ,result_record_id=?,result=?,updated_at=?
      WHERE run_id=? AND run_revision=? AND token=?`,
      )
      .run(
        input.resultRecordId,
        input.result,
        new Date().toISOString(),
        run.id,
        input.runRevision,
        input.token,
      );
    return {
      completed: true,
      resultRecordId: input.resultRecordId,
      taskUpdated: false,
    };
  })();
}

/** Reconcile an abandoned claim after a fresh inspection; never reacquire or replay effects. */
export function reconcileContinuation(
  deps: ServiceDeps,
  input: Scope & {
    runId: string;
    runRevision: number;
    expectedClaimUpdatedAt: string;
    resultRecordId: string;
    result: "reported" | "needs_owner";
  },
) {
  return deps.sqlite.transaction(() => {
    getRun(deps, input.projectId, input.taskId, input.runId);
    const claim = deps.sqlite
      .prepare(
        `SELECT token,status,lease_until AS leaseUntil,updated_at AS updatedAt
      FROM workflow_continuations WHERE run_id=? AND run_revision=? AND task_id=?`,
      )
      .get(input.runId, input.runRevision, input.taskId) as
      | {
          token: string;
          status: string;
          leaseUntil: string;
          updatedAt: string;
        }
      | undefined;
    if (!claim || claim.updatedAt !== input.expectedClaimUpdatedAt)
      throw new ApiError(
        409,
        "continuation_recovery_conflict",
        "Read the current continuation before reconciliation.",
      );
    if (
      claim.status !== "claimed" ||
      claim.leaseUntil > new Date().toISOString()
    )
      throw new ApiError(
        409,
        "continuation_recovery_not_abandoned",
        "Do not replace an active or already completed continuation.",
      );
    const proof = deps.sqlite
      .prepare(
        `SELECT r.recorded_at AS recordedAt FROM records r
      JOIN workflow_task_records tr ON tr.record_id=r.id
      WHERE r.id=? AND tr.task_id=? AND r.review_status IN ('accepted','proposed')`,
      )
      .get(input.resultRecordId, input.taskId) as
      { recordedAt: string } | undefined;
    if (!proof || proof.recordedAt < claim.leaseUntil)
      throw new ApiError(
        409,
        "continuation_recovery_requires_fresh_evidence",
        "Inspect the retained result again and capture fresh same-task evidence.",
      );
    const result = finishContinuation(deps, { ...input, token: claim.token });
    return {
      ...result,
      reconciled: true,
      executionStarted: false,
      semantics:
        "An abandoned claim was resolved from fresh evidence; its external job was not replayed.",
    };
  })();
}
