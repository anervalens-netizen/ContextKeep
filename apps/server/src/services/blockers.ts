import type { ActorCtx, ServiceDeps } from "./import.js";
import { ApiError } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";
import { captureWork } from "./capture-work.js";
import { parseWorkingCheckpoint } from "./checkpoint.js";
import { requireProject, requireRecord } from "./memory-management.js";

export type BlockerDisposition = "resolved" | "withdrawn";

type ResolutionValue = {
  kind: "blocker_resolution";
  blockerId: string;
  disposition: BlockerDisposition;
  actionRecordId: string | null;
  actor: string;
  resolvedAt: string;
  checkpointRevision: number;
};

type CheckpointBlocker = {
  blockerId: string;
  text: string;
  checkpointRecordId: string;
  checkpointRevision: number;
  checkpointStatus: string;
  checkpointRecordedAt: string;
  index: number;
  identitySource: "checkpoint_record_index";
};

type ResolutionRow = {
  recordId: string;
  reviewStatus: string;
  evidenceBasis: string;
  recordedAt: string;
  text: string;
  valueJson: string | null;
  evidenceCount: number;
};

export function blockerIdFor(
  checkpointRecordId: string,
  checkpointRevision: number,
  index: number,
): string {
  void checkpointRevision;
  return `blk:${checkpointRecordId}:${index}`;
}

function parseBlockerId(blockerId: string): {
  recordId: string;
  index: number;
} | null {
  const match = /^blk:([0-9a-fA-F-]{36}):(\d+)$/.exec(blockerId);
  if (!match) return null;
  const index = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { recordId: match[1]!, index };
}

function parseResolutionValue(valueJson: string | null): ResolutionValue | null {
  if (!valueJson) return null;
  try {
    const value = JSON.parse(valueJson) as Record<string, unknown>;
    if (
      value.kind !== "blocker_resolution" ||
      typeof value.blockerId !== "string" ||
      (value.disposition !== "resolved" && value.disposition !== "withdrawn") ||
      typeof value.actor !== "string" ||
      typeof value.resolvedAt !== "string" ||
      typeof value.checkpointRevision !== "number"
    ) {
      return null;
    }
    return {
      kind: "blocker_resolution",
      blockerId: value.blockerId,
      disposition: value.disposition,
      actionRecordId: typeof value.actionRecordId === "string" ? value.actionRecordId : null,
      actor: value.actor,
      resolvedAt: value.resolvedAt,
      checkpointRevision: value.checkpointRevision,
    };
  } catch {
    return null;
  }
}

function checkpointBlockersForProject(deps: ServiceDeps, projectId: string): CheckpointBlocker[] {
  const rows = deps.sqlite.prepare(`
    SELECT id, revision, review_status AS reviewStatus, recorded_at AS recordedAt,
           value_json AS valueJson
    FROM records
    WHERE project_id=?
      AND value_json IS NOT NULL
      AND json_valid(value_json)=1
      AND json_extract(value_json, '$.kind')='working_checkpoint'
    ORDER BY recorded_at ASC, id ASC
  `).all(projectId) as Array<{
    id: string;
    revision: number;
    reviewStatus: string;
    recordedAt: string;
    valueJson: string;
  }>;

  const blockers: CheckpointBlocker[] = [];
  for (const row of rows) {
    const checkpoint = parseWorkingCheckpoint(row.valueJson);
    if (!checkpoint) continue;
    checkpoint.blockers.forEach((text, index) => {
      blockers.push({
        blockerId: blockerIdFor(row.id, row.revision, index),
        text,
        checkpointRecordId: row.id,
        checkpointRevision: row.revision,
        checkpointStatus: row.reviewStatus,
        checkpointRecordedAt: row.recordedAt,
        index,
        identitySource: "checkpoint_record_index",
      });
    });
  }
  return blockers;
}

function resolutionRowsForProject(deps: ServiceDeps, projectId: string): ResolutionRow[] {
  return deps.sqlite.prepare(`
    SELECT r.id AS recordId, r.review_status AS reviewStatus,
           r.evidence_basis AS evidenceBasis, r.recorded_at AS recordedAt,
           r.text, r.value_json AS valueJson,
           (SELECT count(*) FROM record_evidence re WHERE re.record_id=r.id) AS evidenceCount
    FROM records r
    WHERE r.project_id=?
      AND r.predicate='blocker_resolution'
      AND r.review_status IN ('proposed','accepted')
    ORDER BY r.recorded_at DESC, r.id DESC
  `).all(projectId) as ResolutionRow[];
}

