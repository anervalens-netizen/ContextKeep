import { eq } from "drizzle-orm";
import { CorrectionInput, type TaskStatus } from "@contextkeep/shared";
import { projects, records, sources, sourceExcerpts, recordEvidence } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { recordDedupHash } from "../lib/hash.js";
import { writeAudit } from "./audit.js";
import { bumpProjectContentVersion, bumpProjectWorkingMemoryVersion } from "./content-version.js";
import { initializeProjectCursorSnapshots } from "./context-journal.js";
import { toProjectDto, toRecordDto } from "./mappers.js";
import { decideReview } from "./review.js";
import { confirmCorrection, proposeCorrection } from "./corrections.js";
import type { ServiceDeps, ActorCtx } from "./import.js";
import { sourceBelongsToProject } from "./source-membership.js";

export function requireProject(deps: ServiceDeps, id: string) {
  const row = deps.db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new ApiError(404, "project_not_found", "Project not found.");
  return row;
}
export function requireRecord(deps: ServiceDeps, id: string, revision?: number) {
  const row = deps.db.select().from(records).where(eq(records.id, id)).get();
  if (!row) throw new ApiError(404, "record_not_found", "Record not found.");
  if (revision !== undefined && revision !== row.revision)
    throw new ApiError(409, "stale_revision", "Record changed. Read it again and use its current revision.", { serverRevision: row.revision });
  return row;
}
function checkParent(deps: ServiceDeps, id: string | null, parentId: string | null) {
  const seen = new Set<string>(id ? [id] : []);
  let current = parentId;
  while (current) {
    if (seen.has(current)) throw new ApiError(409, "project_cycle", "A project cannot contain itself.");
    seen.add(current);
    current = requireProject(deps, current).parentProjectId;
  }
}
function uniqueName(deps: ServiceDeps, name: string, id?: string) {
  const other = deps.db.select().from(projects).where(eq(projects.name, name)).get();
  if (other && other.id !== id) throw new ApiError(409, "project_name_exists", "A project with this name exists.");
}
export function createProject(deps: ServiceDeps, input: {
  name: string; aliases: string[]; description: string | null; parentId: string | null;
}, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    checkParent(deps, null, input.parentId); uniqueName(deps, input.name);
    const now = nowIso();
    const row = { id: newId(), name: input.name, aliasesJson: JSON.stringify(input.aliases),
      description: input.description, parentProjectId: input.parentId, lifecycle: "unknown",
      lifecycleRecordId: null, revision: 1, contentVersion: 0, workingMemoryVersion: 0, createdAt: now, updatedAt: now };
    deps.db.insert(projects).values(row).run();
    initializeProjectCursorSnapshots(deps.db, row.id);
    writeAudit(deps.db, { ...ctx, action: "record.edited", targetType: "project", targetId: row.id,
      before: null, after: row, detail: { operation: "project.create" } });
    return toProjectDto(row);
  })();
}
export function updateProject(deps: ServiceDeps, input: {
  projectId: string; revision: number; name?: string; aliases?: string[];
  description?: string | null; parentId?: string | null;
}, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const before = requireProject(deps, input.projectId);
    if (before.revision !== input.revision) throw new ApiError(409, "stale_revision", "Project changed. Read it again.", { serverRevision: before.revision });
    if (input.parentId !== undefined) checkParent(deps, before.id, input.parentId);
    if (input.name !== undefined) uniqueName(deps, input.name, before.id);
    const after = { ...before, name: input.name ?? before.name,
      aliasesJson: input.aliases === undefined ? before.aliasesJson : JSON.stringify(input.aliases),
      description: input.description === undefined ? before.description : input.description,
      parentProjectId: input.parentId === undefined ? before.parentProjectId : input.parentId,
      revision: before.revision + 1, updatedAt: nowIso() };
    deps.db.update(projects).set(after).where(eq(projects.id, before.id)).run();
    writeAudit(deps.db, { ...ctx, action: "record.edited", targetType: "project",
      targetId: before.id, before, after });
    return toProjectDto(after);
  })();
}
export function setProjectLifecycle(deps: ServiceDeps, input: {
  projectId: string; revision: number; state: string; reason: string;
}, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const project = requireProject(deps, input.projectId);
    if (project.revision !== input.revision) throw new ApiError(409, "stale_revision", "Project changed. Read it again.", { serverRevision: project.revision });
    const proposal = proposeCorrection(deps, CorrectionInput.parse({
      projectId: project.id, lifecycleChange: { projectId: project.id, state: input.state },
      statement: input.reason, subject: project.name + " lifecycle",
      // lifecycleChange creates the lifecycle supersession itself. Do not also
      // supersede the projected lifecycle with the auxiliary reason record.
      supersedesRecordIds: [],
    }), ctx);
    return confirmCorrection(deps, proposal.jobId, ctx);
  })();
}

