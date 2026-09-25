import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  AdapterCandidate,
  AdapterExtractInput,
  AdapterUsage,
  ExistingSourceExtractionResultDto,
  ExtractionAdapter,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { importJobs, projects, recordEvidence, records, sourceExcerpts, sources } from "../db/schema.js";
import { sourceExtractions } from "../db/sync-schema.js";
import { AdapterDisabledError } from "../adapters/registry.js";
import { ApiError } from "../lib/errors.js";
import { recordDedupHash } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { chunkText } from "./chunk.js";
import { bumpProjectWorkingMemoryVersion } from "./content-version.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import { normalizeText } from "./normalize.js";
import { sourceBelongsToProject } from "./source-membership.js";

const VALID_CANDIDATE_TYPES = new Set(["fact", "decision", "action", "constraint", "question"]);
const VALID_EVIDENCE_BASES = new Set([
  "owner_declaration",
  "agent_report",
  "document",
  "observed_technical",
]);
const VALID_TASK_STATUSES = new Set(["open", "in_progress", "blocked", "done", "cancelled"]);

function throwIfExtractionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new ApiError(409, "sync_interrupted", "Extraction was interrupted before completion.");
}

/**
 * Provider output is untrusted runtime data even when the adapter's TypeScript
 * contract says otherwise. Validate every field that can reach a NOT NULL,
 * enum-like, or JSON persistence boundary before opening the SQL transaction.
 */
function isPersistableCandidate(value: unknown): value is AdapterCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    VALID_CANDIDATE_TYPES.has(candidate.type) &&
    typeof candidate.subject === "string" &&
    candidate.subject.trim().length > 0 &&
    typeof candidate.text === "string" &&
    candidate.text.trim().length > 0 &&
    typeof candidate.evidenceBasis === "string" &&
    VALID_EVIDENCE_BASES.has(candidate.evidenceBasis) &&
    typeof candidate.excerptId === "string" &&
    candidate.excerptId.length > 0 &&
    (candidate.predicate === undefined || candidate.predicate === null || typeof candidate.predicate === "string") &&
    (candidate.taskStatus === undefined || candidate.taskStatus === null ||
      (typeof candidate.taskStatus === "string" && VALID_TASK_STATUSES.has(candidate.taskStatus))) &&
    (candidate.sourceEventAt === undefined || candidate.sourceEventAt === null || typeof candidate.sourceEventAt === "string") &&
    (candidate.relation === undefined || candidate.relation === null || candidate.relation === "supports" || candidate.relation === "contradicts") &&
    (candidate.confidence === undefined || candidate.confidence === null ||
      (typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence))) &&
    (candidate.volatile === undefined || typeof candidate.volatile === "boolean")
  );
}

export interface ExtractionEstimate {
  adapterId: string;
  adapterVersion: string;
  usage: AdapterUsage | null;
  excerptCount: number;
  normalizedChars: number;
}

function adapterOrApiError(deps: ServiceDeps, adapterId: string): ExtractionAdapter {
  try {
    return deps.registry.get(adapterId);
  } catch (error) {
    if (error instanceof AdapterDisabledError) {
      throw new ApiError(409, "adapter_disabled", error.message);
    }
    throw error;
  }
}