export function getBlockerState(
  deps: ServiceDeps,
  projectId: string,
  page: { offset?: number; limit?: number } = {},
) {
  requireProject(deps, projectId);
  const blockers = checkpointBlockersForProject(deps, projectId);
  const resolutions = resolutionRowsForProject(deps, projectId);
  const resolutionByBlocker = new Map<string, { row: ResolutionRow; value: ResolutionValue }>();
  for (const row of resolutions) {
    const value = parseResolutionValue(row.valueJson);
    if (!value || resolutionByBlocker.has(value.blockerId)) continue;
    resolutionByBlocker.set(value.blockerId, { row, value });
  }

  const historyAll = blockers.map((blocker) => {
    const resolution = resolutionByBlocker.get(blocker.blockerId);
    const checkpointActive = blocker.checkpointStatus === "proposed" || blocker.checkpointStatus === "accepted";
    return {
      ...blocker,
      status: resolution
        ? resolution.value.disposition
        : checkpointActive
          ? "active"
          : "inactive_history",
      resolution: resolution
        ? {
            recordId: resolution.row.recordId,
            reviewStatus: resolution.row.reviewStatus,
            evidenceBasis: resolution.row.evidenceBasis,
            recordedAt: resolution.row.recordedAt,
            evidenceCount: resolution.row.evidenceCount,
            disposition: resolution.value.disposition,
            resolution: resolution.row.text,
            actor: resolution.value.actor,
            actionRecordId: resolution.value.actionRecordId,
            resolvedAt: resolution.value.resolvedAt,
          }
        : null,
    };
  });

  const activeAll = historyAll
    .filter((item) => item.status === "active")
    .sort((a, b) => b.checkpointRecordedAt.localeCompare(a.checkpointRecordedAt) || b.blockerId.localeCompare(a.blockerId));
  const resolvedAll = historyAll
    .filter((item) => item.status === "resolved" || item.status === "withdrawn")
    .sort((a, b) =>
      (b.resolution?.recordedAt ?? b.checkpointRecordedAt).localeCompare(a.resolution?.recordedAt ?? a.checkpointRecordedAt) ||
      b.blockerId.localeCompare(a.blockerId)
    );
  const orderedHistory = [...historyAll].sort((a, b) =>
    b.checkpointRecordedAt.localeCompare(a.checkpointRecordedAt) || b.blockerId.localeCompare(a.blockerId)
  );
  const offset = Math.max(0, page.offset ?? 0);
  const limit = Math.min(50, Math.max(1, page.limit ?? 25));
  const nextOffset = (total: number) => offset + limit < total ? offset + limit : null;

  return {
    projectId,
    active: activeAll.slice(offset, offset + limit),
    resolved: resolvedAll.slice(offset, offset + limit),
    history: orderedHistory.slice(offset, offset + limit),
    activeCount: activeAll.length,
    resolvedCount: resolvedAll.length,
    historyCount: orderedHistory.length,
    pagination: {
      offset,
      limit,
      activeNextOffset: nextOffset(activeAll.length),
      resolvedNextOffset: nextOffset(resolvedAll.length),
      historyNextOffset: nextOffset(orderedHistory.length),
    },
    semantics:
      "Blocker identity derives from checkpoint record+index and remains stable across review/archive revisions. checkpointRevision is a stale-write fence. Only an explicit proposed/accepted blocker_resolution event suppresses an active blocker; later blockers=[] does not. Arrays are bounded pages; counts are exact.",
  };
}

function findBlockerAcrossProjects(deps: ServiceDeps, blockerId: string): {
  projectId: string | null;
  reviewStatus: string;
} | null {
  const parsed = parseBlockerId(blockerId);
  if (!parsed) return null;
  const row = deps.sqlite.prepare(
    "SELECT project_id AS projectId, review_status AS reviewStatus, revision, value_json AS valueJson FROM records WHERE id=?",
  ).get(parsed.recordId) as {
    projectId: string | null;
    reviewStatus: string;
    revision: number;
    valueJson: string | null;
  } | undefined;
  if (!row) return null;
  const checkpoint = parseWorkingCheckpoint(row.valueJson);
  if (!checkpoint || parsed.index >= checkpoint.blockers.length) return null;
  return { projectId: row.projectId, reviewStatus: row.reviewStatus };
}

