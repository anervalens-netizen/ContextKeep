import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  LIFECYCLE_PREDICATE,
  relationKinds,
  type CorrectionInput,
  type CorrectionPreviewDto,
  type RecordDto,
  type SupersessionDto,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { importJobs, projects, recordEvidence, records, sourceExcerpts, sources, supersessions } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { recordDedupHash, sha256 } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { bumpProjectContentVersion } from "./content-version.js";
import { chunkText } from "./chunk.js";
import { isLifecycleRecord, parseLifecycleState } from "./review.js";
import { attachProjectNames, loadEvidenceFor, relationObjectValue, toRecordDto } from "./mappers.js";
import { normalizeText } from "./normalize.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

function isCycleError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("supersession cycle");
}

function correctionIntentHash(input: CorrectionInput, statement: string): string {
  return sha256(
    JSON.stringify({
      statement,
      projectId: input.projectId ?? null,
      scopeProjectIds: [...input.scopeProjectIds].sort(),
      supersedesRecordIds: [...input.supersedesRecordIds].sort(),
      lifecycleChange: input.lifecycleChange
        ? { projectId: input.lifecycleChange.projectId, state: input.lifecycleChange.state }
        : null,
      recordType: input.recordType,
      subject: input.subject,
      predicate: input.predicate,
      relationObject: input.relationObject,
    }),
  );
}

function readCorrectionIntentHash(usageJson: string | null): string | null {
  if (!usageJson) return null;
  try {
    const parsed = JSON.parse(usageJson) as { correction?: unknown; intentHash?: unknown };
    return parsed.correction === true && typeof parsed.intentHash === "string" ? parsed.intentHash : null;
  } catch {
    return null;
  }
}

interface CorrectionProposalManifestEntry {
  recordId: string;
  revision: number;
  recordDedupHash: string;
}

interface CorrectionUsage {
  correction?: unknown;
  proposedRecords?: unknown;
}

function readCorrectionManifest(usageJson: string | null): CorrectionProposalManifestEntry[] | null {
  if (!usageJson) return null;
  try {
    const parsed = JSON.parse(usageJson) as CorrectionUsage;
    if (parsed.correction !== true || !Array.isArray(parsed.proposedRecords)) return null;
    const manifest: CorrectionProposalManifestEntry[] = [];
    for (const item of parsed.proposedRecords) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.recordId !== "string" ||
        typeof entry.revision !== "number" ||
        !Number.isInteger(entry.revision) ||
        typeof entry.recordDedupHash !== "string"
      ) {
        return null;
      }
      manifest.push({ recordId: entry.recordId, revision: entry.revision, recordDedupHash: entry.recordDedupHash });
    }
    return manifest;
  } catch {
    return null;
  }
}

function recoverLegacyCorrectionManifest(
  db: Db,
  job: typeof importJobs.$inferSelect,
  input: CorrectionInput,
  statement: string,
): CorrectionProposalManifestEntry[] | null {
  if (!job.sourceId || input.scopeProjectIds.length > 0 || input.lifecycleChange) return null;
  const source = db.select().from(sources).where(eq(sources.id, job.sourceId)).get();
  if (
    !source ||
    source.kind !== "owner_correction" ||
    source.projectId !== input.projectId ||
    source.normalizedText !== statement
  ) {
    return null;
  }

  const excerptIds = db
    .select({ id: sourceExcerpts.id })
    .from(sourceExcerpts)
    .where(eq(sourceExcerpts.sourceId, source.id))
    .all()
    .map((excerpt) => excerpt.id);
  if (excerptIds.length === 0) return null;
  const evidence = db
    .select({ recordId: recordEvidence.recordId })
    .from(recordEvidence)
    .where(inArray(recordEvidence.excerptId, excerptIds))
    .all();
  const recordIds = [...new Set(evidence.map((row) => row.recordId))];
  if (recordIds.length !== 1) return null;

  const record = db.select().from(records).where(eq(records.id, recordIds[0]!)).get();
  if (
    !record ||
    record.reviewStatus !== "proposed" ||
    record.projectId !== input.projectId ||
    record.type !== input.recordType ||
    record.subject !== input.subject ||
    record.predicate !== input.predicate ||
    relationObjectValue(record.predicate, record.valueJson) !== input.relationObject ||
    record.text !== statement
  ) {
    return null;
  }

  const priorIds = db
    .select({ priorRecordId: supersessions.priorRecordId })
    .from(supersessions)
    .where(eq(supersessions.jobId, job.id))
    .all()
    .map((row) => row.priorRecordId)
    .sort();
  if (priorIds.join("\u0000") !== [...input.supersedesRecordIds].sort().join("\u0000")) return null;

  return [{ recordId: record.id, revision: record.revision, recordDedupHash: record.recordDedupHash }];
}