function extractionAdapterOrApiError(
  deps: ServiceDeps,
  adapterId: string,
  sourceId: string,
  ctx: ActorCtx,
): ExtractionAdapter {
  try {
    return deps.registry.get(adapterId);
  } catch (error) {
    if (error instanceof AdapterDisabledError) {
      writeAudit(deps.db, {
        actor: ctx.actor,
        action: "provider_call.refused_disabled",
        targetType: "adapter",
        targetId: error.adapterId,
        detail: { reason: error.message, sourceId, operation: "extract_existing_source" },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(409, "adapter_disabled", error.message);
    }
    throw error;
  }
}

async function preflight(
  deps: ServiceDeps,
  adapter: ExtractionAdapter,
  input: AdapterExtractInput,
): Promise<AdapterUsage | null> {
  const isFree = adapter.costCategory === "free";
  const estimateFn = adapter.estimateUsage;
  if (!isFree && typeof estimateFn !== "function") {
    throw new ApiError(
      409,
      "estimate_required",
      `Paid adapter "${adapter.id}" does not implement estimateUsage; cannot verify cost ceiling.`,
    );
  }
  const estimate = typeof estimateFn === "function" ? await estimateFn(input) : null;
  if (!isFree && estimate === null) {
    throw new ApiError(
      409,
      "estimate_required",
      `Paid adapter "${adapter.id}" returned no cost estimate; cannot verify cost ceiling.`,
    );
  }
  if (estimate && (!Number.isFinite(estimate.estCostUsd) || estimate.estCostUsd < 0)) {
    throw new ApiError(409, "estimate_invalid", `Adapter "${adapter.id}" returned an invalid cost estimate.`);
  }
  if (estimate && estimate.estCostUsd > deps.costCeilingUsd) {
    throw new ApiError(
      409,
      "cost_ceiling_exceeded",
      `Provider cost estimate $${estimate.estCostUsd.toFixed(4)} exceeds the per-import ceiling ($${deps.costCeilingUsd.toFixed(2)}).`,
      { estCostUsd: estimate.estCostUsd, ceilingUsd: deps.costCeilingUsd },
    );
  }
  return estimate;
}

function previewInput(
  text: string,
  projectId: string | null,
  authorLabel: string | null,
  eventAt: string | null,
): { input: AdapterExtractInput; normalizedChars: number } {
  const normalized = normalizeText(text);
  if (!normalized) throw new ApiError(400, "empty_after_normalization", "Text is empty after normalization.");
  const chunks = chunkText(normalized);
  return {
    normalizedChars: normalized.length,
    input: {
      sourceId: "sync-preview",
      projectId,
      authorLabel,
      eventAt,
      excerpts: chunks.map((chunk, index) => ({
        id: `preview-${String(index).padStart(28, "0")}`,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
      })),
    },
  };
}

export async function estimateTextExtraction(
  deps: ServiceDeps,
  opts: {
    text: string;
    projectId: string | null;
    authorLabel: string | null;
    eventAt: string | null;
    adapterId: string;
  },
): Promise<ExtractionEstimate> {
  const adapter = adapterOrApiError(deps, opts.adapterId);
  const { input, normalizedChars } = previewInput(opts.text, opts.projectId, opts.authorLabel, opts.eventAt);
  const usage = await preflight(deps, adapter, input);
  return {
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    usage,
    excerptCount: input.excerpts.length,
    normalizedChars,
  };
}

function sourceInput(
  deps: ServiceDeps,
  sourceId: string,
  projectIdOverride: string | null | undefined,
): {
  source: typeof sources.$inferSelect;
  projectId: string | null;
  input: AdapterExtractInput;
} {
  const source = deps.db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) throw new ApiError(404, "source_not_found", `Source ${sourceId} not found.`);
  const projectId = projectIdOverride === undefined ? source.projectId : projectIdOverride;
  if (projectId) {
    const project = deps.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new ApiError(404, "project_not_found", `Project ${projectId} not found.`);
    if (projectIdOverride !== undefined && !sourceBelongsToProject(deps, sourceId, projectId)) {
      throw new ApiError(
        409,
        "evidence_project_mismatch",
        "Extraction project override is outside the source canonical project membership.",
        { sourceId, projectId },
      );
    }
  }
  const excerpts = deps.db
    .select()
    .from(sourceExcerpts)
    .where(eq(sourceExcerpts.sourceId, sourceId))
    .all()
    .sort((a, b) => a.startOffset - b.startOffset);
  if (excerpts.length === 0) {
    throw new ApiError(409, "source_has_no_excerpts", "Existing source has no immutable excerpts to extract.");
  }
  return {
    source,
    projectId,
    input: {
      sourceId,
      projectId,
      authorLabel: source.authorLabel,
      eventAt: source.eventAt,
      excerpts: excerpts.map((excerpt) => ({
        id: excerpt.id,
        text: excerpt.exactText,
        startOffset: excerpt.startOffset,
        endOffset: excerpt.endOffset,
      })),
    },
  };
}

export async function estimateExistingSource(
  deps: ServiceDeps,
  sourceId: string,
  adapterId: string,
  projectIdOverride?: string | null,
): Promise<ExtractionEstimate> {
  const adapter = adapterOrApiError(deps, adapterId);
  const { input } = sourceInput(deps, sourceId, projectIdOverride);
  const usage = await preflight(deps, adapter, input);
  return {
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    usage,
    excerptCount: input.excerpts.length,
    normalizedChars: input.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0),
  };
}

