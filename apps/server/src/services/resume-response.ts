import type { taskDossier } from "./operational-dossier.js";
import { ApiError } from "../lib/errors.js";

type Dossier = ReturnType<typeof taskDossier>;
export type ResumeFormat = "both" | "structured";

/** A single bounded agent representation. Legacy human/panel exports keep both. */
export function structuredResume(
  d: Dossier,
  depth: string,
  budget = 6000,
  inheritedOmissions: Array<{
    field: string;
    recordId: string;
    tool: string;
  }> = [],
) {
  const recovery = {
    tool: "get_task",
    projectId: d.projectId,
    taskId: d.taskId,
  };
  const fieldsOmitted: Array<
    | string
    | {
        field: string;
        recordId: string;
        tool: string;
        includeUnreviewed: boolean;
      }
  > = inheritedOmissions.map((item) => ({ ...item, includeUnreviewed: true }));
  const summary =
    d.summary && d.summary.length > 600
      ? `${d.summary.slice(0, 599)}…`
      : d.summary;
  if (summary !== d.summary) fieldsOmitted.push("summary");
  const dossier = {
    projectId: d.projectId,
    taskId: d.taskId,
    taskRevision: d.taskRevision,
    state: d.state,
    stateSource: d.stateSource,
    stateProvenance: d.stateProvenance,
    taskReviewStatus: d.taskReviewStatus,
    stateToken: d.stateToken,
    title: d.title,
    summary,
    summarySource: d.summarySource,
    nextAction: d.nextAction,
    nextActionSource: d.nextActionSource,
    ownerAction: d.ownerAction,
    followUp: d.followUp,
    expectedProgressRecordId: d.progress?.recordId ?? null,
    currentEvidenceValidity: d.currentEvidenceValidity,
    needsAttention: d.needsAttention,
    attention: d.attention,
    lifecycleSuppressed: d.lifecycleSuppressed,
    lifecycleSuppressionReason: d.lifecycleSuppressionReason,
    unresolvedExecutionCount: d.unresolvedExecutionCount,
    unresolvedExecutions: {
      ...d.unresolvedExecutions,
      items: [...d.unresolvedExecutions.items],
      recovery: { ...d.unresolvedExecutions.recovery },
    },
    blockers: { ...d.blockers, items: [...d.blockers.items] },
    execution: d.execution
      ? {
          id: d.execution.id,
          revision: d.execution.revision,
          status: d.execution.status,
          externalJobId: d.execution.externalJobId,
          verification: d.execution.verification,
          evidenceValidity: d.execution.evidenceValidity,
          recovery,
        }
      : null,
  };
  const result = {
    dossier,
    format: "structured" as const,
    depth,
    startsExecution: false as const,
    contextBudgetChars: budget,
    truncated: fieldsOmitted.length > 0,
    omitted: fieldsOmitted,
    recovery,
    semantics:
      "Current state retains its provenance. History and expanded evidence are available through get_task only when needed. No execution is started.",
  };
  const fits = () => JSON.stringify(result).length <= budget;
  // Preserve exact counts and point to the first omitted item; never hide live work.
  while (!fits() && dossier.unresolvedExecutions.items.length) {
    dossier.unresolvedExecutions.items.pop();
    dossier.unresolvedExecutions.returned =
      dossier.unresolvedExecutions.items.length;
    dossier.unresolvedExecutions.nextOffset =
      dossier.unresolvedExecutions.offset +
      dossier.unresolvedExecutions.returned;
    dossier.unresolvedExecutions.recovery.unresolvedOffset =
      dossier.unresolvedExecutions.nextOffset;
    if (!fieldsOmitted.includes("unresolvedExecutions.items"))
      fieldsOmitted.push("unresolvedExecutions.items");
    result.truncated = true;
  }
  while (!fits() && dossier.blockers.items.length) {
    dossier.blockers.items.pop();
    dossier.blockers.nextOffset = dossier.blockers.items.length;
    if (!fieldsOmitted.includes("blockers.items"))
      fieldsOmitted.push("blockers.items");
    result.truncated = true;
  }
  // Do not cut next actions, follow-up or authority to satisfy an unsafe budget.
  if (!fits())
    throw new ApiError(
      413,
      "context_budget_unrepresentable",
      "Increase the resume budget to retain current state, provenance and recovery metadata.",
    );
  return result;
}