export function resolveBlocker(
  deps: ServiceDeps,
  input: {
    projectId: string;
    blockerId: string;
    disposition: BlockerDisposition;
    resolution: string;
    evidenceText: string | null;
    actionRecordId: string | null;
    checkpointRevision: number;
  },
  ctx: ActorCtx,
) {
  return deps.sqlite.transaction(() => {
    requireProject(deps, input.projectId);
    const parsed = parseBlockerId(input.blockerId);
    if (!parsed) throw new ApiError(400, "invalid_blocker_id", "Blocker id is not a valid ContextKeep blocker reference.");

    const target = requireRecord(deps, parsed.recordId);
    if (target.projectId !== input.projectId) {
      throw new ApiError(409, "blocker_project_mismatch", "Blocker belongs to another project.");
    }
    if (target.revision !== input.checkpointRevision) {
      throw new ApiError(409, "blocker_stale_reference", "Blocker checkpoint revision changed; refresh blocker state before resolving.");
    }
    const checkpoint = parseWorkingCheckpoint(target.valueJson);
    if (!checkpoint || parsed.index >= checkpoint.blockers.length) {
      throw new ApiError(409, "blocker_stale_reference", "Blocker no longer exists at this checkpoint revision.");
    }
    if (target.reviewStatus !== "proposed" && target.reviewStatus !== "accepted") {
      throw new ApiError(409, "blocker_not_active", "Blocker checkpoint is no longer active.");
    }

    const existing = resolutionRowsForProject(deps, input.projectId)
      .map((row) => ({ row, value: parseResolutionValue(row.valueJson) }))
      .find((item) => item.value?.blockerId === input.blockerId);
    if (existing?.value) {
      throw new ApiError(409, "blocker_already_resolved", "Blocker already has an active explicit resolution.", {
        blockerId: input.blockerId,
        resolutionRecordId: existing.row.recordId,
        disposition: existing.value.disposition,
      });
    }

    if (input.actionRecordId) {
      const action = requireRecord(deps, input.actionRecordId);
      if (action.projectId !== input.projectId) {
        throw new ApiError(409, "blocker_action_project_mismatch", "Linked action belongs to another project.");
      }
      if (action.type !== "action" || action.reviewStatus !== "accepted") {
        throw new ApiError(409, "blocker_action_requires_accepted_action", "Linked blocker action must be an accepted action record.");
      }
    }

    const resolvedAt = nowIso();
    const value: ResolutionValue = {
      kind: "blocker_resolution",
      blockerId: input.blockerId,
      disposition: input.disposition,
      actionRecordId: input.actionRecordId,
      actor: ctx.actor,
      resolvedAt,
      checkpointRevision: input.checkpointRevision,
    };
    const captured = captureWork(deps, {
      projectId: input.projectId,
      outcome: input.resolution,
      evidenceText: `Blocker ${input.blockerId} resolution evidence:\n${input.evidenceText ?? input.resolution}`,
      title: `Blocker resolution: ${checkpoint.blockers[parsed.index]!.slice(0, 120)}`,
      eventAt: resolvedAt,
      recordType: "fact",
      subject: `blocker-resolution:${input.blockerId}`,
      progressUpdates: [],
      predicate: "blocker_resolution",
      structuredValueJson: value,
      dedupIdentity: `blocker_resolution:${input.blockerId}:${input.disposition}`,
      authorLabel: ctx.actor,
    }, ctx);

    const state = getBlockerState(deps, input.projectId);
    const resolved = state.resolved.find((item) => item.blockerId === input.blockerId);
    if (!resolved) throw new ApiError(500, "blocker_resolution_readback_failed", "Resolution was written but did not read back.");

    return {
      projectId: input.projectId,
      blockerId: input.blockerId,
      blockerText: checkpoint.blockers[parsed.index]!,
      disposition: input.disposition,
      resolutionRecordId: captured.outcome.recordId,
      reviewStatus: captured.outcome.reviewStatus,
      evidenceBasis: captured.outcome.evidenceBasis,
      actor: ctx.actor,
      actionRecordId: input.actionRecordId,
      checkpointRevision: input.checkpointRevision,
      actionUpdated: false,
      workingMemoryVersion: captured.workingMemoryVersion,
      blocker: resolved,
    };
  })();
}

export function validateBlockerProject(deps: ServiceDeps, projectId: string, blockerId: string): void {
  const found = findBlockerAcrossProjects(deps, blockerId);
  if (!found) throw new ApiError(404, "blocker_not_found", "Blocker reference was not found.");
  if (found.projectId !== projectId) {
    throw new ApiError(409, "blocker_project_mismatch", "Blocker belongs to another project.");
  }
}