/**
 * Propose an owner correction (handoff §4 journey C).
 * Creates an owner_correction source, a proposed owner_declaration record,
 * and PROPOSED supersession rows for the claims it replaces (including the
 * current lifecycle record when a lifecycle change is requested).
 * Nothing changes the current brief until confirmCorrection (owner review).
 * The DB trigger rejects supersession cycles at insert time (A18).
 */
export function proposeCorrection(
  deps: ServiceDeps,
  input: CorrectionInput,
  ctx: ActorCtx,
): CorrectionPreviewDto {
  const { db } = deps;
  const now = nowIso();
  const jobId = newId();
  const warnings: string[] = [];
  const isRelation = input.predicate !== null && (relationKinds as readonly string[]).includes(input.predicate);
  if (isRelation && !input.relationObject) {
    throw new ApiError(400, "relation_object_required", "A multi-valued relation correction requires relationObject.");
  }
  if (!isRelation && input.relationObject) {
    throw new ApiError(400, "relation_object_requires_relation", "relationObject is valid only for relation predicates.");
  }

  if (!input.projectId && !input.lifecycleChange && input.supersedesRecordIds.length === 0) {
    throw new ApiError(
      400,
      "correction_needs_scope",
      "A correction must declare a project scope, a lifecycle change, or explicit supersession targets.",
    );
  }

  const statement = normalizeText(input.statement);
  if (statement.length === 0) {
    throw new ApiError(400, "empty_correction", "Correction statement is empty.");
  }

  // Validate supersession targets and precedence (A4) up front.
  const priors: (typeof records.$inferSelect)[] = [];
  for (const priorId of input.supersedesRecordIds) {
    const prior = db.select().from(records).where(eq(records.id, priorId)).get();
    if (!prior) {
      throw new ApiError(404, "supersession_target_not_found", `Record ${priorId} not found.`);
    }
    if (prior.reviewStatus !== "accepted") {
      throw new ApiError(
        409,
        "invalid_supersession_target",
        `Record ${priorId} is ${prior.reviewStatus}; only accepted records can be superseded.`,
      );
    }
    priors.push(prior);
  }

  let lifecycleProject: (typeof projects.$inferSelect) | null = null;
  let lifecyclePrior: (typeof records.$inferSelect) | null = null;
  if (input.lifecycleChange) {
    lifecycleProject =
      db.select().from(projects).where(eq(projects.id, input.lifecycleChange.projectId)).get() ?? null;
    if (!lifecycleProject) {
      throw new ApiError(404, "project_not_found", `Project ${input.lifecycleChange.projectId} not found.`);
    }
    if (lifecycleProject.lifecycleRecordId) {
      lifecyclePrior =
        db.select().from(records).where(eq(records.id, lifecycleProject.lifecycleRecordId)).get() ?? null;
    }
    if (lifecycleProject.lifecycle === "retired" && input.lifecycleChange.state !== "retired") {
      warnings.push(
        "This correction REACTIVATES or changes a retired project. That is only possible here — an explicit, reviewed owner correction — never through imports (A3/A19). The supersession is audited.",
      );
    }
  }

  for (const prior of priors) {
    if (isLifecycleRecord(prior) && input.lifecycleChange?.projectId !== prior.projectId) {
      throw new ApiError(
        409,
        "lifecycle_requires_transition",
        `Lifecycle record ${prior.id} can only be replaced through set_project_lifecycle or an explicit lifecycle correction.`,
        { priorRecordId: prior.id },
      );
    }
  }

  let preview!: CorrectionPreviewDto;
  try {
    db.transaction((tx) => {
      const contentHash = sha256(statement);
      const intentHash = correctionIntentHash(input, statement);

      // Idempotence is keyed by the complete correction intent, not only by its
      // human sentence. The same wording can legitimately target another project,
      // supersede other records, or request another lifecycle transition.
      const matchingSources = tx
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.kind, "owner_correction"), eq(sources.normalizedHash, contentHash)))
        .all();
      let existingJob: typeof importJobs.$inferSelect | undefined;
      const legacyJobs: (typeof importJobs.$inferSelect)[] = [];
      for (const source of matchingSources) {
        const presentedJobs = tx
          .select()
          .from(importJobs)
          .where(and(eq(importJobs.sourceId, source.id), eq(importJobs.stage, "presented")))
          .all();
        const candidate = presentedJobs.find((job) => readCorrectionIntentHash(job.usageJson) === intentHash);
        if (candidate) {
          existingJob = candidate;
          break;
        }
        legacyJobs.push(...presentedJobs.filter((job) => readCorrectionIntentHash(job.usageJson) === null));
      }

      // Before intentHash/manifest existed, recover only an unambiguous
      // single-record proposal from its immutable source/evidence topology. An
      // ambiguous legacy row is a deliberate fail-safe: never create a duplicate
      // correction whose original intent cannot be reconstructed.
      if (!existingJob && legacyJobs.length > 0) {
        const recovered = legacyJobs
          .map((job) => ({ job, manifest: recoverLegacyCorrectionManifest(tx, job, input, statement) }))
          .filter((entry): entry is { job: typeof importJobs.$inferSelect; manifest: CorrectionProposalManifestEntry[] } => entry.manifest !== null);
        if (legacyJobs.length !== 1 || recovered.length !== 1) {
          throw new ApiError(
            409,
            "correction_legacy_intent_ambiguous",
            "An older open correction matches this source text, but its original intent cannot be reconstructed safely. Review the existing proposal before submitting a new correction.",
            { jobIds: legacyJobs.map((job) => job.id) },
          );
        }
        const legacy = recovered[0]!;
        const upgradedUsage = JSON.stringify({
          correction: true,
          intentHash,
          proposedRecords: legacy.manifest,
        });
        tx.update(importJobs)
          .set({ usageJson: upgradedUsage, updatedAt: now })
          .where(eq(importJobs.id, legacy.job.id))
          .run();
        existingJob = { ...legacy.job, usageJson: upgradedUsage, updatedAt: now };
      }

      if (existingJob?.sourceId) {
        const manifest = readCorrectionManifest(existingJob.usageJson);
        const existingRecordIds = manifest?.map((entry) => entry.recordId) ?? [];
        const existingRecords = existingRecordIds.length
          ? tx.select().from(records).where(inArray(records.id, existingRecordIds)).all()
          : [];

        // Reuse only a still-pristine open proposal. If review already changed any
        // record, a re-submission is a new owner action rather than a stale alias.
        const pristine =
          manifest !== null &&
          existingRecords.length === manifest.length &&
          manifest.every((entry) => {
            const record = existingRecords.find((candidate) => candidate.id === entry.recordId);
            return (
              record?.reviewStatus === "proposed" &&
              record.revision === entry.revision &&
              record.recordDedupHash === entry.recordDedupHash
            );
          });
        if (pristine) {
          const existingSupers = tx
            .select()
            .from(supersessions)
            .where(eq(supersessions.jobId, existingJob.id))
            .all();
          const affectedIds = existingSupers.map((s) => s.priorRecordId);
          const affectedRows = affectedIds.length
            ? tx.select().from(records).where(inArray(records.id, affectedIds)).all()
            : [];
          const evidence = loadEvidenceFor(tx, existingRecords.map((r) => r.id));
          preview = {
            jobId: existingJob.id,
            proposedRecordIds: existingRecords.map((r) => r.id),
            affected: attachProjectNames(tx, affectedRows, evidence),
            warnings: ["Identical open correction intent found; returning the existing proposal (idempotent)."],
          };
          return;
        }

        if (manifest !== null && manifest.length > 1) {
          const changedRecordIds = manifest
            .filter((entry) => {
              const record = existingRecords.find((candidate) => candidate.id === entry.recordId);
              return (
                !record ||
                record.reviewStatus !== "proposed" ||
                record.revision !== entry.revision ||
                record.recordDedupHash !== entry.recordDedupHash
              );
            })
            .map((entry) => entry.recordId);
          throw new ApiError(
            409,
            "correction_proposal_changed",
            `Correction job ${existingJob.id} has a partially reviewed or changed multi-record proposal. Re-submit from the current reviewed state; no duplicate proposal was created.`,
            { jobId: existingJob.id, changedRecordIds },
          );
        }
      }

      // Preserve source content-hash semantics (hash of original normalized text).
      // If that exact text already exists, use a provenance/job-specific unique hash
      // for this additional source while normalizedHash still identifies the text.
      const importedSameHash = tx
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.contentHash, contentHash))
        .get();
      const effectiveHash = importedSameHash ? sha256(`${statement}\u0000correction\u0000${jobId}`) : contentHash;

      const sourceId = newId();
      const normalized = statement;
      tx.insert(sources)
        .values({
          id: sourceId,
          kind: "owner_correction",
          title: `Owner correction — ${now.slice(0, 10)}`,
          originalFilename: null,
          contentHash: effectiveHash,
          normalizedHash: sha256(normalized),
          importedAt: now,
          eventAt: now,
          authorLabel: "owner",
          provenanceBasis: "owner_review",
          projectId: input.projectId ?? input.lifecycleChange?.projectId ?? null,
          originalText: input.statement,
          normalizedText: normalized,
          redactionState: "none",
        })
        .run();

      const chunks = chunkText(normalized);
      const excerptIds: string[] = [];
      for (const c of chunks) {
        const id = newId();
        tx.insert(sourceExcerpts)
          .values({
            id,
            sourceId,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            exactText: c.text,
            exactTextHash: sha256(c.text),
          })
          .run();
        excerptIds.push(id);
      }
      const firstExcerptId = excerptIds[0]!;

      tx.insert(importJobs)
        .values({
          id: jobId,
          sourceId,
          stage: "presented",
          adapterId: "manual",
          adapterVersion: "1.0.0",
          providerModel: null,
          attempts: 1,
          errorCode: null,
          usageJson: JSON.stringify({ correction: true, intentHash }),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const proposedRecordIds: string[] = [];
      const supersessionIds: string[] = [];

      // Preview affected claims (A2): accepted records sharing subject+predicate
      // that are NOT already explicit supersession targets.
      const scopeProjectId = input.projectId ?? input.lifecycleChange?.projectId ?? null;
      let affectedClaims: (typeof records.$inferSelect)[] = [];
      if (input.predicate !== null) {
        affectedClaims = tx
          .select()
          .from(records)
          .where(
            and(
              scopeProjectId === null ? isNull(records.projectId) : eq(records.projectId, scopeProjectId),
              eq(records.subject, input.subject),
              eq(records.predicate, input.predicate),
              eq(records.reviewStatus, "accepted"),
            ),
          )
          .all()
          .filter((r) => !input.supersedesRecordIds.includes(r.id))
          .filter((r) => !isRelation || relationObjectValue(r.predicate, r.valueJson) === input.relationObject);
        if (affectedClaims.length > 0) {
          warnings.push(
            `A2: ${affectedClaims.length} accepted claim(s) share subject+predicate "${input.subject}/${input.predicate}"; confirming without superseding them will be refused. Add them to supersedesRecordIds.`,
          );
        }
      }

      function insertProposedRecord(opts: {
        projectId: string | null;
        type: string;
        subject: string;
        predicate?: string | null;
        valueJson?: unknown | null;
        text: string;
        dedupSalt?: string;
      }): string {
        const id = newId();
        const dedupText = opts.dedupSalt ? `${opts.text}\u0000${opts.dedupSalt}` : opts.text;
        tx.insert(records)
          .values({
            id,
            projectId: opts.projectId,
            type: opts.type,
            subject: opts.subject,
            predicate: opts.predicate ?? null,
            valueJson: opts.valueJson === null || opts.valueJson === undefined ? null : JSON.stringify(opts.valueJson),
            text: opts.text,
            reviewStatus: "proposed",
            evidenceBasis: "owner_declaration",
            taskStatus: null,
            recordDedupHash: recordDedupHash({
              projectId: opts.projectId,
              type: opts.type,
              subject: opts.subject,
              text: dedupText,
            }),
            recordedAt: now,
            sourceEventAt: now,
            effectiveFrom: null,
            effectiveTo: null,
            reviewedAt: null,
            reviewDueAt: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        tx.insert(recordEvidence)
          .values({
            recordId: id,
            excerptId: firstExcerptId,
            relation: "supports",
            observedAt: now,
            environment: null,
            artifactRef: null,
          })
          .run();
        proposedRecordIds.push(id);
        return id;
      }

      const mainRecordId = insertProposedRecord({
        projectId: input.projectId,
        type: input.recordType,
        subject: input.subject,
        predicate: input.predicate,
        valueJson: isRelation ? { object: input.relationObject } : null,
        text: statement,
        dedupSalt: input.lifecycleChange ? jobId : undefined,
      });

      for (const prior of priors) {
        const id = newId();
        tx.insert(supersessions)
          .values({
            id,
            priorRecordId: prior.id,
            replacementRecordId: mainRecordId,
            jobId,
            reason: statement,
            confirmedAt: null,
            confirmedBy: null,
            proposedAt: now,
          })
          .run();
        supersessionIds.push(id);
      }

      let lifecycleRecordId: string | null = null;
      if (input.lifecycleChange && lifecycleProject) {
        const state = input.lifecycleChange.state;
        lifecycleRecordId = insertProposedRecord({
          projectId: lifecycleProject.id,
          type: "fact",
          subject: `project:${lifecycleProject.name}`,
          predicate: LIFECYCLE_PREDICATE,
          valueJson: { state },
          text: `Lifecycle: ${state} — owner correction (${now.slice(0, 10)}): "${truncate(statement, 200)}"`,
        });
        if (lifecyclePrior) {
          const id = newId();
          tx.insert(supersessions)
            .values({
              id,
              priorRecordId: lifecyclePrior.id,
              replacementRecordId: lifecycleRecordId,
              jobId,
              reason: `Owner correction supersedes prior lifecycle declaration: ${truncate(statement, 200)}`,
              confirmedAt: null,
              confirmedBy: null,
              proposedAt: now,
            })
            .run();
          supersessionIds.push(id);
        } else {
          warnings.push(
            "No prior accepted lifecycle record exists for this project; the lifecycle change will apply on confirmation without supersession.",
          );
        }
      }

      writeAudit(tx, {
        actor: ctx.actor,
        action: "correction.proposed",
        targetType: "import_job",
        targetId: jobId,
        before: null,
        after: { jobId, sourceId, proposedRecordIds, supersessionIds },
        detail: { statement, scopeProjectIds: input.scopeProjectIds, lifecycleChange: input.lifecycleChange, intentHash },
        requestId: ctx.requestId ?? null,
      });
      for (const sid of supersessionIds) {
        writeAudit(tx, {
          actor: ctx.actor,
          action: "supersession.proposed",
          targetType: "supersession",
          targetId: sid,
          before: null,
          after: { jobId },
          requestId: ctx.requestId ?? null,
        });
      }

      tx.update(importJobs)
        .set({
          usageJson: JSON.stringify({
            correction: true,
            intentHash,
            proposedRecords: proposedRecordIds.map((recordId) => {
              const record = tx.select().from(records).where(eq(records.id, recordId)).get()!;
              return { recordId, revision: record.revision, recordDedupHash: record.recordDedupHash };
            }),
          }),
        })
        .where(eq(importJobs.id, jobId))
        .run();

      const affectedRows = [...priors, ...(lifecyclePrior ? [lifecyclePrior] : []), ...affectedClaims];
      const evidence = loadEvidenceFor(tx, proposedRecordIds);
      preview = {
        jobId,
        proposedRecordIds,
        affected: attachProjectNames(tx, affectedRows, evidence),
        warnings,
      };
    });
  } catch (e) {
    if (isCycleError(e)) {
      writeAudit(db, {
        actor: ctx.actor,
        action: "supersession.cycle_rejected",
        targetType: "import_job",
        targetId: jobId,
        detail: { reason: "DB trigger rejected a supersession cycle (A18)." },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(
        409,
        "supersession_cycle",
        "A18: this correction would create a supersession cycle (A→B and B→A). The database rejected it.",
      );
    }
    throw e;
  }
  return preview;
}

export interface CorrectionConfirmResult {
  jobId: string;
  acceptedRecordIds: string[];
  supersededRecordIds: string[];
  confirmedSupersessionIds: string[];
}

/**
 * Owner review step: confirm proposed supersessions (handoff §6 — an explicit
 * owner correction supersedes earlier owner declarations only AFTER review).
 * One transaction: accept replacements, supersede priors, confirm rows, update
 * lifecycle projections, write audit events (A15).
 * A4: a non-owner replacement (observed_technical / agent_report / document)
 * can NEVER supersede an owner declaration — refused with precedence_violation.
 */
export function confirmCorrection(
  deps: ServiceDeps,
  jobId: string,
  ctx: ActorCtx,
): CorrectionConfirmResult {
  const { db } = deps;
  const now = nowIso();
  const out: CorrectionConfirmResult = {
    jobId,
    acceptedRecordIds: [],
    supersededRecordIds: [],
    confirmedSupersessionIds: [],
  };

  db.transaction((tx) => {
    const changedProjectIds = new Set<string>();
    const job = tx.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
    if (!job) throw new ApiError(404, "job_not_found", `Correction job ${jobId} not found.`);
    const pending = tx
      .select()
      .from(supersessions)
      .where(and(eq(supersessions.jobId, jobId), isNull(supersessions.confirmedAt)))
      .all();
    const manifest = readCorrectionManifest(job.usageJson);
    if (job.sourceId && manifest === null) {
      throw new ApiError(
        409,
        "correction_proposal_membership_missing",
        `Correction job ${jobId} has no explicit proposal membership manifest; re-submit the correction before confirming.`,
      );
    }
    // Correction membership is explicit and immutable. Sharing the source's
    // evidence is not enough to join another record to this owner intent.
    const jobRecordIds = manifest?.map((entry) => entry.recordId) ?? [];
    const jobRecords = jobRecordIds.length
      ? tx.select().from(records).where(inArray(records.id, jobRecordIds)).all()
      : [];
    const proposedJobRecords = jobRecords.filter((r) => r.reviewStatus === "proposed");

    const changedManifestRecordIds =
      manifest?.filter((entry) => {
        const record = jobRecords.find((candidate) => candidate.id === entry.recordId);
        return (
          !record ||
          record.reviewStatus !== "proposed" ||
          record.revision !== entry.revision ||
          record.recordDedupHash !== entry.recordDedupHash
        );
      }).map((entry) => entry.recordId) ?? [];

    // A presented correction is an atomic reviewed intent. If Inbox/direct review
    // changed one of its records after preview, the preview is stale and must not
    // be allowed to retire earlier accepted truth.
    if (
      job.stage === "presented" &&
      (changedManifestRecordIds.length > 0 || (manifest !== null && jobRecords.length !== manifest.length))
    ) {
      throw new ApiError(
        409,
        "correction_proposal_changed",
        `Correction job ${jobId} changed after it was proposed. Re-submit the correction from the current state before confirming.`,
        {
          changedRecordIds: changedManifestRecordIds,
        },
      );
    }

    if (pending.length === 0 && proposedJobRecords.length === 0) {
      throw new ApiError(
        409,
        "nothing_to_confirm",
        `Job ${jobId} has no pending supersessions and no proposed records.`,
      );
    }

    if (job.stage !== "presented") {
      throw new ApiError(
        409,
        "correction_job_not_presented",
        `Correction job ${jobId} is ${job.stage}; only presented corrections can be confirmed.`,
      );
    }

    const jobRecordIdSet = new Set(jobRecordIds);

    // Step 1 — validate the complete supersession plan and A4 precedence up front:
    // fail before any mutation, so a stale/rejected replacement cannot retire truth.
    for (const s of pending) {
      const prior = tx.select().from(records).where(eq(records.id, s.priorRecordId)).get();
      const replacement = tx
        .select()
        .from(records)
        .where(eq(records.id, s.replacementRecordId))
        .get();
      if (!prior || !replacement) {
        throw new ApiError(409, "supersession_target_missing", `Supersession ${s.id} references missing records.`);
      }
      if (prior.reviewStatus !== "accepted") {
        throw new ApiError(
          409,
          "correction_proposal_changed",
          `Supersession ${s.id} is stale: prior record ${prior.id} is now ${prior.reviewStatus}, not accepted.`,
          { supersessionId: s.id, priorRecordId: prior.id, reviewStatus: prior.reviewStatus },
        );
      }
      if (replacement.reviewStatus !== "proposed") {
        throw new ApiError(
          409,
          "correction_proposal_changed",
          `Supersession ${s.id} is stale: replacement record ${replacement.id} is now ${replacement.reviewStatus}, not proposed.`,
          { supersessionId: s.id, replacementRecordId: replacement.id, reviewStatus: replacement.reviewStatus },
        );
      }
      if (manifest !== null && !jobRecordIdSet.has(replacement.id)) {
        throw new ApiError(
          409,
          "correction_replacement_outside_job",
          `Supersession ${s.id} points to replacement ${replacement.id}, which is not owned by correction job ${jobId}.`,
          { supersessionId: s.id, replacementRecordId: replacement.id },
        );
      }
      if (prior.evidenceBasis === "owner_declaration" && replacement.evidenceBasis !== "owner_declaration") {
        // NOTE: no audit write here — it would roll back with the transaction.
        // The confirm route audits the refusal AFTER the rollback (A15).
        throw new ApiError(
          409,
          "precedence_violation",
          `A4: a ${replacement.evidenceBasis} record cannot supersede an owner declaration (prior record ${prior.id}). Technical observations do not reverse owner decisions.`,
          { priorRecordId: prior.id, replacementRecordId: replacement.id, supersessionId: s.id },
        );
      }
      if (isLifecycleRecord(prior) && (!isLifecycleRecord(replacement) || replacement.projectId !== prior.projectId)) {
        throw new ApiError(
          409,
          "lifecycle_requires_transition",
          `Lifecycle record ${prior.id} can only be replaced by another lifecycle transition for the same project.`,
          { priorRecordId: prior.id, replacementRecordId: replacement.id },
        );
      }
    }

    // Step 2 — supersede priors + confirm supersessions BEFORE accepting replacements.
    for (const s of pending) {
      const prior = tx.select().from(records).where(eq(records.id, s.priorRecordId)).get()!;
      const replacement = tx.select().from(records).where(eq(records.id, s.replacementRecordId)).get()!;

      // Supersede the prior BEFORE any replacement is accepted — otherwise two
      // accepted records would briefly coexist and violate the A2 unique indexes.
      const before = { ...prior };
      tx.update(records)
        .set({
          reviewStatus: "superseded",
          effectiveTo: now,
          revision: prior.revision + 1,
          updatedAt: now,
        })
        .where(eq(records.id, prior.id))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "record.superseded",
        targetType: "record",
        targetId: prior.id,
        before,
        after: { ...before, reviewStatus: "superseded", effectiveTo: now },
        detail: { replacedBy: replacement.id, jobId },
        requestId: ctx.requestId ?? null,
      });
      if (prior.projectId) changedProjectIds.add(prior.projectId);
      out.supersededRecordIds.push(prior.id);

      const beforeSuper = { ...s };
      tx.update(supersessions)
        .set({ confirmedAt: now, confirmedBy: ctx.actor })
        .where(eq(supersessions.id, s.id))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "supersession.confirmed",
        targetType: "supersession",
        targetId: s.id,
        before: beforeSuper,
        after: { ...beforeSuper, confirmedAt: now, confirmedBy: ctx.actor },
        requestId: ctx.requestId ?? null,
      });
      out.confirmedSupersessionIds.push(s.id);
    }

    // Step 3 — accept the job's proposed records (A2 guard + lifecycle projection).
    for (const rec of proposedJobRecords) {
      if (rec.predicate !== null) {
        const conflicting = tx
          .select()
          .from(records)
          .where(
            and(
              rec.projectId === null ? isNull(records.projectId) : eq(records.projectId, rec.projectId),
              eq(records.subject, rec.subject),
              eq(records.predicate, rec.predicate),
              eq(records.reviewStatus, "accepted"),
            ),
          )
          .all()
          .filter((r) => r.id !== rec.id)
          .filter((r) => {
            const object = relationObjectValue(rec.predicate, rec.valueJson);
            return object === null || relationObjectValue(r.predicate, r.valueJson) === object;
          });
        if (conflicting.length > 0) {
          throw new ApiError(
            409,
            "requires_supersession",
            `A2: accepted claim(s) ${conflicting
              .map((c) => c.id)
              .join(", ")} share subject+predicate "${rec.subject}/${rec.predicate}". Supersede them explicitly in this correction before confirming.`,
            { conflictingRecordIds: conflicting.map((c) => c.id) },
          );
        }
      }
      const before = { ...rec };
      tx.update(records)
        .set({ reviewStatus: "accepted", reviewedAt: now, revision: rec.revision + 1, updatedAt: now })
        .where(eq(records.id, rec.id))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "record.accepted",
        targetType: "record",
        targetId: rec.id,
        before,
        after: { ...before, reviewStatus: "accepted", reviewedAt: now },
        detail: { via: "correction", jobId },
        requestId: ctx.requestId ?? null,
      });
      if (rec.projectId) changedProjectIds.add(rec.projectId);
      out.acceptedRecordIds.push(rec.id);

      // Lifecycle projection follows the accepted lifecycle record.
      if (isLifecycleRecord(rec) && rec.projectId) {
        const state = parseLifecycleState(rec.valueJson);
        const project = tx.select().from(projects).where(eq(projects.id, rec.projectId)).get();
        if (state && project) {
          tx.update(projects)
            .set({
              lifecycle: state,
              lifecycleRecordId: rec.id,
              revision: project.revision + 1,
              updatedAt: now,
            })
            .where(eq(projects.id, project.id))
            .run();
        }
      }
    }

    bumpProjectContentVersion(tx, changedProjectIds);
    tx.update(importJobs).set({ stage: "done", updatedAt: now }).where(eq(importJobs.id, jobId)).run();
  });

  return out;
}

export function getCorrectionState(
  deps: ServiceDeps,
  jobId: string,
): { jobId: string; stage: string; supersessions: SupersessionDto[]; proposedRecords: RecordDto[] } {
  const { db } = deps;
  const job = db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new ApiError(404, "job_not_found", `Correction job ${jobId} not found.`);
  const supers = db.select().from(supersessions).where(eq(supersessions.jobId, jobId)).all();
  const manifest = readCorrectionManifest(job.usageJson);
  const jobRecordIds = manifest?.map((entry) => entry.recordId) ?? [];
  const proposed = jobRecordIds.length
    ? db.select().from(records).where(inArray(records.id, jobRecordIds)).all()
    : [];
  const evidence = loadEvidenceFor(db, proposed.map((r) => r.id));
  return {
    jobId,
    stage: job.stage,
    supersessions: supers.map((s) => ({
      id: s.id,
      priorRecordId: s.priorRecordId,
      replacementRecordId: s.replacementRecordId,
      reason: s.reason,
      confirmedAt: s.confirmedAt,
      confirmedBy: s.confirmedBy,
      proposedAt: s.proposedAt,
    })),
    proposedRecords: attachProjectNames(db, proposed, evidence),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export { toRecordDto };