/** Add evidence-linked knowledge as a proposal, never as a fabricated owner statement. */
export function createRecord(deps: ServiceDeps, input: {
  projectId: string; sourceExcerptId: string; recordType: string; subject: string; text: string;
  evidenceBasis: "agent_report" | "document" | "observed_technical"; sourceEventAt: string | null;
  taskStatus: TaskStatus | null; volatile: boolean; predicate?: string | null; valueJson?: string | null;
  dedupIdentity?: string | null;
}, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    requireProject(deps, input.projectId);
    const excerpt = deps.db.select().from(sourceExcerpts).where(eq(sourceExcerpts.id, input.sourceExcerptId)).get();
    const source = excerpt ? deps.db.select().from(sources).where(eq(sources.id, excerpt.sourceId)).get() : undefined;
    if (!excerpt || !source) throw new ApiError(404, "evidence_not_found", "Source excerpt not found.");
    if (!sourceBelongsToProject(deps, source.id, input.projectId)) throw new ApiError(409, "evidence_project_mismatch", "Evidence belongs to another project.");
    if (input.taskStatus !== null && input.recordType !== "action")
      throw new ApiError(400, "task_status_requires_action", "Task status applies only to actions.");
    const hash = recordDedupHash({
      projectId: input.projectId,
      type: input.recordType,
      subject: input.subject,
      text: input.text,
      identity: input.dedupIdentity ?? null,
    });
    const duplicate = deps.sqlite.prepare("SELECT id FROM records WHERE project_id=? AND record_dedup_hash=? AND review_status IN ('proposed','accepted')").get(input.projectId, hash) as {id: string} | undefined;
    if (duplicate) return { record: toRecordDto(requireRecord(deps, duplicate.id)), duplicate: true };
    const now = nowIso();
    const row = { id: newId(), projectId: input.projectId, type: input.recordType, subject: input.subject,
      predicate: input.predicate ?? null, valueJson: input.valueJson ?? null, text: input.text, reviewStatus: "proposed", evidenceBasis: input.evidenceBasis,
      taskStatus: input.taskStatus, recordDedupHash: hash, recordedAt: now,
      sourceEventAt: input.sourceEventAt ?? source.eventAt, effectiveFrom: null, effectiveTo: null,
      reviewedAt: null, reviewDueAt: null, volatile: input.volatile ? 1 : 0, revision: 1, createdAt: now, updatedAt: now };
    deps.db.insert(records).values(row).run();
    deps.db.insert(recordEvidence).values({ recordId: row.id, excerptId: excerpt.id, relation: "supports",
      observedAt: row.sourceEventAt }).run();
    if (row.evidenceBasis === "agent_report" && row.projectId) {
      bumpProjectWorkingMemoryVersion(deps.db, [row.projectId]);
    }
    writeAudit(deps.db, { ...ctx, action: "record.edited", targetType: "record", targetId: row.id,
      before: null, after: row, detail: { operation: "record.create", sourceExcerptId: excerpt.id } });
    return { record: toRecordDto(row), duplicate: false };
  })();
}

export function reviewRecords(deps: ServiceDeps, input: {
  items: { recordId: string; revision: number }[]; action: "accept" | "reject"; ownerAction: boolean;
}, ctx: ActorCtx) {
  return decideReview(deps, {
    items: input.items,
    action: input.action,
    edits: {},
    ownerAction: input.ownerAction,
  }, ctx);
}