export function hasCompletedExtraction(
  deps: ServiceDeps,
  sourceId: string,
  projectId: string | null,
  adapterId: string,
  adapterVersion: string,
): boolean {
  return Boolean(
    deps.db
      .select({ id: sourceExtractions.id })
      .from(sourceExtractions)
      .where(
        and(
          eq(sourceExtractions.sourceId, sourceId),
          eq(sourceExtractions.projectKey, projectId ?? ""),
          eq(sourceExtractions.adapterId, adapterId),
          eq(sourceExtractions.adapterVersion, adapterVersion),
          eq(sourceExtractions.stage, "done"),
        ),
      )
      .get(),
  );
}

export const MAX_EXTRACTION_PROVIDER_ATTEMPTS = 3;
type ClaimResult = "claimed" | "done" | "busy" | "retry_exhausted";

/**
 * Claim the unique extraction target before any await/provider work. SQLite's
 * unique target index is the concurrency authority: exactly one request may
 * own `pending`; failed work may be atomically reclaimed, done work is final.
 */
function claimExtractionTarget(
  deps: ServiceDeps,
  opts: { sourceId: string; projectId: string | null; adapterId: string; adapterVersion: string },
): ClaimResult {
  const projectKey = opts.projectId ?? "";
  const stamp = nowIso();
  const inserted = deps.sqlite.prepare(`
    INSERT INTO source_extractions(
      id,source_id,project_id,project_key,adapter_id,adapter_version,stage,attempts,
      last_job_id,last_error_code,preflight_usage_json,actual_usage_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'pending',0,NULL,NULL,NULL,NULL,?,?)
    ON CONFLICT(source_id,project_key,adapter_id,adapter_version) DO NOTHING
  `).run(
    newId(),
    opts.sourceId,
    opts.projectId,
    projectKey,
    opts.adapterId,
    opts.adapterVersion,
    stamp,
    stamp,
  );
  if (inserted.changes === 1) return "claimed";

  const current = deps.sqlite.prepare(`
    SELECT id,stage,attempts,last_error_code AS lastErrorCode FROM source_extractions
    WHERE source_id=? AND project_key=? AND adapter_id=? AND adapter_version=?
  `).get(opts.sourceId, projectKey, opts.adapterId, opts.adapterVersion) as
    | { id: string; stage: string; attempts: number; lastErrorCode: string | null }
    | undefined;
  if (!current) return "busy";
  if (current.stage === "done") return "done";
  if (current.stage === "pending") return "busy";
  if (current.stage === "failed") {
    if (current.attempts >= MAX_EXTRACTION_PROVIDER_ATTEMPTS) {
      return "retry_exhausted";
    }
    const reclaimed = deps.sqlite.prepare(`
      UPDATE source_extractions
      SET project_id=?, stage='pending', last_job_id=NULL,
          last_error_code=NULL, preflight_usage_json=NULL, actual_usage_json=NULL, updated_at=?
      WHERE id=? AND stage='failed'
    `).run(opts.projectId, stamp, current.id);
    return reclaimed.changes === 1 ? "claimed" : "busy";
  }
  return "busy";
}

function recordProviderAttempt(
  deps: ServiceDeps,
  opts: { sourceId: string; projectId: string | null; adapterId: string; adapterVersion: string },
): void {
  const result = deps.sqlite.prepare(`
    UPDATE source_extractions
    SET attempts=attempts+1, updated_at=?
    WHERE source_id=? AND project_key=? AND adapter_id=? AND adapter_version=? AND stage='pending'
  `).run(
    nowIso(),
    opts.sourceId,
    opts.projectId ?? "",
    opts.adapterId,
    opts.adapterVersion,
  );
  if (result.changes !== 1) {
    throw new ApiError(409, "extraction_claim_lost", "Extraction claim was lost before the provider call.");
  }
}

