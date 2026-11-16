import type { RecordDto, SearchTaskStateDto } from "@contextkeep/shared";
import type { ServiceDeps } from "./import.js";
import { effectiveTaskState, getTaskProgressMany } from "./operational-dossier.js";
import { taskSelectionPredicate } from "./task-selection.js";

/** Add operational state only after retrieval has selected its bounded hits.
 * Task identity is the task end of a workflow reference, never evidence record_id.
 * Full dossiers and per-task progress/audit reads do not belong on this path. */
export function taskSearchStates(
  deps: Pick<ServiceDeps, "sqlite">,
  hits: readonly RecordDto[],
): Map<string, SearchTaskStateDto> {
  const result = new Map<string, SearchTaskStateDto>();
  const candidates = hits.filter((record) =>
    record.type === "action" && record.projectId !== null &&
    (record.reviewStatus === "accepted" || record.reviewStatus === "proposed"),
  );
  if (candidates.length === 0) return result;
  const ids = [...new Set(candidates.map((record) => record.id))];
  const taskIds = new Set((deps.sqlite.prepare(`
    SELECT r.id FROM records r
    WHERE r.id IN (${ids.map(() => "?").join(",")})
      AND r.type='action' AND r.project_id IS NOT NULL
      AND r.review_status IN ('accepted','proposed')
      AND ${taskSelectionPredicate("actual_tasks")}
  `).all(...ids) as { id: string }[]).map((row) => row.id));
  if (taskIds.size === 0) return result;
  const tasks = candidates.filter((record) => taskIds.has(record.id));
  const progressByTask = getTaskProgressMany(deps, [...taskIds]);

  // Only an explicit audited status change can supersede an older report.
  // Batch this same predicate used by effectiveTaskState; text/review revisions
  // are not proof that an owner reopened a task. JSON input keeps bindings bounded.
  const auditCandidates = tasks.flatMap((task) => {
    const progress = progressByTask.get(task.id);
    return progress && task.taskStatus !== null &&
      task.taskStatus !== "done" && task.taskStatus !== "cancelled" &&
      progress.taskRevision < task.revision
      ? [{ id: task.id, revision: task.revision, status: task.taskStatus,
        progressTaskRevision: progress.taskRevision }]
      : [];
  });
  const statusChanged = new Set(auditCandidates.length === 0 ? [] :
    (deps.sqlite.prepare(`
      SELECT DISTINCT json_extract(candidate.value,'$.id') AS taskId
      FROM json_each(?) candidate JOIN audit_events audit
        ON audit.target_id=json_extract(candidate.value,'$.id')
      WHERE audit.target_type='record' AND audit.action IN ('record.edited','record.accepted')
        AND json_valid(audit.before_ref) AND json_valid(audit.after_ref)
        AND CAST(json_extract(audit.after_ref,'$.revision') AS INTEGER)>
          json_extract(candidate.value,'$.progressTaskRevision')
        AND CAST(json_extract(audit.after_ref,'$.revision') AS INTEGER)<=
          json_extract(candidate.value,'$.revision')
        AND json_extract(audit.before_ref,'$.taskStatus') IS NOT json_extract(audit.after_ref,'$.taskStatus')
        AND json_extract(audit.after_ref,'$.taskStatus')=json_extract(candidate.value,'$.status')
    `).all(JSON.stringify(auditCandidates)) as { taskId: string }[]).map((row) => row.taskId));

  for (const task of tasks) {
    if (task.projectId === null) continue;
    const progress = progressByTask.get(task.id) ?? null;
    const { state, stateSource } = effectiveTaskState(deps, task, progress, statusChanged.has(task.id));
    const reported = progress ? {
      recordId: progress.recordId,
      recordedAt: progress.recordedAt,
      taskRevision: progress.taskRevision,
      status: progress.status,
      reviewStatus: progress.reviewStatus,
      evidenceBasis: progress.evidenceBasis,
    } : null;
    result.set(task.id, {
      effectiveState: state as SearchTaskStateDto["effectiveState"],
      stateSource,
      progress: reported,
      stateProvenance: stateSource === "reported_progress" && progress
        ? {
          recordId: progress.recordId, recordedAt: progress.recordedAt,
          reviewStatus: progress.reviewStatus, evidenceBasis: progress.evidenceBasis,
        }
        : {
          recordId: task.id, recordedAt: task.updatedAt,
          reviewStatus: task.reviewStatus, evidenceBasis: task.evidenceBasis,
        },
      resume: { tool: "resume_task", projectId: task.projectId, taskId: task.id },
    });
  }
  return result;
}
