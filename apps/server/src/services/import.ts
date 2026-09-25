import { and, eq, inArray, or } from "drizzle-orm";
import type { AdapterUsage, ImportPreviewDto, ImportTextInput } from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { importJobs, projects, recordEvidence, records, sourceExcerpts, sources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { recordDedupHash, sha256 } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { isoOrNull, nowIso } from "../lib/time.js";
import { AdapterDisabledError, type AdapterRegistry } from "../adapters/registry.js";
import { writeAudit } from "./audit.js";
import { bumpProjectWorkingMemoryVersion } from "./content-version.js";
import { chunkText } from "./chunk.js";
import { normalizeText } from "./normalize.js";
import { diceSimilarity, NEAR_DUPLICATE_THRESHOLD, shingles } from "./similarity.js";
import { toSourceDto } from "./mappers.js";
import type Database from "better-sqlite3";

export interface ServiceDeps {
  db: Db;
  /** Raw handle for hot paths (brief route) where drizzle mapping is too slow (§10). */
  sqlite: Database.Database;
  registry: AdapterRegistry;
  /** Per-import provider cost ceiling, in USD (handoff §12 item 13, §16 item 5). */
  costCeilingUsd: number;
  /** A11: review interval for volatile facts, in days (handoff §12 item 15). */
  volatileReviewIntervalDays: number;
}

export interface ActorCtx {
  actor: string;
  requestId?: string | null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Manual import pipeline (handoff §8, M0 scope 3):
 * ingest → normalize → chunk (offset-preserving) → extract (adapter) →
 * link evidence → present (proposed records). Exact duplicates skipped by
 * content hash (A1); near-duplicates require explicit confirmation.
 * A20: adapter output claiming owner_declaration is clamped to agent_report.
 * A21: disabled/unknown adapter calls are refused AND audit-logged.
 */
export async function runImport(
  deps: ServiceDeps,
  input: ImportTextInput,
  ctx: ActorCtx,
): Promise<ImportPreviewDto> {
  const { db, registry } = deps;
  const raw = input.text;
  const contentHash = sha256(raw);
  const normalized = normalizeText(raw);
  if (normalized.length === 0) {
    throw new ApiError(400, "empty_after_normalization", "Text is empty after normalization.");
  }
  const normalizedHash = sha256(normalized);
  const jobId = newId();
  const now = nowIso();

  let projectRow: typeof projects.$inferSelect | null = null;
  if (input.projectId) {
    projectRow = db.select().from(projects).where(eq(projects.id, input.projectId)).get() ?? null;
    if (!projectRow) {
      throw new ApiError(404, "project_not_found", `Project ${input.projectId} not found.`);
    }
  }

  function insertJob(
    q: Db,
    stage: string,
    opts: {
      sourceId?: string | null;
      errorCode?: string | null;
      adapterId?: string;
      adapterVersion?: string;
      providerModel?: string | null;
      usageJson?: unknown;
    } = {},
  ): void {
    q.insert(importJobs)
      .values({
        id: jobId,
        sourceId: opts.sourceId ?? null,
        stage,
        adapterId: opts.adapterId ?? input.adapterId,
        adapterVersion: opts.adapterVersion ?? "n/a",
        providerModel: opts.providerModel ?? null,
        attempts: 1,
        errorCode: opts.errorCode ?? null,
        usageJson: opts.usageJson === undefined ? null : JSON.stringify(opts.usageJson),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  // A1: exact duplicate by content hash (original OR normalized).
  const exact = db
    .select()
    .from(sources)
    .where(or(eq(sources.contentHash, contentHash), eq(sources.normalizedHash, normalizedHash)))
    .get();
  if (exact) {
    insertJob(db, "duplicate_skipped", { sourceId: exact.id });
    writeAudit(db, {
      actor: ctx.actor,
      action: "source.duplicate_skipped",
      targetType: "source",
      targetId: exact.id,
      detail: { contentHash, jobId },
      requestId: ctx.requestId ?? null,
    });
    return {
      jobId,
      status: "duplicate_skipped",
      source: null,
      duplicateOf: {
        sourceId: exact.id,
        title: exact.title,
        similarity: 1,
        importedAt: exact.importedAt,
      },
      nearDuplicates: [],
      excerptCount: 0,
      candidateCount: 0,
      warnings: [`Exact duplicate of source "${exact.title ?? exact.id}" (content hash match, A1). Nothing imported.`],
      providerUsage: null,
      actualUsage: null,
      costCeilingUsd: deps.costCeilingUsd,
    };
  }

  // A1: near-duplicates surface for explicit confirmation, never silent merge.
  const candidateShingles = shingles(normalized);
  const nearDuplicates = db
    .select({
      id: sources.id,
      title: sources.title,
      normalizedText: sources.normalizedText,
      importedAt: sources.importedAt,
    })
    .from(sources)
    .all()
    .map((s) => ({ s, score: diceSimilarity(candidateShingles, shingles(s.normalizedText)) }))
    .filter((x) => x.score >= NEAR_DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => ({
      sourceId: x.s.id,
      title: x.s.title,
      similarity: round3(x.score),
      importedAt: x.s.importedAt,
    }));

  const confirmedNearDuplicate = Boolean(
    input.confirmNearDuplicateOf && nearDuplicates.some((candidate) => candidate.sourceId === input.confirmNearDuplicateOf),
  );
  if (nearDuplicates.length > 0 && !confirmedNearDuplicate) {
    insertJob(db, "near_duplicate_pending");
    return {
      jobId,
      status: "near_duplicate_pending",
      source: null,
      duplicateOf: null,
      nearDuplicates,
      excerptCount: 0,
      candidateCount: 0,
      warnings: [
        input.confirmNearDuplicateOf
          ? "The supplied near-duplicate confirmation does not match the detected candidates. Review the current candidates and confirm one explicitly (A1)."
          : "Near-duplicate source(s) detected. Review them and re-submit with confirmNearDuplicateOf to import anyway (A1).",
      ],
      providerUsage: null,
      actualUsage: null,
      costCeilingUsd: deps.costCeilingUsd,
    };
  }

  if (confirmedNearDuplicate && input.confirmNearDuplicateOf) {
    writeAudit(db, {
      actor: ctx.actor,
      action: "source.near_duplicate_confirmed",
      targetType: "source",
      targetId: input.confirmNearDuplicateOf,
      detail: { jobId, nearDuplicates },
      requestId: ctx.requestId ?? null,
    });
  }

  // Adapter resolution BEFORE any writes (A14/A21): refused calls are audited.
  let adapter;
  try {
    adapter = registry.get(input.adapterId);
  } catch (e) {
    if (e instanceof AdapterDisabledError) {
      insertJob(db, "failed", { errorCode: `adapter_disabled:${e.adapterId}` });
      writeAudit(db, {
        actor: ctx.actor,
        action: "provider_call.refused_disabled",
        targetType: "adapter",
        targetId: e.adapterId,
        detail: { reason: e.message, jobId },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(409, "adapter_disabled", e.message, { jobId });
    }
    throw e;
  }

  const chunks = chunkText(normalized);
  const excerptRows = chunks.map((c) => ({
    id: newId(),
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    text: c.text,
  }));
  const excerptIdSet = new Set(excerptRows.map((e) => e.id));

  const adapterInput = {
    sourceId: "pending",
    projectId: input.projectId,
    authorLabel: input.authorLabel ?? null,
    eventAt: isoOrNull(input.eventAt),
    excerpts: excerptRows.map((e) => ({
      id: e.id,
      text: e.text,
      startOffset: e.startOffset,
      endOffset: e.endOffset,
    })),
  };
  let providerUsage: AdapterUsage | null = null;
  const isFreeAdapter = adapter.costCategory === "free";
  const hasEstimateUsage = typeof adapter.estimateUsage === "function";

  if (!isFreeAdapter && !hasEstimateUsage) {
    insertJob(db, "failed", {
      errorCode: "estimate_required",
      adapterVersion: adapter.version,
      usageJson: { reason: "paid_adapter_without_estimate_usage" },
    });
    writeAudit(db, {
      actor: ctx.actor,
      action: "provider_call.estimate_required",
      targetType: "adapter",
      targetId: adapter.id,
      detail: { reason: "Paid adapter without estimateUsage; cannot verify cost ceiling.", jobId },
      requestId: ctx.requestId ?? null,
    });
    throw new ApiError(
      409,
      "estimate_required",
      `Paid adapter "${adapter.id}" does not implement estimateUsage; cannot verify cost ceiling.`,
      { jobId },
    );
  }

  if (hasEstimateUsage) {
    const estimateFn = adapter.estimateUsage!;
    let est: AdapterUsage | null;
    try {
      est = await estimateFn(adapterInput);
    } catch (e) {
      if (e instanceof ApiError) {
        insertJob(db, "failed", {
          errorCode: e.code,
          adapterVersion: adapter.version,
          usageJson: { reason: e.message },
        });
        writeAudit(db, {
          actor: ctx.actor,
          action: "provider_call.estimate_required",
          targetType: "adapter",
          targetId: adapter.id,
          detail: {
            reason: `Provider-specific preflight failure: ${e.code}`,
            providerErrorCode: e.code,
            jobId,
          },
          requestId: ctx.requestId ?? null,
        });
      }
      throw e;
    }

    if (!isFreeAdapter && est === null) {
      insertJob(db, "failed", {
        errorCode: "estimate_required",
        adapterVersion: adapter.version,
        usageJson: { reason: "paid_adapter_returned_null_estimate" },
      });
      writeAudit(db, {
        actor: ctx.actor,
        action: "provider_call.estimate_required",
        targetType: "adapter",
        targetId: adapter.id,
        detail: { reason: "Paid adapter returned null from estimateUsage; cannot verify cost ceiling.", jobId },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(
        409,
        "estimate_required",
        `Paid adapter "${adapter.id}" returned null from estimateUsage; cannot verify cost ceiling.`,
        { jobId },
      );
    }

    if (est !== null && (!Number.isFinite(est.estCostUsd) || est.estCostUsd < 0)) {
      insertJob(db, "failed", {
        errorCode: "estimate_invalid",
        adapterVersion: adapter.version,
        providerModel: est.model,
        usageJson: { usage: est, ceilingUsd: deps.costCeilingUsd },
      });
      writeAudit(db, {
        actor: ctx.actor,
        action: "provider_call.estimate_invalid",
        targetType: "adapter",
        targetId: adapter.id,
        detail: {
          reason: "estimateUsage returned a non-finite or negative estCostUsd.",
          estCostUsd: est.estCostUsd,
          ceilingUsd: deps.costCeilingUsd,
          jobId,
        },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(
        409,
        "estimate_invalid",
        `Adapter "${adapter.id}" returned an invalid cost estimate (estCostUsd=${est.estCostUsd}); refusing before extract.`,
        { jobId, estCostUsd: est.estCostUsd, ceilingUsd: deps.costCeilingUsd },
      );
    }

    if (est !== null && est.estCostUsd > deps.costCeilingUsd) {
      insertJob(db, "failed", {
        errorCode: "cost_ceiling_exceeded",
        adapterVersion: adapter.version,
        providerModel: est.model,
        usageJson: { usage: est, ceilingUsd: deps.costCeilingUsd },
      });
      writeAudit(db, {
        actor: ctx.actor,
        action: "provider_call.cost_ceiling_exceeded",
        targetType: "adapter",
        targetId: adapter.id,
        detail: { usage: est, ceilingUsd: deps.costCeilingUsd, jobId },
        requestId: ctx.requestId ?? null,
      });
      throw new ApiError(
        409,
        "cost_ceiling_exceeded",
        `Provider cost estimate $${est.estCostUsd.toFixed(4)} exceeds the cost ceiling ($${deps.costCeilingUsd.toFixed(2)} USD) for adapter "${adapter.id}". Adjust CK_COST_CEILING_USD or shorten the input.`,
        { jobId, estCostUsd: est.estCostUsd, ceilingUsd: deps.costCeilingUsd },
      );
    }

    providerUsage = est;
  }

  const { candidates: rawCandidates, usage: actualUsageFromAdapter } =
    await adapter.extract({
      sourceId: "pending",
      projectId: input.projectId,
      authorLabel: input.authorLabel ?? null,
      eventAt: isoOrNull(input.eventAt),
      excerpts: excerptRows.map((e) => ({
        id: e.id,
        text: e.text,
        startOffset: e.startOffset,
        endOffset: e.endOffset,
      })),
    });

  if (providerUsage && actualUsageFromAdapter) {
    const preflightUpperBound = providerUsage.estCostUsd;
    if (actualUsageFromAdapter.estCostUsd > preflightUpperBound) {
      writeAudit(db, {
        actor: ctx.actor,
        action: "provider_call.cost_accounting_anomaly",
        targetType: "adapter",
        targetId: adapter.id,
        detail: {
          reason:
            "actual billable cost exceeded the pre-flight upper-bound estimate; " +
            "this is a provider-cost-accounting defect that must be investigated",
          preflightUpperBoundUsd: preflightUpperBound,
          actualCostUsd: actualUsageFromAdapter.estCostUsd,
          preflightInputTokens: providerUsage.inputTokens,
          preflightOutputTokens: providerUsage.outputTokens,
          actualInputTokens: actualUsageFromAdapter.inputTokens,
          actualOutputTokens: actualUsageFromAdapter.outputTokens,
          providerModel: actualUsageFromAdapter.model ?? providerUsage.model ?? null,
          jobId,
        },
        requestId: ctx.requestId ?? null,
      });
    }
  }

  const warnings: string[] = [];
  let clamped = 0;
  const candidates = rawCandidates.map((c) => {
    if (c.evidenceBasis === "owner_declaration") {
      clamped++;
      return { ...c, evidenceBasis: "agent_report" as const };
    }
    return c;
  });
  if (clamped > 0) {
    warnings.push(
      `A20: adapter emitted ${clamped} candidate(s) claiming owner_declaration evidence; downgraded to agent_report.`,
    );
  }

  const existingRows = db
    .select({
      projectId: records.projectId,
      hash: records.recordDedupHash,
      text: records.text,
      reviewStatus: records.reviewStatus,
    })
    .from(records)
    .where(inArray(records.reviewStatus, ["proposed", "accepted"]))
    .all();
  const existingKeys = new Set(existingRows.map((r) => `${r.projectId ?? ""}:${r.hash}`));
  const existingByProject = new Map<string, { text: string; shingles: Map<string, number> }[]>();
  for (const r of existingRows) {
    const key = r.projectId ?? "";
    const list = existingByProject.get(key) ?? [];
    list.push({ text: r.text, shingles: shingles(r.text.toLowerCase(), 5) });
    existingByProject.set(key, list);
  }

  const sourceId = newId();
  const createdRecordIds: string[] = [];
  let skippedDuplicates = 0;
  const nearDupRecords: string[] = [];
  let createdWorkingMemory = false;

  db.transaction((tx) => {
    if (projectRow?.lifecycle === "retired") {
      warnings.push(
        `Project "${projectRow.name}" is retired. Imported records remain proposals; accepting facts about a retired project requires an explicit owner action, and lifecycle reactivation is only possible through the corrections workflow (A3/A19).`,
      );
    }

    tx.insert(sources)
      .values({
        id: sourceId,
        kind: input.kind,
        title: input.title ?? input.originalFilename ?? firstLine(normalized),
        originalFilename: input.originalFilename,
        contentHash,
        normalizedHash,
        importedAt: now,
        eventAt: isoOrNull(input.eventAt),
        authorLabel: input.authorLabel,
        provenanceBasis: "uploader_metadata",
        projectId: input.projectId,
        originalText: raw,
        normalizedText: normalized,
        redactionState: "none",
      })
      .run();

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const e = excerptRows[i]!;
      tx.insert(sourceExcerpts)
        .values({
          id: e.id,
          sourceId,
          startOffset: e.startOffset,
          endOffset: e.endOffset,
          exactText: e.text,
          exactTextHash: sha256(e.text),
        })
        .run();
      void c;
    }

    for (const c of candidates) {
      if (!excerptIdSet.has(c.excerptId)) {
        warnings.push(`Candidate excerpt reference ${c.excerptId} not found; candidate skipped.`);
        continue;
      }
      const hash = recordDedupHash({
        projectId: input.projectId,
        type: c.type,
        subject: c.subject,
        text: c.text,
      });
      const key = `${input.projectId ?? ""}:${hash}`;
      if (existingKeys.has(key)) {
        skippedDuplicates++;
        continue;
      }
      const cSh = shingles(c.text.toLowerCase(), 5);
      for (const prev of existingByProject.get(input.projectId ?? "") ?? []) {
        if (diceSimilarity(cSh, prev.shingles) >= NEAR_DUPLICATE_THRESHOLD) {
          nearDupRecords.push(c.text);
          break;
        }
      }
      existingKeys.add(key);

      const recordId = newId();
      tx.insert(records)
        .values({
          id: recordId,
          projectId: input.projectId,
          type: c.type,
          subject: c.subject,
          predicate: c.predicate ?? null,
          valueJson: c.valueJson === undefined || c.valueJson === null ? null : JSON.stringify(c.valueJson),
          text: c.text,
          reviewStatus: "proposed",
          evidenceBasis: c.evidenceBasis,
          taskStatus: c.taskStatus ?? null,
          recordDedupHash: hash,
          recordedAt: now,
          sourceEventAt: c.sourceEventAt ?? isoOrNull(input.eventAt),
          effectiveFrom: null,
          effectiveTo: null,
          reviewedAt: null,
          reviewDueAt: null,
          volatile: c.volatile === true ? 1 : 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(recordEvidence)
        .values({
          recordId,
          excerptId: c.excerptId,
          relation: c.relation ?? "supports",
          observedAt: c.sourceEventAt ?? isoOrNull(input.eventAt),
          environment: null,
          artifactRef: null,
        })
        .run();
      createdRecordIds.push(recordId);
      if (c.evidenceBasis === "agent_report") createdWorkingMemory = true;
    }

    if (skippedDuplicates > 0) {
      warnings.push(`§8.8: ${skippedDuplicates} exact-duplicate candidate record(s) skipped (per-project content hash).`);
    }
    if (nearDupRecords.length > 0) {
      warnings.push(
        `Near-duplicate candidate record(s) proposed for explicit confirmation: ${nearDupRecords
          .slice(0, 3)
          .map((t) => `"${truncate(t, 80)}"`)
          .join(", ")}`,
      );
    }

    insertJob(tx, "done", {
      sourceId,
      adapterVersion: adapter.version,
      providerModel: providerUsage?.model ?? null,
      usageJson: {
        candidates: rawCandidates.length,
        created: createdRecordIds.length,
        skippedDuplicates,
        ...(providerUsage
          ? {
              preflightUsage: providerUsage,
              ceilingUsd: deps.costCeilingUsd,
              actualUsage: actualUsageFromAdapter,
            }
          : {
              ceilingUsd: deps.costCeilingUsd,
              actualUsage: actualUsageFromAdapter,
            }),
      },
    });

    writeAudit(tx, {
      actor: ctx.actor,
      action: "source.imported",
      targetType: "source",
      targetId: sourceId,
      before: null,
      after: { sourceId, contentHash, normalizedHash, excerptCount: chunks.length, recordIds: createdRecordIds },
      detail: { adapterId: adapter.id, jobId, confirmedNearDuplicateOf: confirmedNearDuplicate ? input.confirmNearDuplicateOf : null },
      requestId: ctx.requestId ?? null,
    });
    if (input.projectId && createdWorkingMemory) {
      bumpProjectWorkingMemoryVersion(tx, [input.projectId]);
    }
  });

  const sourceRow = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
  return {
    jobId,
    status: "created",
    source: toSourceDto(sourceRow, chunks.length),
    duplicateOf: null,
    nearDuplicates: confirmedNearDuplicate ? nearDuplicates : [],
    excerptCount: chunks.length,
    candidateCount: createdRecordIds.length,
    warnings,
    providerUsage,
    actualUsage: actualUsageFromAdapter,
    costCeilingUsd: deps.costCeilingUsd,
  };
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return truncate(line.replace(/^#+\s*/, ""), 120) || "Untitled import";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