function updateExtractionState(
  db: Db,
  opts: {
    sourceId: string;
    projectId: string | null;
    adapterId: string;
    adapterVersion: string;
    stage: "pending" | "done" | "failed";
    jobId: string | null;
    errorCode?: string | null;
    preflightUsage?: AdapterUsage | null;
    actualUsage?: AdapterUsage | null;
  },
): void {
  db.update(sourceExtractions)
    .set({
      projectId: opts.projectId,
      stage: opts.stage,
      lastJobId: opts.jobId,
      lastErrorCode: opts.errorCode ?? null,
      preflightUsageJson: opts.preflightUsage ? JSON.stringify(opts.preflightUsage) : null,
      actualUsageJson: opts.actualUsage ? JSON.stringify(opts.actualUsage) : null,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(sourceExtractions.sourceId, opts.sourceId),
        eq(sourceExtractions.projectKey, opts.projectId ?? ""),
        eq(sourceExtractions.adapterId, opts.adapterId),
        eq(sourceExtractions.adapterVersion, opts.adapterVersion),
      ),
    )
    .run();
}

function unchangedExtraction(
  sourceId: string,
  projectId: string | null,
  adapter: ExtractionAdapter,
): ExistingSourceExtractionResultDto {
  return {
    status: "unchanged",
    sourceId,
    projectId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    jobId: null,
    candidateCount: 0,
    skippedDuplicates: 0,
    invalidExcerptCandidates: 0,
    clampedOwnerDeclarations: 0,
    providerUsage: null,
    actualUsage: null,
    warnings: ["This immutable source was already extracted with the same adapter version for this target project."],
  };
}

