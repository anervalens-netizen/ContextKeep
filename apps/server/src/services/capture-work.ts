import { eq, or } from "drizzle-orm";
import type { TaskStatus } from "@contextkeep/shared";
import { recordEvidence, records, sourceExcerpts, sources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { recordDedupHash, sha256 } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { checkpointIdentity, parseWorkingCheckpoint, type WorkingCheckpoint } from "./checkpoint.js";
import { refreshContextCursorSnapshot } from "./context-journal.js";
import { chunkText } from "./chunk.js";
import { bumpProjectWorkingMemoryVersion } from "./content-version.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { createRecord, requireProject, requireRecord } from "./memory-management.js";
import { normalizeText } from "./normalize.js";
import { editRecord } from "./review.js";
import { sourceBelongsToProject } from "./source-membership.js";

export interface CaptureWorkInput {
  projectId: string;
  outcome: string;
  evidenceText: string | null;
  title: string | null;
  eventAt: string | null;
  recordType: string;
  subject: string;
  progressUpdates: Array<{ recordId: string; revision: number; taskStatus: TaskStatus }>;
  /** Internal structured metadata for dedicated working-memory primitives. Not exposed by generic capture MCP schemas. */
  predicate?: string | null;
  structuredValueJson?: unknown | null;
  dedupIdentity?: string | null;
  authorLabel?: string | null;
  checkpoint?: {
    summary?: string;
    outcome?: string;
    nextAction?: string | null;
    blockers?: string[];
    artifactRefs?: string[];
  };
}

function buildCheckpoint(input: CaptureWorkInput, capturedAt: string): WorkingCheckpoint | null {
  if (!input.checkpoint) return null;
  return {
    kind: "working_checkpoint",
    summary: input.checkpoint.summary ?? input.checkpoint.outcome ?? input.outcome,
    outcome: input.checkpoint.outcome ?? input.outcome,
    nextAction: input.checkpoint.nextAction ?? null,
    blockers: input.checkpoint.blockers ?? [],
    artifactRefs: input.checkpoint.artifactRefs ?? [],
    capturedAt,
  };
}

export function captureWork(deps: ServiceDeps, input: CaptureWorkInput, ctx: ActorCtx) {
  return deps.sqlite.transaction(() => {
    requireProject(deps, input.projectId);
    const rawEvidence = input.evidenceText ?? input.outcome;
    const normalized = normalizeText(rawEvidence);
    if (!normalized) throw new ApiError(400, "empty_after_normalization", "Evidence is empty after normalization.");
    const contentHash = sha256(rawEvidence);
    const normalizedHash = sha256(normalized);
    const existing = deps.db.select().from(sources)
      .where(or(eq(sources.contentHash, contentHash), eq(sources.normalizedHash, normalizedHash))).get();

    let sourceId: string;
    let excerptIds: string[];
    let reusedSource = false;
    const now = nowIso();
    if (existing) {
      if (!sourceBelongsToProject(deps, existing.id, input.projectId)) {
        throw new ApiError(409, "capture_source_scope_conflict", "Identical evidence is already scoped to another project.");
      }
      sourceId = existing.id;
      reusedSource = true;
      excerptIds = deps.db.select({ id: sourceExcerpts.id }).from(sourceExcerpts)
        .where(eq(sourceExcerpts.sourceId, sourceId)).orderBy(sourceExcerpts.startOffset, sourceExcerpts.id).all().map((row) => row.id);
    } else {
      sourceId = newId();
      const chunks = chunkText(normalized);
      excerptIds = chunks.map(() => newId());
      deps.db.insert(sources).values({
        id: sourceId,
        kind: "paste",
        title: input.title ?? `Work capture: ${input.outcome.slice(0, 120)}`,
        originalFilename: null,
        contentHash,
        normalizedHash,
        importedAt: now,
        eventAt: input.eventAt,
        authorLabel: input.authorLabel ?? "agent via MCP capture_work",
        provenanceBasis: "uploader_metadata",
        projectId: input.projectId,
        originalText: rawEvidence,
        normalizedText: normalized,
        redactionState: "none",
      }).run();
      chunks.forEach((chunk, index) => {
        deps.db.insert(sourceExcerpts).values({
          id: excerptIds[index]!, sourceId, startOffset: chunk.startOffset, endOffset: chunk.endOffset,
          exactText: chunk.text, exactTextHash: sha256(chunk.text),
        }).run();
      });
      writeAudit(deps.db, { ...ctx, action: "source.imported", targetType: "source", targetId: sourceId,
        before: null, after: { sourceId, contentHash, normalizedHash, excerptCount: excerptIds.length },
        detail: { via: "capture_work" } });
    }

    if (excerptIds.length === 0) throw new ApiError(409, "capture_evidence_missing", "Captured evidence has no excerpts.");

    // Canonical duplicate identity intentionally keeps the historical hash
    // contract. Working-capture identity below is separate and includes
    // provenance/checkpoint semantics, without capturedAt.
    const canonicalHash = recordDedupHash({
      projectId: input.projectId,
      type: input.recordType,
      subject: input.subject,
      text: input.outcome,
    });
    const canonicalDuplicate = deps.db
      .select({ id: records.id })
      .from(records)
      .where(eq(records.recordDedupHash, canonicalHash))
      .all()
      .map((row) => requireRecord(deps, row.id))
      .find((row) => row.reviewStatus === "accepted");
    const canonicalDuplicateRecordId = canonicalDuplicate?.id ?? null;

    const checkpoint = buildCheckpoint(input, now);
    const created = createRecord(deps, {
      projectId: input.projectId,
      sourceExcerptId: excerptIds[0]!,
      recordType: input.recordType,
      subject: input.subject,
      text: input.outcome,
      evidenceBasis: "agent_report",
      sourceEventAt: input.eventAt,
      taskStatus: null,
      volatile: false,
      predicate: input.predicate ?? null,
      valueJson: checkpoint
        ? JSON.stringify(checkpoint)
        : input.structuredValueJson === undefined || input.structuredValueJson === null
          ? null
          : JSON.stringify(input.structuredValueJson),
      dedupIdentity: input.dedupIdentity ?? `agent_report:${checkpointIdentity(checkpoint)}`,
    }, ctx);
    const outcomeRecord = requireRecord(deps, created.record.id);
    if (outcomeRecord.reviewStatus !== "proposed" || outcomeRecord.evidenceBasis !== "agent_report") {
      throw new ApiError(409, "capture_working_identity_conflict", "Working capture identity resolved to a non-working record.");
    }

    let addedEvidence = 0;
    // A duplicate working proposal may gain additional evidence. Accepted
    // canonical records are never used as this target.
    for (const excerptId of excerptIds) {
      const inserted = deps.sqlite.prepare(
        "INSERT OR IGNORE INTO record_evidence(record_id,excerpt_id,relation,observed_at,environment,artifact_ref) VALUES(?,?,'supports',?,NULL,NULL)",
      ).run(outcomeRecord.id, excerptId, input.eventAt);
      addedEvidence += inserted.changes;
    }

    const progress = [];
    for (const update of input.progressUpdates) {
      const current = requireRecord(deps, update.recordId, update.revision);
      if (current.projectId !== input.projectId)
        throw new ApiError(409, "capture_progress_project_mismatch", "Progress target belongs to another project.");
      if (current.type !== "action")
        throw new ApiError(400, "capture_progress_requires_action", "Progress updates can target action records only.");
      if (current.reviewStatus !== "accepted")
        throw new ApiError(409, "capture_progress_requires_accepted_action", "Progress updates require an accepted action record.");
      if (current.taskStatus === update.taskStatus) {
        progress.push({ recordId: current.id, revision: current.revision, taskStatus: current.taskStatus, unchanged: true });
        continue;
      }
      const changed = editRecord(deps, current.id, {
        revision: current.revision,
        taskStatus: update.taskStatus,
      }, ctx);
      progress.push({ recordId: changed.id, revision: changed.revision, taskStatus: changed.taskStatus, unchanged: false });
    }

    // createRecord advances the working cursor for a newly created proposal.
    // Reusing the same semantic working record advances only when new evidence
    // was actually attached.
    if (created.duplicate && addedEvidence > 0) {
      bumpProjectWorkingMemoryVersion(deps.db, [input.projectId]);
    } else if (!created.duplicate && addedEvidence > 0) {
      const current = requireProject(deps, input.projectId);
      refreshContextCursorSnapshot(deps.db, input.projectId, "working", current.workingMemoryVersion);
    }

    const project = requireProject(deps, input.projectId);
    writeAudit(deps.db, { ...ctx, action: "work.captured", targetType: "project", targetId: input.projectId,
      before: null,
      after: { sourceId, outcomeRecordId: outcomeRecord.id, progressRecordIds: progress.map((item) => item.recordId) },
      detail: { reusedSource, evidenceExcerptCount: excerptIds.length, outcomeDuplicate: created.duplicate } });

    return {
      projectId: input.projectId,
      source: { id: sourceId, reused: reusedSource, excerptIds },
      outcome: { recordId: outcomeRecord.id, revision: outcomeRecord.revision, reviewStatus: outcomeRecord.reviewStatus,
        evidenceBasis: outcomeRecord.evidenceBasis, duplicate: created.duplicate, canonicalDuplicateRecordId },
      progressUpdates: progress,
      contentVersion: project.contentVersion,
      workingMemoryVersion: project.workingMemoryVersion,
      checkpoint: parseWorkingCheckpoint(outcomeRecord.valueJson),
    };
  })();
}
