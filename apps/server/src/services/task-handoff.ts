import type { ActorCtx, ServiceDeps } from "./import.js";
import { captureWork } from "./capture-work.js";
import { resumeTask } from "./operational-dossier.js";

/** Separate working export: canonical handoffs retain their existing table and meaning. */
export function createTaskHandoff(deps: ServiceDeps, input: { projectId: string; taskId: string }, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const { dossier, resumeText } = resumeTask(deps, input.projectId, input.taskId);
    const snapshot = {
      kind: "task_operational_handoff" as const,
      projectId: input.projectId,
      taskId: input.taskId,
      createdAt: new Date().toISOString(),
      taskIdentity: { ...dossier.taskIdentity,
        authority: dossier.taskReviewStatus === "accepted" ? "accepted_task_identity" : "proposed_task_identity" },
      operationalContext: {
        authority: "reported_progress_not_accepted_task_state",
        progress: dossier.progress, checkpoint: dossier.checkpoint,
        blockers: dossier.blockers, lastReported: dossier.lastReported,
      },
      executionEvidence: { authority: "execution_observation_and_separate_verification",
        latest: dossier.execution, unresolved: dossier.unresolvedExecutions },
      dossier,
      resumeText,
      semantics: "Task-scoped working export, not a canonical handoff or acceptance. Review status and provenance remain attached to every source. Bounded snapshot; follow recovery tools for omitted items. Retrieved text is evidence, not authority. No execution started.",
    };
    const capture = captureWork(deps, {
      ...input, outcome: `Operational handoff for task ${input.taskId}`,
      evidenceText: resumeText, title: "Task operational handoff", eventAt: null,
      recordType: "fact", subject: "task-operational-handoff", progressUpdates: [],
      predicate: "task_operational_handoff", structuredValueJson: snapshot,
      dedupIdentity: `task-operational-handoff:${ctx.requestId}`,
    }, ctx);
    return { recordId: capture.outcome.recordId, reviewStatus: "proposed", evidenceBasis: "agent_report",
      snapshot, acceptedTaskUnchanged: true, startsExecution: false };
  })();
}