export async function extractExistingSource(
  deps: ServiceDeps,
  opts: { sourceId: string; adapterId: string; projectIdOverride?: string | null; signal?: AbortSignal },
  ctx: ActorCtx,
): Promise<ExistingSourceExtractionResultDto> {
  throwIfExtractionAborted(opts.signal);
  const adapter = extractionAdapterOrApiError(deps, opts.adapterId, opts.sourceId, ctx);
  const { source, projectId, input } = sourceInput(deps, opts.sourceId, opts.projectIdOverride);
  const claim = claimExtractionTarget(deps, {
    sourceId: source.id,
    projectId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
  });
  if (claim === "done") return unchangedExtraction(source.id, projectId, adapter);
  if (claim === "busy") {
    throw new ApiError(
      409,
      "extraction_in_progress",
      "This source/project/adapter extraction is already in progress. Retry after the active extraction finishes.",
    );
  }
  if (claim === "retry_exhausted") {
    throw new ApiError(
      409,
      "extraction_retry_exhausted",
      `Provider extraction failed ${MAX_EXTRACTION_PROVIDER_ATTEMPTS} times for this source/project/adapter target. Review the last error before trying a new adapter version.`,
      { maxAttempts: MAX_EXTRACTION_PROVIDER_ATTEMPTS },
    );
  }

  const jobId = newId();
  const now = nowIso();
  try {
    // Job creation and extraction linkage are one immediate SQLite claim. A
    // restart can therefore never leave a newly-created chunked job without an
    // unambiguous last_job_id, nor link a job after another request reclaimed
    // the failed extraction row.
    const createAndLink = deps.sqlite.transaction(() => {
      deps.sqlite.prepare(`
        INSERT INTO import_jobs(
          id,source_id,stage,adapter_id,adapter_version,provider_model,
          attempts,error_code,usage_json,created_at,updated_at
        ) VALUES(?,?, 'chunked',?,?,NULL,1,NULL,NULL,?,?)
      `).run(jobId, source.id, adapter.id, adapter.version, now, now);
      const linked = deps.sqlite.prepare(`
        UPDATE source_extractions
        SET project_id=?,last_job_id=?,updated_at=?
        WHERE source_id=? AND project_key=? AND adapter_id=? AND adapter_version=?
          AND stage='pending' AND last_job_id IS NULL
      `).run(
        projectId,
        jobId,
        now,
        source.id,
        projectId ?? "",
        adapter.id,
        adapter.version,
      );
      if (linked.changes !== 1) {
        throw new ApiError(409, "extraction_claim_lost", "Extraction claim was lost before job linkage.");
      }
    });
    createAndLink.immediate();
  } catch (error) {
    updateExtractionState(deps.db, {
      sourceId: source.id,
      projectId,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      stage: "failed",
      jobId: null,
      errorCode: "job_create_failed",
    });
    throw error;
  }

  let providerUsage: AdapterUsage | null = null;
  try {
    providerUsage = await preflight(deps, adapter, input);
    throwIfExtractionAborted(opts.signal);
    // Only a successful preflight is an actual provider-attempt budget event.
    // Configuration and estimate failures remain retryable without consuming
    // the bounded provider-attempt allowance.
    recordProviderAttempt(deps, {
      sourceId: source.id,
      projectId,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
    });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "estimate_failed";
    deps.db.transaction((tx) => {
      tx.update(importJobs).set({ stage: "failed", errorCode: code, updatedAt: nowIso() }).where(eq(importJobs.id, jobId)).run();
      updateExtractionState(tx, {
        sourceId: source.id,
        projectId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        stage: "failed",
        jobId,
        errorCode: code,
      });
    });
    throw error;
  }

  let rawCandidates: AdapterCandidate[];
  let actualUsage: AdapterUsage | null;
  try {
    const cancellableExtract = adapter.extract as (
      input: AdapterExtractInput,
      signal?: AbortSignal,
    ) => ReturnType<ExtractionAdapter["extract"]>;
    const result = await cancellableExtract(input, opts.signal);
    throwIfExtractionAborted(opts.signal);
    if (!result || !Array.isArray(result.candidates)) {
      throw new ApiError(409, "provider_malformed_output", "Provider returned no candidate array.");
    }
    rawCandidates = result.candidates;
    actualUsage = result.usage;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "extract_failed";
    deps.db.transaction((tx) => {
      tx.update(importJobs).set({ stage: "failed", errorCode: code, updatedAt: nowIso() }).where(eq(importJobs.id, jobId)).run();
      updateExtractionState(tx, {
        sourceId: source.id,
        projectId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        stage: "failed",
        jobId,
        errorCode: code,
        preflightUsage: providerUsage,
      });
      writeAudit(tx, {
        actor: ctx.actor,
        action: "source.extraction_failed",
        targetType: "source",
        targetId: source.id,
        detail: { adapterId: adapter.id, errorCode: code, jobId },
        requestId: ctx.requestId ?? null,
      });
    });
    throw error;
  }

  if (providerUsage && actualUsage && actualUsage.estCostUsd > providerUsage.estCostUsd) {
    writeAudit(deps.db, {
      actor: ctx.actor,
      action: "provider_call.cost_accounting_anomaly",
      targetType: "adapter",
      targetId: adapter.id,
      detail: {
        sourceId: source.id,
        jobId,
        preflightUpperBoundUsd: providerUsage.estCostUsd,
        actualCostUsd: actualUsage.estCostUsd,
      },
      requestId: ctx.requestId ?? null,
    });
  }

  const excerptIds = new Set(input.excerpts.map((excerpt) => excerpt.id));
  let clampedOwnerDeclarations = 0;
  let invalidExcerptCandidates = 0;
  let skippedDuplicates = 0;
  let invalidProviderCandidates = 0;
  const warnings: string[] = [];
  const candidates: AdapterCandidate[] = [];
  for (const rawCandidate of rawCandidates) {
    if (!isPersistableCandidate(rawCandidate)) {
      invalidProviderCandidates += 1;
      continue;
    }
    const candidate = rawCandidate;
    if (candidate.evidenceBasis === "owner_declaration") {
      clampedOwnerDeclarations += 1;
      candidates.push({ ...candidate, evidenceBasis: "agent_report" as const });
      continue;
    }
    candidates.push(candidate);
  }

  const existing = deps.db
    .select({ projectId: records.projectId, hash: records.recordDedupHash })
    .from(records)
    .where(and(
      inArray(records.reviewStatus, ["proposed", "accepted"]),
      projectId === null ? isNull(records.projectId) : eq(records.projectId, projectId),
    ))
    .all();
  const existingKeys = new Set(existing.map((row) => `${row.projectId ?? ""}:${row.hash}`));
  const createdRecordIds: string[] = [];
  let createdWorkingMemory = false;

  try {
    deps.db.transaction((tx) => {
      for (const candidate of candidates) {
        if (!excerptIds.has(candidate.excerptId)) {
          invalidExcerptCandidates += 1;
          continue;
        }
        const hash = recordDedupHash({
          projectId,
          type: candidate.type,
          subject: candidate.subject,
          text: candidate.text,
        });
        const key = `${projectId ?? ""}:${hash}`;
        if (existingKeys.has(key)) {
          skippedDuplicates += 1;
          continue;
        }
        existingKeys.add(key);
        const recordId = newId();
        const stamp = nowIso();
        tx.insert(records).values({
          id: recordId,
          projectId,
          type: candidate.type,
          subject: candidate.subject,
          predicate: candidate.predicate ?? null,
          valueJson: candidate.valueJson === undefined || candidate.valueJson === null ? null : JSON.stringify(candidate.valueJson),
          text: candidate.text,
          reviewStatus: "proposed",
          evidenceBasis: candidate.evidenceBasis,
          taskStatus: candidate.taskStatus ?? null,
          recordDedupHash: hash,
          recordedAt: stamp,
          sourceEventAt: candidate.sourceEventAt ?? source.eventAt,
          effectiveFrom: null,
          effectiveTo: null,
          reviewedAt: null,
          reviewDueAt: null,
          volatile: candidate.volatile === true ? 1 : 0,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        }).run();
        tx.insert(recordEvidence).values({
          recordId,
          excerptId: candidate.excerptId,
          relation: candidate.relation ?? "supports",
          observedAt: candidate.sourceEventAt ?? source.eventAt,
          environment: null,
          artifactRef: null,
        }).run();
        createdRecordIds.push(recordId);
        if (candidate.evidenceBasis === "agent_report" && projectId) createdWorkingMemory = true;
      }
      if (createdWorkingMemory && projectId) {
        bumpProjectWorkingMemoryVersion(tx, [projectId]);
      }
      tx.update(importJobs).set({
        stage: "done",
        providerModel: providerUsage?.model ?? actualUsage?.model ?? null,
        errorCode: null,
        usageJson: JSON.stringify({
          candidates: rawCandidates.length,
          created: createdRecordIds.length,
          skippedDuplicates,
          invalidExcerptCandidates,
          invalidProviderCandidates,
          preflightUsage: providerUsage,
          actualUsage,
          ceilingUsd: deps.costCeilingUsd,
        }),
        updatedAt: nowIso(),
      }).where(eq(importJobs.id, jobId)).run();
      updateExtractionState(tx, {
        sourceId: source.id,
        projectId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        stage: "done",
        jobId,
        preflightUsage: providerUsage,
        actualUsage,
      });
      writeAudit(tx, {
        actor: ctx.actor,
        action: "source.extracted_existing",
        targetType: "source",
        targetId: source.id,
        detail: {
          projectId,
          adapterId: adapter.id,
          adapterVersion: adapter.version,
          jobId,
          candidateCount: createdRecordIds.length,
          skippedDuplicates,
          invalidExcerptCandidates,
          invalidProviderCandidates,
          clampedOwnerDeclarations,
        },
        requestId: ctx.requestId ?? null,
      });
    });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "extraction_persistence_failed";
    // A SQL/output failure must terminalize the claim so the next request can
    // recover it; never leave a pending extraction stranded behind a rolled
    // back persistence transaction.
    deps.db.transaction((tx) => {
      tx.update(importJobs)
        .set({ stage: "failed", errorCode: code, updatedAt: nowIso() })
        .where(eq(importJobs.id, jobId))
        .run();
      updateExtractionState(tx, {
        sourceId: source.id,
        projectId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        stage: "failed",
        jobId,
        errorCode: code,
        preflightUsage: providerUsage,
        actualUsage,
      });
      writeAudit(tx, {
        actor: ctx.actor,
        action: "source.extraction_failed",
        targetType: "source",
        targetId: source.id,
        detail: { adapterId: adapter.id, errorCode: code, jobId, phase: "persistence" },
        requestId: ctx.requestId ?? null,
      });
    });
    throw error;
  }

  if (clampedOwnerDeclarations > 0) warnings.push(`${clampedOwnerDeclarations} owner_declaration candidate(s) were downgraded to agent_report.`);
  if (invalidExcerptCandidates > 0) warnings.push(`${invalidExcerptCandidates} candidate(s) with unknown excerpt ids were skipped.`);
  if (invalidProviderCandidates > 0) warnings.push(`${invalidProviderCandidates} malformed provider candidate(s) were skipped.`);
  if (skippedDuplicates > 0) warnings.push(`${skippedDuplicates} exact-duplicate proposed/accepted record(s) were skipped.`);

  return {
    status: "created",
    sourceId: source.id,
    projectId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    jobId,
    candidateCount: createdRecordIds.length,
    skippedDuplicates,
    invalidExcerptCandidates,
    clampedOwnerDeclarations,
    providerUsage,
    actualUsage,
    warnings,
  };
}
