import { and, eq, isNull } from "drizzle-orm";
import {
  LifecycleState,
  LIFECYCLE_PREDICATE,
  type RecordDto,
  type ReviewDecisionInput,
  type ReviewEditInput,
  type ReviewResultDto,
  type TaskStatus,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { conflicts, projects, records, recordEvidence } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { recordDedupHash } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { bumpProjectContentVersion, bumpProjectWorkingMemoryVersion } from "./content-version.js";
import { attachProjectNames, loadEvidenceFor, parseJson, relationObjectValue, toRecordDto } from "./mappers.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

export interface DecideInput extends ReviewDecisionInput {
  /** A19: explicit owner action required to accept facts about retired projects. */
  ownerAction?: boolean;
}

export function isLifecycleRecord(row: { type: string; predicate: string | null }): boolean {
  return row.type === "fact" && row.predicate === LIFECYCLE_PREDICATE;
}

export function parseLifecycleState(valueJson: string | null): LifecycleState | null {
  const parsed = parseJson<{ state?: unknown } | null>(valueJson, null);
  if (!parsed || typeof parsed.state !== "string") return null;
  const checked = LifecycleState.safeParse(parsed.state);
  return checked.success ? checked.data : null;
}

/**
 * Review inbox decisions (handoff §8 steps 6-7, M0 scope 4).
 * The whole batch applies in ONE transaction: accepts + lifecycle projection
 * updates + audit events commit atomically or roll back entirely (A6, A15).
 * Blocked items are reported per-record without aborting the rest.
 *
 * Guards:
 * - A2:  structured claims (predicate != null) cannot both remain accepted;
 *        a contradiction blocks with requires_supersession and records a Conflict.
 * - A3:  lifecycle reactivation of a retired project via the inbox is refused;
 *        only the owner corrections workflow (reviewed supersession) can do it.
 * - A19: accepting ANY record scoped to a retired project requires the explicit
 *        ownerAction flag.
 * - A22: only acceptance moves records into the brief; "agent reported done"
 *        stays a proposal until accepted here.
 * - Stale edits are rejected via the revision field (handoff §7).
 */
export function decideReview(deps: ServiceDeps, input: DecideInput, ctx: ActorCtx): ReviewResultDto {
  const { db } = deps;
  const result: ReviewResultDto = { accepted: [], rejected: [], edited: [], blocked: [] };
  if (input.items.length === 0) {
    throw new ApiError(400, "no_review_items", "Review items must not be empty.");
  }
  const now = nowIso();

  db.transaction((tx) => {
    // CK-A01: revision preflight is intentionally the first operation inside
    // the same transaction that performs the review. A stale/missing target,
    // contradictory duplicate, or edit/selection revision mismatch aborts the
    // whole request before any record/audit/cursor mutation can occur.
    const expectedById = new Map<string, number>();
    const currentById = new Map<string, typeof records.$inferSelect>();
    const uniqueItems: typeof input.items = [];
    for (const item of input.items) {
      const priorRevision = expectedById.get(item.recordId);
      if (priorRevision !== undefined) {
        if (priorRevision !== item.revision) {
          throw new ApiError(
            409,
            "review_revision_conflict",
            `Record ${item.recordId} was submitted more than once with different revisions.`,
            { recordId: item.recordId, revisions: [priorRevision, item.revision] },
          );
        }
        continue;
      }
      expectedById.set(item.recordId, item.revision);
      const rec = tx.select().from(records).where(eq(records.id, item.recordId)).get();
      if (!rec) {
        throw new ApiError(
          404,
          "record_not_found",
          `Record ${item.recordId} does not exist. Reload the inbox before deciding.`,
          { recordId: item.recordId },
        );
      }
      if (rec.revision !== item.revision) {
        throw new ApiError(
          409,
          "stale_revision",
          `Record changed: server revision is ${rec.revision}, client read ${item.revision}. Reload and decide again.`,
          { recordId: item.recordId, serverRevision: rec.revision, clientRevision: item.revision },
        );
      }
      currentById.set(item.recordId, rec);
      uniqueItems.push(item);
    }
    for (const [recordId, edit] of Object.entries(input.edits)) {
      const selectedRevision = expectedById.get(recordId);
      if (selectedRevision === undefined) {
        throw new ApiError(
          400,
          "review_edit_not_selected",
          `Edit for record ${recordId} has no matching review item.`,
          { recordId },
        );
      }
      if (edit.revision !== selectedRevision) {
        throw new ApiError(
          409,
          "review_edit_revision_mismatch",
          `Edit revision ${edit.revision} does not match selected revision ${selectedRevision} for record ${recordId}.`,
          { recordId, selectedRevision, editRevision: edit.revision },
        );
      }
    }

    const changedProjectIds = new Set<string>();
    const changedWorkingMemoryProjectIds = new Set<string>();
    for (const { recordId } of uniqueItems) {
      const rec = currentById.get(recordId)!;
      if (rec.reviewStatus !== "proposed") {
        result.blocked.push({
          recordId,
          code: "already_reviewed",
          message: `Record is already ${rec.reviewStatus}; only proposed records can be decided.`,
        });
        continue;
      }

      if (input.action === "reject") {
        const before = { ...rec };
        tx.update(records)
          .set({ reviewStatus: "rejected", revision: rec.revision + 1, updatedAt: now })
          .where(eq(records.id, recordId))
          .run();
        writeAudit(tx, {
          actor: ctx.actor,
          action: "record.rejected",
          targetType: "record",
          targetId: recordId,
          before,
          after: { ...before, reviewStatus: "rejected", revision: before.revision + 1 },
          requestId: ctx.requestId ?? null,
        });
        result.rejected.push(recordId);
        if (rec.evidenceBasis === "agent_report" && rec.projectId) changedWorkingMemoryProjectIds.add(rec.projectId);
        continue;
      }

      // ---- accept ----
      const edit: ReviewEditInput | undefined = input.edits[recordId];
      let working = { ...rec };
      let edited = false;
      if (edit) {
        if (edit.text !== undefined) working.text = edit.text;
        if (edit.subject !== undefined) working.subject = edit.subject;
        if (edit.type !== undefined) working.type = edit.type;
        if (edit.projectId !== undefined) working.projectId = edit.projectId;
        if (edit.taskStatus !== undefined) working.taskStatus = edit.taskStatus;
        edited = true;
      }

      const project = working.projectId
        ? (tx.select().from(projects).where(eq(projects.id, working.projectId!)).get() ?? null)
        : null;
      const lifecycle = isLifecycleRecord(working);

      if (lifecycle && !project) {
        result.blocked.push({
          recordId,
          code: "lifecycle_requires_project",
          message: "Lifecycle records must be scoped to a project to update its projection.",
        });
        continue;
      }

      if (project?.lifecycle === "retired") {
        if (lifecycle) {
          const state = parseLifecycleState(working.valueJson);
          if (state !== "retired") {
            result.blocked.push({
              recordId,
              code: "retired_reactivation_requires_correction",
              message:
                "A3: imports cannot reactivate a retired project. Use the corrections workflow with an explicit owner declaration and reviewed supersession.",
            });
            writeAudit(tx, {
              actor: ctx.actor,
              action: "lifecycle.rejected_retired_reactivation",
              targetType: "record",
              targetId: recordId,
              before: rec,
              after: null,
              detail: { projectId: project.id, attemptedState: state },
              requestId: ctx.requestId ?? null,
            });
            continue;
          }
        } else if (!input.ownerAction) {
          result.blocked.push({
            recordId,
            code: "retired_project_requires_owner_action",
            message:
              'A19: facts about a retired project require an explicit owner action. Re-submit with ownerAction=true if you (the owner) intend this.',
          });
          continue;
        }
      }

      // A2: contradiction check for structured claims.
      if (working.predicate !== null) {
        const conflicting = tx
          .select()
          .from(records)
          .where(
            and(
              working.projectId === null
                ? isNull(records.projectId)
                : eq(records.projectId, working.projectId),
              eq(records.subject, working.subject),
              eq(records.predicate, working.predicate),
              eq(records.reviewStatus, "accepted"),
            ),
          )
          .all()
          .filter((r) => r.id !== recordId);
        const newHash = recordDedupHash({
          projectId: working.projectId,
          type: working.type,
          subject: working.subject,
          text: working.text,
        });
        const newRelationObject = relationObjectValue(working.predicate, working.valueJson);
        const blockers = conflicting.filter((r) => {
          if (newRelationObject !== null) {
            // Relations are multi-valued: distinct objects under the same
            // subject/predicate are compatible; the same object remains a
            // duplicate/contradiction and must not be accepted twice.
            const priorObject = relationObjectValue(r.predicate, r.valueJson);
            return priorObject === newRelationObject && r.recordDedupHash !== newHash;
          }
          return lifecycle ? true : r.recordDedupHash !== newHash;
        });
        if (blockers.length > 0) {
          const conflictId = newId();
          const recordIdsJson = JSON.stringify([...blockers.map((b) => b.id), recordId]);
          tx.insert(conflicts)
            .values({
              id: conflictId,
              projectId: working.projectId,
              recordIdsJson,
              status: "unresolved",
              resolutionRecordId: null,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          writeAudit(tx, {
            actor: ctx.actor,
            action: "conflict.created",
            targetType: "record",
            targetId: recordId,
            before: rec,
            after: null,
            detail: { conflictId, priorRecordIds: blockers.map((b) => b.id) },
            requestId: ctx.requestId ?? null,
          });
          result.blocked.push({
            recordId,
            code: "requires_supersession",
            message:
              "A2: a contradicting record is already accepted. Resolve via the corrections workflow (explicit supersession); both cannot remain accepted.",
          });
          continue;
        }
      }

      const supportingEvidence = tx
        .select({ recordId: recordEvidence.recordId })
        .from(recordEvidence)
        .where(and(eq(recordEvidence.recordId, recordId), eq(recordEvidence.relation, "supports")))
        .get();
      if (!supportingEvidence) {
        result.blocked.push({
          recordId,
          code: "evidence_required",
          message: "A record needs at least one supporting evidence excerpt before it can become canonical.",
        });
        continue;
      }

      const before = { ...rec };
      const newHash = recordDedupHash({
        projectId: working.projectId,
        type: working.type,
        subject: working.subject,
        text: working.text,
      });
      // A11: volatile fact — stamp review_due_at = now + intervalDays on accept.
      // Stable decisions (volatile=0) keep review_due_at = null forever.
      const reviewDueAt =
        working.volatile === 1
          ? new Date(
              new Date(now).getTime() +
                deps.volatileReviewIntervalDays * 24 * 60 * 60 * 1000,
            ).toISOString()
          : null;
      const afterRow = {
        ...working,
        recordDedupHash: newHash,
        reviewStatus: "accepted",
        reviewedAt: now,
        reviewDueAt,
        revision: rec.revision + 1,
        updatedAt: now,
      };
      tx.update(records)
        .set({
          text: working.text,
          subject: working.subject,
          type: working.type,
          projectId: working.projectId,
          taskStatus: working.taskStatus,
          recordDedupHash: newHash,
          reviewStatus: "accepted",
          reviewedAt: now,
          reviewDueAt,
          revision: rec.revision + 1,
          updatedAt: now,
        })
        .where(eq(records.id, recordId))
        .run();

      // Lifecycle projection (handoff §7): the brief's lifecycle comes from this record.
      if (lifecycle && project) {
        const state = parseLifecycleState(working.valueJson);
        if (state) {
          tx.update(projects)
            .set({
              lifecycle: state,
              lifecycleRecordId: recordId,
              revision: project.revision + 1,
              updatedAt: now,
            })
            .where(eq(projects.id, project.id))
            .run();
        }
      }

      writeAudit(tx, {
        actor: ctx.actor,
        action: "record.accepted",
        targetType: "record",
        targetId: recordId,
        before,
        after: afterRow,
        detail: edited ? { edited: true } : undefined,
        requestId: ctx.requestId ?? null,
      });
      if (edited) {
        writeAudit(tx, {
          actor: ctx.actor,
          action: "record.edited",
          targetType: "record",
          targetId: recordId,
          before,
          after: working,
          requestId: ctx.requestId ?? null,
        });
        result.edited.push(recordId);
      }
      if (working.projectId) changedProjectIds.add(working.projectId);
      if (rec.evidenceBasis === "agent_report" && rec.projectId) changedWorkingMemoryProjectIds.add(rec.projectId);
      result.accepted.push(recordId);
    }
    bumpProjectContentVersion(tx, changedProjectIds);
    bumpProjectWorkingMemoryVersion(tx, changedWorkingMemoryProjectIds);
  });

  return result;
}

/**
 * Direct record edit with optimistic concurrency (revision → 409 stale_revision).
 * Semantic identity fields are mutable only while a record is still proposed;
 * accepted/rejected/superseded history must be changed through corrections so
 * provenance and supersession remain explicit. Operational taskStatus may still
 * be updated directly.
 */
export function editRecord(
  deps: ServiceDeps,
  recordId: string,
  input: { revision: number; text?: string; subject?: string; type?: string; projectId?: string | null; taskStatus?: TaskStatus | null },
  ctx: ActorCtx,
): RecordDto {
  const { db } = deps;
  const now = nowIso();
  let dto!: RecordDto;
  db.transaction((tx) => {
    const rec = tx.select().from(records).where(eq(records.id, recordId)).get();
    if (!rec) throw new ApiError(404, "record_not_found", `Record ${recordId} not found.`);
    if (input.revision !== rec.revision) {
      throw new ApiError(
        409,
        "stale_revision",
        `Stale edit: server revision is ${rec.revision}, client sent ${input.revision}. Reload and retry.`,
        { serverRevision: rec.revision },
      );
    }

    const semanticChange =
      (input.text !== undefined && input.text !== rec.text) ||
      (input.subject !== undefined && input.subject !== rec.subject) ||
      (input.type !== undefined && input.type !== rec.type) ||
      (input.projectId !== undefined && input.projectId !== rec.projectId);
    if (semanticChange && rec.reviewStatus !== "proposed") {
      throw new ApiError(
        409,
        "semantic_edit_requires_correction",
        `Record ${recordId} is ${rec.reviewStatus}; accepted or historical semantic content is immutable in-place. Use the corrections workflow so the prior record remains traceable.`,
        { reviewStatus: rec.reviewStatus, recordId },
      );
    }

    const before = { ...rec };
    const nextType = input.type ?? rec.type;
    const next = {
      text: input.text ?? rec.text,
      subject: input.subject ?? rec.subject,
      type: nextType,
      projectId: input.projectId !== undefined ? input.projectId : rec.projectId,
      taskStatus: nextType === "action"
        ? (input.taskStatus !== undefined ? input.taskStatus : rec.taskStatus)
        : null,
    };
    const materialChange = semanticChange || next.taskStatus !== rec.taskStatus;
    if (!materialChange) {
      const evidence = loadEvidenceFor(tx, [recordId]);
      dto = attachProjectNames(tx, [rec], evidence)[0]!;
      return;
    }

    const newHash = recordDedupHash({
      projectId: next.projectId,
      type: next.type,
      subject: next.subject,
      text: next.text,
    });
    tx.update(records)
      .set({ ...next, recordDedupHash: newHash, revision: rec.revision + 1, updatedAt: now })
      .where(eq(records.id, recordId))
      .run();
    if (rec.reviewStatus === "accepted" && input.taskStatus !== undefined && input.taskStatus !== rec.taskStatus && rec.projectId) {
      bumpProjectContentVersion(tx, [rec.projectId]);
    }
    if (rec.reviewStatus === "proposed" && rec.evidenceBasis === "agent_report") {
      bumpProjectWorkingMemoryVersion(tx, [rec.projectId, next.projectId]);
    }
    writeAudit(tx, {
      actor: ctx.actor,
      action: "record.edited",
      targetType: "record",
      targetId: recordId,
      before,
      after: { ...before, ...next, recordDedupHash: newHash, revision: before.revision + 1 },
      requestId: ctx.requestId ?? null,
    });
    const row = tx.select().from(records).where(eq(records.id, recordId)).get()!;
    const evidence = loadEvidenceFor(tx, [recordId]);
    dto = attachProjectNames(tx, [row], evidence)[0]!;
  });
  return dto;
}

export { toRecordDto };
