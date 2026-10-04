import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkContextCheckpointDto } from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { records } from "../db/schema.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function compactWorkingCheckpoint(
  checkpoint: ReturnType<typeof parseWorkingCheckpoint>,
  recordId: string,
  options: { includeResumeDetails?: boolean } = {},
) {
  if (!checkpoint) return null;
  return {
    kind: checkpoint.kind,
    ...(checkpoint.projectLevelIntent
      ? { projectLevelIntent: checkpoint.projectLevelIntent }
      : {}),
    ...(checkpoint.taskId ? { taskId: checkpoint.taskId } : {}),
    ...(checkpoint.summary ? { summary: clip(checkpoint.summary, 400) } : {}),
    ...(checkpoint.outcome ? { outcome: clip(checkpoint.outcome, 400) } : {}),
    nextAction: checkpoint.nextAction ? clip(checkpoint.nextAction, 500) : null,
    ...(options.includeResumeDetails
      ? {
          blockerMetadata: checkpoint.blockerMetadata?.slice(0, 5),
          blockers: checkpoint.blockers
            .slice(0, 5)
            .map((item) => clip(item, 300)),
        }
      : {}),
    blockerCount: checkpoint.blockers.length,
    artifactRefCount: checkpoint.artifactRefs.length,
    ...(checkpoint.capturedAt ? { capturedAt: checkpoint.capturedAt } : {}),
    recordId,
    recovery: { tool: "get_record", includeUnreviewed: true },
  };
}

const checkpointCreationOrder = sql<number>`COALESCE(
  (SELECT max(a.rowid) FROM audit_events a
   WHERE a.target_type='record' AND a.target_id=${records.id}
     AND a.action='record.edited'
     AND json_valid(a.detail_json)
     AND json_extract(a.detail_json,'$.operation')='record.create'),
  0
)`;

/** Latest eligible checkpoint is independent of task ranking and the proposed-only working index. */
export function latestCheckpointFor(
  db: Db,
  projectId: string,
  taskId?: string,
): WorkContextCheckpointDto | null {
  const row = db
    .select()
    .from(records)
    .where(
      and(
        eq(records.projectId, projectId),
        eq(records.evidenceBasis, "agent_report"),
        taskId
          ? sql`CASE WHEN json_valid(${records.valueJson}) = 1 THEN json_extract(${records.valueJson}, '$.taskId') END = ${taskId}`
          : undefined,
        inArray(records.reviewStatus, ["accepted", "proposed"]),
        sql`CASE WHEN json_valid(${records.valueJson}) = 1 THEN json_extract(${records.valueJson}, '$.kind') ELSE NULL END = 'working_checkpoint'`,
      ),
    )
    .orderBy(
      desc(records.recordedAt),
      desc(checkpointCreationOrder),
      desc(records.id),
    )
    .limit(1)
    .get();
  if (
    !row ||
    (row.reviewStatus !== "accepted" && row.reviewStatus !== "proposed")
  )
    return null;
  return {
    recordId: row.id,
    revision: row.revision,
    recordedAt: row.recordedAt,
    status: row.reviewStatus,
    provenance: row.evidenceBasis,
    checkpoint: compactWorkingCheckpoint(
      parseWorkingCheckpoint(row.valueJson),
      row.id,
      { includeResumeDetails: true },
    ),
  };
}