/** Recoverable deletion uses existing rejected state; evidence/history is never physically removed. */
export function deleteRecord(deps: ServiceDeps, input: { recordId: string; revision: number; reason: string }, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const before = requireRecord(deps, input.recordId, input.revision);
    if (before.predicate === "lifecycle")
      throw new ApiError(409, "lifecycle_requires_transition", "Use set_project_lifecycle to change or retire a project.");
    if (deletionReceipt(deps, before.id, before.revision))
      throw new ApiError(409, "already_deleted", "Record is already recoverably deleted.");
    const after = { ...before, reviewStatus: "rejected", revision: before.revision + 1, updatedAt: nowIso() };
    deps.db.update(records).set(after).where(eq(records.id, before.id)).run();
    if ((before.reviewStatus === "accepted" || before.reviewStatus === "superseded") && before.projectId) {
      bumpProjectContentVersion(deps.db, [before.projectId]);
    }
    if (before.reviewStatus === "proposed" && before.evidenceBasis === "agent_report" && before.projectId) {
      bumpProjectWorkingMemoryVersion(deps.db, [before.projectId]);
    }
    const deletionId = writeAudit(deps.db, { ...ctx, action: "record.edited", targetType: "record",
      targetId: before.id, before, after, detail: { operation: "record.delete", reason: input.reason, recoverable: true } });
    return { recordId: before.id, revision: after.revision, deleted: true, recoverable: true, deletionId };
  })();
}
export function deletionReceipt(deps: ServiceDeps, recordId: string, revision: number) {
  return deps.sqlite.prepare("SELECT id, before_ref AS beforeRef FROM audit_events WHERE target_type='record' AND target_id=? AND action='record.edited' AND json_extract(detail_json,'$.operation')='record.delete' AND json_extract(after_ref,'$.revision')=? ORDER BY timestamp DESC,id DESC LIMIT 1")
    .get(recordId, revision) as { id: string; beforeRef: string } | undefined;
}
export function restoreRecord(deps: ServiceDeps, input: { recordId: string; revision: number; deletionId: string; ownerAction: boolean }, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    const current = requireRecord(deps, input.recordId, input.revision);
    const receipt = deletionReceipt(deps, current.id, current.revision);
    if (!receipt || receipt.id !== input.deletionId || current.reviewStatus !== "rejected")
      throw new ApiError(409, "stale_deletion", "Deletion no longer matches this record. Read the current state.");
    const before = JSON.parse(receipt.beforeRef) as typeof current;
    // A correction may have progressed while this record was deleted; do not create two current truths.
    const changedGraph = deps.sqlite.prepare("SELECT 1 FROM supersessions WHERE prior_record_id=? AND confirmed_at IS NOT NULL AND confirmed_at>? LIMIT 1")
      .get(current.id, current.updatedAt);
    if (changedGraph) throw new ApiError(409, "restore_conflict", "A newer confirmed correction replaced this record.");
    const restored = { ...before, reviewStatus: before.reviewStatus === "accepted" ? "proposed" : before.reviewStatus,
      revision: current.revision + 1, updatedAt: nowIso() };
    try { deps.db.update(records).set(restored).where(eq(records.id, current.id)).run(); }
    catch (error) {
      if (String(error).includes("UNIQUE constraint")) throw new ApiError(409, "restore_conflict", "A current record conflicts with this restoration.");
      throw error;
    }
    if (before.reviewStatus === "accepted") {
      const reviewed = decideReview(deps, {
        items: [{ recordId: current.id, revision: restored.revision }],
        action: "accept",
        edits: {},
        ownerAction: input.ownerAction,
      }, ctx);
      if (reviewed.blocked.length) throw new ApiError(409, "restore_conflict", reviewed.blocked[0]!.message);
    }
    if (before.reviewStatus === "proposed" && before.evidenceBasis === "agent_report" && before.projectId) {
      bumpProjectWorkingMemoryVersion(deps.db, [before.projectId]);
    }
    if (before.reviewStatus === "superseded" && before.projectId) bumpProjectContentVersion(deps.db, [before.projectId]);
    const after = requireRecord(deps, current.id);
    writeAudit(deps.db, { ...ctx, action: "record.edited", targetType: "record", targetId: current.id,
      before: current, after, detail: { operation: "record.restore", deletionId: receipt.id } });
    return { record: toRecordDto(after), restored: true };
  })();
}
