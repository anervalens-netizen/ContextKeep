import { connectorList, maxIso, idle, resolveLimits } from "./sync-policy.js";
import { and, eq } from "drizzle-orm";
import {
  SyncRunInput,
  type AdapterUsage,
  type SyncConnector,
  type SyncArtifactPlanDto,
  type SyncExecutionCountsDto,
  type SyncJobDto,
  type SyncPlanDto,
  type SyncRunResultDto,
  type SyncStatusDto,
} from "@contextkeep/shared";
import type { AppConfig } from "../config.js";
import { sourceOrigins } from "../db/workspace-schema.js";
import { connectorSyncState } from "../db/sync-schema.js";
import { AdapterDisabledError } from "../adapters/registry.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { catalogCodexSessions, catalogCodexSummaries, importCodexSession, importCodexSummary } from "./codex.js";
import { catalogDshMemory, catalogDshSessions, importDshMemory, importDshSession } from "./dsh.js";
import { estimateExistingSource, estimateTextExtraction, extractExistingSource, hasCompletedExtraction } from "./extraction.js";
import type { ActorCtx, ServiceDeps } from "./import.js";
import {
  previewCodexSession,
  previewCodexSummary,
  previewDshMemory,
  previewDshSession,
  type AgentArtifactPreview,
} from "./sync-preview.js";
import { writeAudit } from "./audit.js";

// Metadata catalogs are cheap/read-only; sync must see the complete store so
// older unprocessed artifacts cannot disappear behind a newest-N catalog cap.
const CATALOG_LIMIT = Number.MAX_SAFE_INTEGER;
// Diagnostic skip/defer rows may be capped, but every executable action is
// always appended to the returned plan. maxArtifacts itself is capped at 500.
const MAX_DIAGNOSTIC_PLAN_ITEMS = 300;

interface MetaArtifact {
  key: string;
  connector: "codex" | "dsh";
  kind: "session" | "summary" | "memory";
  externalId: string;
  updatedAt: string;
  archiveState: "current" | "archived" | "unknown" | null;
  workspaceBindingId: string | null;
  projectId: string | null;
  eligibleReason: string;
  codexSession?: { sessionId: string; archiveState: "current" | "archived"; relativePath: string };
  codexSummary?: { fileName: string };
  dshSession?: { sessionId: string; relativePath: string };
  dshMemory?: { relativePath: string };
}

interface WorkCandidate {
  meta: MetaArtifact;
  freshSourceId: string | null;
  priorSourceId: string | null;
  preview?: AgentArtifactPreview;
  /** Owner may explicitly archive unassigned material, but it must never be AI-extracted automatically. */
  forceArchiveOnly: boolean;
}

interface RuntimePlanItem {
  meta: MetaArtifact;
  preview: AgentArtifactPreview;
  action: SyncArtifactPlanDto["action"];
  importedSourceId: string | null;
  priorSourceId: string | null;
}

function discoverMetadata(
  deps: ServiceDeps,
  config: AppConfig,
  connector: SyncConnector,
  idleMinutes: number,
  nowMs: number,
): { discovered: number; eligible: MetaArtifact[] } {
  const all: MetaArtifact[] = [];
  let discovered = 0;
  if (connector === "codex" || connector === "both") {
    const sessions = catalogCodexSessions(deps.db, config.codexHome, { state: "all", limit: CATALOG_LIMIT });
    discovered += sessions.currentCount + sessions.archivedCount;
    for (const session of sessions.sessions) {
      if (session.archiveState !== "archived" && !idle(session.updatedAt, nowMs, idleMinutes)) continue;
      all.push({
        key: `codex:session:${session.sessionId}:${session.archiveState}`,
        connector: "codex",
        kind: "session",
        externalId: session.sessionId,
        updatedAt: session.updatedAt,
        archiveState: session.archiveState,
        workspaceBindingId: session.workspaceBindingId,
        projectId: session.projectId,
        eligibleReason: session.archiveState === "archived" ? "archived" : `idle>=${idleMinutes}m`,
        codexSession: { sessionId: session.sessionId, archiveState: session.archiveState, relativePath: session.relativePath },
      });
    }
    const summaries = catalogCodexSummaries(deps.db, config.codexHome, CATALOG_LIMIT);
    discovered += summaries.totalCount;
    for (const summary of summaries.summaries) {
      all.push({
        key: `codex:summary:${summary.fileName}`,
        connector: "codex",
        kind: "summary",
        externalId: `rollout-summary:${summary.fileName}`,
        updatedAt: summary.updatedAt,
        archiveState: "unknown",
        workspaceBindingId: summary.workspaceBindingId,
        projectId: summary.projectId,
        eligibleReason: "summary revision",
        codexSummary: { fileName: summary.fileName },
      });
    }
  }
  if (connector === "dsh" || connector === "both") {
    const sessions = catalogDshSessions(deps.db, config.dshHome, CATALOG_LIMIT);
    discovered += sessions.totalCount;
    for (const session of sessions.sessions) {
      if (!idle(session.updatedAt, nowMs, idleMinutes)) continue;
      all.push({
        key: `dsh:session:${session.sessionId}`,
        connector: "dsh",
        kind: "session",
        externalId: session.sessionId,
        updatedAt: session.updatedAt,
        archiveState: "unknown",
        workspaceBindingId: session.workspaceBindingId,
        projectId: session.projectId,
        eligibleReason: `idle>=${idleMinutes}m`,
        dshSession: { sessionId: session.sessionId, relativePath: session.relativePath },
      });
    }
    const memory = catalogDshMemory(deps.db, config.dshHome, CATALOG_LIMIT);
    discovered += memory.totalCount;
    for (const item of memory.files) {
      all.push({
        key: `dsh:memory:${item.relativePath}`,
        connector: "dsh",
        kind: "memory",
        externalId: `memory:${item.relativePath}`,
        updatedAt: item.updatedAt,
        archiveState: "unknown",
        workspaceBindingId: null,
        projectId: null,
        eligibleReason: "memory revision",
        dshMemory: { relativePath: item.relativePath },
      });
    }
  }
  all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { discovered, eligible: all };
}

function freshOrigin(deps: ServiceDeps, meta: MetaArtifact) {
  const rows = deps.db.select().from(sourceOrigins).where(and(
    eq(sourceOrigins.connector, meta.connector),
    eq(sourceOrigins.externalId, meta.externalId),
    eq(sourceOrigins.externalUpdatedAt, meta.updatedAt),
  )).all();
  return rows.find((row) => meta.archiveState === null || row.archiveState === meta.archiveState) ?? null;
}

function latestOriginSourceId(deps: ServiceDeps, meta: MetaArtifact): string | null {
  const rows = deps.db.select().from(sourceOrigins).where(and(
    eq(sourceOrigins.connector, meta.connector),
    eq(sourceOrigins.externalId, meta.externalId),
  )).all();
  if (!rows.length) return null;
  rows.sort((a, b) => (b.externalUpdatedAt ?? b.createdAt).localeCompare(a.externalUpdatedAt ?? a.createdAt));
  return rows[0]!.sourceId;
}

function exactOrigin(deps: ServiceDeps, preview: AgentArtifactPreview) {
  return deps.db.select().from(sourceOrigins).where(and(
    eq(sourceOrigins.connector, preview.connector),
    eq(sourceOrigins.externalId, preview.externalId),
    eq(sourceOrigins.externalPart, preview.externalPart),
  )).get() ?? null;
}

function previewArtifact(config: AppConfig, meta: MetaArtifact): AgentArtifactPreview {
  if (meta.codexSession) return previewCodexSession(config.codexHome, meta.codexSession);
  if (meta.codexSummary) return previewCodexSummary(config.codexHome, meta.codexSummary.fileName);
  if (meta.dshSession) return previewDshSession(config.dshHome, meta.dshSession);
  if (meta.dshMemory) return previewDshMemory(config.dshHome, meta.dshMemory.relativePath);
  throw new ApiError(500, "sync_artifact_shape", "Sync artifact has no connector-specific identity.");
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: "sync_failed", message: error instanceof Error ? error.message : "Sync operation failed." };
}

function failedProviderUsage(error: unknown): AdapterUsage | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") return null;
  const usage = (error.details as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const cost = (usage as { estCostUsd?: unknown }).estCostUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return usage as AdapterUsage;
}

function planItem(
  meta: MetaArtifact,
  opts: {
    preview?: AgentArtifactPreview;
    sourceId?: string | null;
    alreadyExtracted?: boolean;
    estimatedCostUsd?: number | null;
    action: SyncArtifactPlanDto["action"];
    note?: string | null;
  },
): SyncArtifactPlanDto {
  return {
    key: meta.key,
    connector: meta.connector,
    kind: meta.kind,
    externalId: opts.preview?.externalId ?? meta.externalId,
    archiveState: opts.preview?.archiveState ?? meta.archiveState,
    updatedAt: opts.preview?.externalUpdatedAt ?? meta.updatedAt,
    workspaceBindingId: meta.workspaceBindingId,
    projectId: meta.projectId,
    eligibleReason: meta.eligibleReason,
    safeItemCount: opts.preview?.safeItemCount ?? 0,
    safeCharCount: opts.preview?.safeCharCount ?? 0,
    importedSourceId: opts.sourceId ?? null,
    alreadyExtracted: opts.alreadyExtracted ?? false,
    estimatedCostUsd: opts.estimatedCostUsd ?? null,
    action: opts.action,
    note: opts.note ?? null,
  };
}

function appendDiagnostic(items: SyncArtifactPlanDto[], item: SyncArtifactPlanDto): void {
  if (items.length < MAX_DIAGNOSTIC_PLAN_ITEMS) items.push(item);
}

function appendExecutable(items: SyncArtifactPlanDto[], item: SyncArtifactPlanDto): void {
  // Executable work must never be hidden from the plan returned to the owner.
  items.push(item);
}

async function buildPlanInternal(
  deps: ServiceDeps,
  config: AppConfig,
  input: SyncRunInput,
  nowMs = Date.now(),
): Promise<{ plan: SyncPlanDto; runtimeItems: RuntimePlanItem[] }> {
  const limits = resolveLimits(config, input);
  let adapterVersion: string | null = null;
  if (input.mode === "archiveAndExtract") {
    try {
      adapterVersion = deps.registry.get(limits.extractionAdapterId).version;
    } catch (error) {
      if (error instanceof AdapterDisabledError) throw new ApiError(409, "adapter_disabled", error.message);
      throw error;
    }
  }

  const discovered = discoverMetadata(deps, config, input.connector, limits.idleMinutes, nowMs);
  const eligible = input.projectId
    ? discovered.eligible.filter((meta) => meta.projectId === input.projectId)
    : discovered.eligible;
  const scopedDiscovered = input.projectId ? eligible.length : discovered.discovered;
  const items: SyncArtifactPlanDto[] = [];
  const runtimeItems: RuntimePlanItem[] = [];
  const candidates: WorkCandidate[] = [];
  let unlinked = 0;
  let unchanged = 0;

  for (const meta of eligible) {
    if (meta.projectId === null && !input.allowUnassignedArchive) {
      unlinked += 1;
      appendDiagnostic(items, planItem(meta, {
        action: "skip_unlinked",
        note: "No canonical project link; automatic sync skips this artifact unless unassigned archive is explicitly allowed.",
      }));
      continue;
    }
    const timestampOrigin = freshOrigin(deps, meta);
    let fresh = timestampOrigin;
    let verifiedPreview: AgentArtifactPreview | undefined;
    if (fresh) {
      // Metadata equality is only a cheap candidate check. A copied/restored
      // connector artifact can preserve mtime while its visible content
      // changes, so verify the immutable snapshot identity before declaring
      // it unchanged.
      try {
        verifiedPreview = previewArtifact(config, meta);
        fresh = exactOrigin(deps, verifiedPreview);
      } catch {
        // Let the normal candidate preview path surface the controlled error.
        fresh = null;
      }
    }
    const forceArchiveOnly = meta.projectId === null;
    if (fresh && (input.mode === "archiveOnly" || forceArchiveOnly)) {
      unchanged += 1;
      appendDiagnostic(items, planItem(meta, {
        sourceId: fresh.sourceId,
        action: "skip_unchanged",
        note: forceArchiveOnly
          ? "Unassigned archive is current; AI extraction is intentionally disabled until a canonical project is linked."
          : "External revision timestamp/archive state already matches archived provenance.",
      }));
      continue;
    }
    if (
      fresh &&
      input.mode === "archiveAndExtract" &&
      adapterVersion &&
      hasCompletedExtraction(deps, fresh.sourceId, meta.projectId, limits.extractionAdapterId, adapterVersion)
    ) {
      unchanged += 1;
      appendDiagnostic(items, planItem(meta, {
        sourceId: fresh.sourceId,
        alreadyExtracted: true,
        estimatedCostUsd: 0,
        action: "skip_unchanged",
        note: "External revision is archived and already extracted with this adapter version for this project.",
      }));
      continue;
    }
    candidates.push({
      meta,
      freshSourceId: fresh?.sourceId ?? null,
      priorSourceId: fresh?.sourceId ?? timestampOrigin?.sourceId ?? latestOriginSourceId(deps, meta),
      forceArchiveOnly,
      ...(verifiedPreview ? { preview: verifiedPreview } : {}),
    });
  }

  let deferredByArtifactLimit = 0;
  let plannedArchive = 0;
  let plannedExtract = 0;
  let deferredByCharBudget = 0;
  let deferredByCostBudget = 0;
  let estimateErrors = 0;
  let totalSafeChars = 0;
  let totalEstimatedCostUsd = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    if (runtimeItems.length >= limits.maxArtifacts) {
      deferredByArtifactLimit = candidates.length - index;
      break;
    }
    const candidate = candidates[index]!;
    const meta = candidate.meta;
    let preview: AgentArtifactPreview;
    try {
      preview = candidate.preview ?? previewArtifact(config, meta);
    } catch (error) {
      estimateErrors += 1;
      const detail = safeError(error);
      appendDiagnostic(items, planItem(meta, {
        action: "defer_estimate_error",
        note: `${detail.code}: ${detail.message}`,
      }));
      continue;
    }

    if (totalSafeChars + preview.safeCharCount > limits.maxChars) {
      deferredByCharBudget += 1;
      appendDiagnostic(items, planItem(meta, {
        preview,
        sourceId: candidate.freshSourceId,
        action: "defer_char_budget",
        note: "Per-run safe-text character budget exhausted for this artifact; scanning continues for smaller work.",
      }));
      continue;
    }

    const origin = exactOrigin(deps, preview);
    const sourceId = origin?.sourceId ?? candidate.freshSourceId;
    const needsArchiveRefresh = candidate.freshSourceId === null;

    if (input.mode === "archiveOnly" || candidate.forceArchiveOnly) {
      totalSafeChars += preview.safeCharCount;
      plannedArchive += 1;
      const item = planItem(meta, {
        preview,
        sourceId,
        action: "archive",
        note: candidate.forceArchiveOnly
          ? "Explicit unassigned archive only; extraction remains disabled until a canonical project is linked."
          : sourceId
            ? "Sanitized content is unchanged but external freshness/archive state moved; connector import will refresh provenance only."
            : null,
      });
      appendExecutable(items, item);
      runtimeItems.push({ meta, preview, action: "archive", importedSourceId: sourceId, priorSourceId: candidate.priorSourceId });
      continue;
    }

    if (
      sourceId &&
      adapterVersion &&
      hasCompletedExtraction(deps, sourceId, meta.projectId, limits.extractionAdapterId, adapterVersion)
    ) {
      if (!needsArchiveRefresh) {
        unchanged += 1;
        appendDiagnostic(items, planItem(meta, {
          preview,
          sourceId,
          alreadyExtracted: true,
          estimatedCostUsd: 0,
          action: "skip_unchanged",
          note: "Snapshot is already extracted.",
        }));
        continue;
      }
      totalSafeChars += preview.safeCharCount;
      plannedArchive += 1;
      const item = planItem(meta, {
        preview,
        sourceId,
        alreadyExtracted: true,
        estimatedCostUsd: 0,
        action: "archive",
        note: "Extraction is already complete; connector import will refresh external freshness only.",
      });
      appendExecutable(items, item);
      runtimeItems.push({ meta, preview, action: "archive", importedSourceId: sourceId, priorSourceId: candidate.priorSourceId });
      continue;
    }

    let estimatedCost = 0;
    try {
      const estimate = sourceId
        ? await estimateExistingSource(deps, sourceId, limits.extractionAdapterId, meta.projectId)
        : await estimateTextExtraction(deps, {
            text: preview.text,
            projectId: meta.projectId,
            authorLabel: preview.authorLabel,
            eventAt: preview.eventAt,
            adapterId: limits.extractionAdapterId,
          });
      estimatedCost = estimate.usage?.estCostUsd ?? 0;
    } catch (error) {
      estimateErrors += 1;
      const detail = safeError(error);
      if (needsArchiveRefresh) {
        totalSafeChars += preview.safeCharCount;
        plannedArchive += 1;
        const item = planItem(meta, {
          preview,
          sourceId,
          action: "archive",
          note: `Archive/refresh is safe; extraction deferred because estimate failed (${detail.code}).`,
        });
        appendExecutable(items, item);
        runtimeItems.push({ meta, preview, action: "archive", importedSourceId: sourceId, priorSourceId: candidate.priorSourceId });
      } else {
        appendDiagnostic(items, planItem(meta, {
          preview,
          sourceId,
          action: "defer_estimate_error",
          note: `${detail.code}: ${detail.message}`,
        }));
      }
      continue;
    }

    if (totalEstimatedCostUsd + estimatedCost > limits.maxCostUsd) {
      deferredByCostBudget += 1;
      if (needsArchiveRefresh) {
        totalSafeChars += preview.safeCharCount;
        plannedArchive += 1;
        const item = planItem(meta, {
          preview,
          sourceId,
          estimatedCostUsd: estimatedCost,
          action: "archive",
          note: "Source can be archived/refreshed now; extraction is deferred by aggregate cost budget.",
        });
        appendExecutable(items, item);
        runtimeItems.push({ meta, preview, action: "archive", importedSourceId: sourceId, priorSourceId: candidate.priorSourceId });
      } else {
        appendDiagnostic(items, planItem(meta, {
          preview,
          sourceId,
          estimatedCostUsd: estimatedCost,
          action: "defer_cost_budget",
          note: "Aggregate extraction-cost budget exhausted for this artifact; source remains queued for a later run.",
        }));
      }
      continue;
    }

    totalSafeChars += preview.safeCharCount;
    totalEstimatedCostUsd += estimatedCost;
    plannedExtract += 1;
    const action: SyncArtifactPlanDto["action"] = needsArchiveRefresh ? "archive_extract" : "extract_existing";
    if (needsArchiveRefresh) plannedArchive += 1;
    const item = planItem(meta, { preview, sourceId, estimatedCostUsd: estimatedCost, action });
    appendExecutable(items, item);
    runtimeItems.push({ meta, preview, action, importedSourceId: sourceId, priorSourceId: candidate.priorSourceId });
  }

  return {
    plan: {
      projectId: input.projectId ?? null,
      connector: input.connector,
      mode: input.mode,
      extractionAdapterId: limits.extractionAdapterId,
      idleMinutes: limits.idleMinutes,
      maxArtifacts: limits.maxArtifacts,
      maxChars: limits.maxChars,
      maxCostUsd: limits.maxCostUsd,
      discovered: scopedDiscovered,
      eligible: eligible.length,
      unlinked,
      unchanged,
      selected: runtimeItems.length,
      plannedArchive,
      plannedExtract,
      deferredByArtifactLimit,
      deferredByCharBudget,
      deferredByCostBudget,
      estimateErrors,
      totalSafeChars,
      totalEstimatedCostUsd,
      items,
    },
    runtimeItems,
  };
}

async function importManualArtifact(
  deps: ServiceDeps,
  config: AppConfig,
  item: RuntimePlanItem,
  ctx: ActorCtx,
): Promise<{ status: string; sourceId: string | null; externalPart: string }> {
  const guard = {
    expectedExternalPart: item.preview.externalPart,
    expectedProjectId: item.meta.projectId,
    expectedWorkspaceBindingId: item.meta.workspaceBindingId,
  };
  let result;
  if (item.meta.codexSession) {
    result = await importCodexSession(deps, config.codexHome, {
      sessionId: item.meta.codexSession.sessionId,
      archiveState: item.meta.codexSession.archiveState,
      adapterId: "manual",
      confirmNearDuplicateOf: item.priorSourceId,
    }, ctx, guard);
  } else if (item.meta.codexSummary) {
    result = await importCodexSummary(deps, config.codexHome, {
      fileName: item.meta.codexSummary.fileName,
      adapterId: "manual",
      confirmNearDuplicateOf: item.priorSourceId,
    }, ctx, guard);
  } else if (item.meta.dshSession) {
    result = await importDshSession(deps, config.dshHome, {
      sessionId: item.meta.dshSession.sessionId,
      adapterId: "manual",
      confirmNearDuplicateOf: item.priorSourceId,
    }, ctx, guard);
  } else if (item.meta.dshMemory) {
    result = await importDshMemory(deps, config.dshHome, {
      relativePath: item.meta.dshMemory.relativePath,
      adapterId: "manual",
      confirmNearDuplicateOf: item.priorSourceId,
    }, ctx, guard);
  } else {
    throw new ApiError(500, "sync_artifact_shape", "Sync artifact has no import implementation.");
  }
  if (result.externalPart !== item.preview.externalPart) {
    throw new ApiError(409, "sync_preview_drift", "Connector snapshot changed between planning and import; retry sync.");
  }
  if (result.status === "near_duplicate_pending") {
    throw new ApiError(409, "near_duplicate_pending", "Near-duplicate source requires explicit owner confirmation; sync will not auto-confirm unrelated lineage.");
  }
  return { status: result.status, sourceId: result.sourceId, externalPart: result.externalPart };
}

function initialCounts(plan: SyncPlanDto): SyncExecutionCountsDto {
  return {
    archivedCreated: 0,
    archivedUnchanged: 0,
    extractedCreated: 0,
    extractionUnchanged: 0,
    skippedUnlinked: plan.unlinked,
    skippedUnchanged: plan.unchanged,
    deferredBudget: plan.deferredByArtifactLimit + plan.deferredByCharBudget + plan.deferredByCostBudget + plan.estimateErrors,
    failed: 0,
  };
}

export interface SyncRunObserver {
  runId?: string;
  onPlan?: (plan: SyncPlanDto) => void;
  onProgress?: (progress: { completed: number; failed: number; currentKey: string | null; counts: SyncExecutionCountsDto }) => void;
  shouldCancel?: () => boolean;
  signal?: AbortSignal;
}

function throwIfSyncStopped(observer: SyncRunObserver): void {
  if (observer.signal?.aborted) {
    if (observer.signal.reason instanceof Error) throw observer.signal.reason;
    throw new ApiError(409, "sync_interrupted", "Sync run was interrupted before completion.");
  }
  if (observer.shouldCancel?.()) {
    throw new ApiError(409, "sync_cancelled", "Sync run was cancelled.");
  }
}

export async function runSyncOnce(
  deps: ServiceDeps,
  config: AppConfig,
  input: SyncRunInput,
  ctx: ActorCtx,
  observer: SyncRunObserver = {},
): Promise<SyncRunResultDto> {
  const startedAt = nowIso();
  const runId = observer.runId ?? newId();
  const { plan, runtimeItems } = await buildPlanInternal(deps, config, input);
  observer.onPlan?.(plan);
  const counts = initialCounts(plan);
  let completed = 0;
  let accountedProviderCostUsd = 0;
  let providerBudgetExhausted = false;
  let budgetAuditWritten = false;
  const errors: { key: string; code: string; message: string }[] = [];
  const accountProviderCost = (cost: number, sourceId: string | null): void => {
    if (!Number.isFinite(cost) || cost < 0) return;
    accountedProviderCostUsd += cost;
    if (plan.maxCostUsd > 0 && accountedProviderCostUsd >= plan.maxCostUsd) {
      providerBudgetExhausted = true;
    }
    if (accountedProviderCostUsd > plan.maxCostUsd && !budgetAuditWritten) {
      budgetAuditWritten = true;
      writeAudit(deps.db, {
        actor: ctx.actor,
        action: "connector.sync_provider_budget_exceeded",
        targetType: "sync_run",
        targetId: runId,
        detail: {
          maxCostUsd: plan.maxCostUsd,
          accountedProviderCostUsd,
          sourceId,
          adapterId: plan.extractionAdapterId,
        },
        requestId: ctx.requestId ?? null,
      });
    }
  };
  if (!input.dryRun) {
    for (const item of runtimeItems) {
      throwIfSyncStopped(observer);
      let sourceId = item.importedSourceId;
      const wantsExtraction = item.action === "archive_extract" || item.action === "extract_existing";
      try {
        if (item.action === "archive" || item.action === "archive_extract") {
          const imported = await importManualArtifact(deps, config, item, ctx);
          throwIfSyncStopped(observer);
          sourceId = imported.sourceId;
          if (imported.status === "unchanged") counts.archivedUnchanged += 1;
          else counts.archivedCreated += 1;
        }
        if (wantsExtraction && providerBudgetExhausted) {
          // Archive work remains useful and has no provider spend. Once actual
          // or reserved spend consumes the run budget, degrade the remaining
          // archive+extract items to archive-only and defer extract-existing
          // items to a later owner run.
          counts.deferredBudget += 1;
        } else if (wantsExtraction && sourceId) {
          const extraction = await extractExistingSource(deps, {
            sourceId,
            adapterId: plan.extractionAdapterId,
            projectIdOverride: item.meta.projectId,
            signal: observer.signal,
          }, ctx);
          if (extraction.status === "unchanged") counts.extractionUnchanged += 1;
          else counts.extractedCreated += 1;

          const reservedCost = extraction.providerUsage?.estCostUsd ?? 0;
          const actualCost = extraction.actualUsage?.estCostUsd ?? 0;
          accountProviderCost(Math.max(reservedCost, actualCost), sourceId);
        } else if (wantsExtraction && !sourceId) {
          throw new ApiError(500, "sync_source_missing", "Sync import produced no source id for planned extraction.");
        }
      } catch (error) {
        // Shutdown/cancel is a run-level terminal condition, never an
        // artifact-level failure to count and continue past.
        throwIfSyncStopped(observer);
        const usage = failedProviderUsage(error);
        if (wantsExtraction && usage) {
          // A paid provider may return billable usage with a failed/truncated
          // response. Count that spend before deciding whether later work may
          // call the provider again; otherwise a failed call can overspend the
          // aggregate run ceiling.
          accountProviderCost(usage.estCostUsd, sourceId);
        }
        const detail = safeError(error);
        counts.failed += 1;
        errors.push({ key: item.meta.key, ...detail });
      } finally {
        completed += 1;
        observer.onProgress?.({ completed, failed: counts.failed, currentKey: item.meta.key, counts: { ...counts } });
      }
    }
    throwIfSyncStopped(observer);
  }
  return {
    runId,
    dryRun: input.dryRun,
    startedAt,
    finishedAt: nowIso(),
    plan,
    counts,
    accountedProviderCostUsd,
    providerBudgetExhausted,
    errors,
  };
}

function parsePersistedResult(value: string | null): SyncRunResultDto | null {
  if (!value) return null;
  try { return JSON.parse(value) as SyncRunResultDto; } catch { return null; }
}

type SyncJobRow = {
  id: string; project_id: string | null; connector: "codex" | "dsh" | "both"; mode: "archiveOnly" | "archiveAndExtract";
  input_json: string;
  stage: "running" | "completed" | "completed_with_errors" | "failed" | "interrupted" | "cancelled";
  selected: number; completed: number; failed: number; current_key: string | null; last_error: string | null;
  started_at: string; updated_at: string; finished_at: string | null;
};

function toSyncJobDto(row: SyncJobRow | undefined): SyncJobDto | null {
  if (!row) return null;
  return { id: row.id, projectId: row.project_id, connector: row.connector, mode: row.mode, stage: row.stage,
    selected: row.selected, completed: row.completed, failed: row.failed, currentKey: row.current_key,
    lastError: row.last_error, startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at };
}

function syncJobById(deps: ServiceDeps, jobId: string): SyncJobRow | undefined {
  return deps.sqlite.prepare("SELECT * FROM sync_jobs WHERE id=?").get(jobId) as SyncJobRow | undefined;
}

function persistedSyncInput(row: SyncJobRow): SyncRunInput {
  let raw: unknown;
  try { raw = JSON.parse(row.input_json); }
  catch { throw new ApiError(500, "sync_job_input_invalid", "Persisted sync job input is invalid."); }
  const parsed = SyncRunInput.safeParse(raw);
  if (!parsed.success) throw new ApiError(500, "sync_job_input_invalid", "Persisted sync job input is invalid.");
  return { ...parsed.data, dryRun: false };
}

function recoverInterruptedSyncJobs(deps: ServiceDeps): void {
  const now = nowIso();
  deps.sqlite.prepare(`UPDATE sync_jobs SET stage='interrupted',last_error=COALESCE(last_error,'ContextKeep restarted while sync was running.'),finished_at=?,updated_at=? WHERE stage='running'`).run(now, now);
}

function currentSyncJob(deps: ServiceDeps): SyncJobDto | null {
  return toSyncJobDto(deps.sqlite.prepare("SELECT * FROM sync_jobs WHERE stage='running' ORDER BY started_at DESC,id DESC LIMIT 1").get() as SyncJobRow | undefined);
}

function lastTerminalSyncJob(deps: ServiceDeps): SyncJobDto | null {
  return toSyncJobDto(deps.sqlite.prepare("SELECT * FROM sync_jobs WHERE stage<>'running' ORDER BY COALESCE(finished_at,updated_at) DESC,id DESC LIMIT 1").get() as SyncJobRow | undefined);
}

export class SyncCoordinator {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeJobId: string | null = null;
  private activeRun: Promise<SyncRunResultDto> | null = null;
  private activeAbortController: AbortController | null = null;
  private drainPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly cancelledJobIds = new Set<string>();
  private lastScanAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: SyncRunResultDto | null = null;

  constructor(private readonly deps: ServiceDeps, private readonly config: AppConfig) {
    recoverInterruptedSyncJobs(deps);
    const rows = deps.db.select().from(connectorSyncState).all();
    this.lastScanAt = maxIso(rows.map((row) => row.lastScanAt));
    this.lastSuccessAt = maxIso(rows.map((row) => row.lastSuccessAt));
    const newest = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    this.lastError = newest?.lastError ?? null;
    this.lastResult = parsePersistedResult(newest?.lastResultJson ?? null);
  }

  start(): void {
    if (this.shuttingDown || this.config.syncIntervalMinutes <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      void this.run({
        connector: "both",
        dryRun: false,
        mode: "archiveOnly",
        allowUnassignedArchive: this.config.syncAllowUnassignedArchive,
      }, { actor: "system:sync", requestId: null }).catch(() => undefined);
    }, this.config.syncIntervalMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Enter shutdown once: stop scheduling and cooperatively abort active work. */
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stop();
    if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
      this.activeAbortController.abort(
        new ApiError(409, "sync_interrupted", "Sync run interrupted by application shutdown."),
      );
    }
  }

  /**
   * Stop new sync work and wait until the active continuation can no longer
   * write. The deadline is an escalation marker, not permission to close
   * SQLite while a provider that ignored AbortSignal is still pending.
   */
  stopAndDrain(opts: { deadlineMs?: number } = {}): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.beginShutdown();
    const active = this.activeRun;
    if (!active) return Promise.resolve();

    const deadlineMs = Math.max(1, opts.deadlineMs ?? 15_000);
    const drain = async (): Promise<void> => {
      let timer: NodeJS.Timeout | null = null;
      const deadline = new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => {
          const jobId = this.activeJobId;
          if (jobId) {
            const stamp = nowIso();
            const message = "Sync shutdown drain exceeded " + deadlineMs + "ms; waiting for active continuation before database close.";
            try {
              this.deps.sqlite.prepare(
                "UPDATE sync_jobs SET stage='interrupted',current_key=NULL,last_error=?,finished_at=?,updated_at=? WHERE id=? AND stage='running'",
              ).run(message, stamp, stamp, jobId);
            } catch {
              // The deadline remains the deterministic shutdown signal even if
              // persistence is unavailable; never escape from the timer.
              this.lastError = message + " Could not persist the deadline marker.";
            }
          }
          resolve("deadline");
        }, deadlineMs);
        timer.unref?.();
      });

      const settled: Promise<true> = active.then(() => true as const, () => true as const);
      const outcome = await Promise.race<true | "deadline">([
        settled,
        deadline,
      ]);
      if (outcome === true && timer) clearTimeout(timer);
      if (outcome === "deadline") {
        // The job is durably recoverable now, but database ownership remains
        // with this process until the continuation has actually stopped.
        await settled;
      }
    };

    const current = drain();
    const tracked = current.then(
      () => {
        if (this.drainPromise === tracked) this.drainPromise = null;
      },
      (error) => {
        if (this.drainPromise === tracked) this.drainPromise = null;
        throw error;
      },
    );
    this.drainPromise = tracked;
    return tracked;
  }

  status(): SyncStatusDto {
    return {
      running: this.running,
      intervalEnabled: this.config.syncIntervalMinutes > 0,
      intervalMinutes: this.config.syncIntervalMinutes,
      scheduledMode: "archiveOnly",
      lastScanAt: this.lastScanAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
      currentJob: currentSyncJob(this.deps),
      lastJob: lastTerminalSyncJob(this.deps),
    };
  }

  cancel(jobId: string, ctx: ActorCtx): SyncJobDto {
    const existing = syncJobById(this.deps, jobId);
    if (!existing) throw new ApiError(404, "sync_job_not_found", "Sync job was not found.");
    if (existing.stage !== "running") throw new ApiError(409, "sync_job_not_running", "Only a running sync job can be cancelled.");
    const now = nowIso();
    const changed = this.deps.sqlite.prepare(
      "UPDATE sync_jobs SET stage='cancelled',last_error='Cancelled by owner.',finished_at=?,updated_at=? WHERE id=? AND stage='running'",
    ).run(now, now, jobId);
    if (changed.changes !== 1) throw new ApiError(409, "sync_job_not_running", "Sync job is no longer running.");
    if (this.activeJobId === jobId) {
      this.cancelledJobIds.add(jobId);
      if (this.activeAbortController && !this.activeAbortController.signal.aborted) {
        this.activeAbortController.abort(new ApiError(409, "sync_cancelled", "Sync run was cancelled."));
      }
    }
    writeAudit(this.deps.db, {
      actor: ctx.actor, action: "connector.sync_cancelled", targetType: "sync_job", targetId: jobId,
      detail: {}, requestId: ctx.requestId ?? null,
    });
    return toSyncJobDto(syncJobById(this.deps, jobId))!;
  }

  async rerun(jobId: string, action: "retry" | "resume", ctx: ActorCtx): Promise<SyncRunResultDto> {
    const existing = syncJobById(this.deps, jobId);
    if (!existing) throw new ApiError(404, "sync_job_not_found", "Sync job was not found.");
    if (!["failed", "completed_with_errors", "interrupted", "cancelled"].includes(existing.stage)) {
      throw new ApiError(409, "sync_job_not_recoverable", "Only failed, interrupted, cancelled, or partially failed sync jobs can be recovered.");
    }
    const result = await this.run(persistedSyncInput(existing), ctx);
    writeAudit(this.deps.db, {
      actor: ctx.actor, action: action === "retry" ? "connector.sync_retried" : "connector.sync_resumed",
      targetType: "sync_job", targetId: jobId, detail: { newRunId: result.runId }, requestId: ctx.requestId ?? null,
    });
    return result;
  }

  run(input: SyncRunInput, ctx: ActorCtx): Promise<SyncRunResultDto> {
    if (this.shuttingDown) {
      return Promise.reject(
        new ApiError(409, "sync_shutting_down", "ContextKeep is shutting down; new sync runs are disabled."),
      );
    }
    if (this.running || this.activeRun) {
      return Promise.reject(new ApiError(409, "sync_in_progress", "A ContextKeep sync run is already in progress."));
    }

    const controller = new AbortController();
    this.activeAbortController = controller;
    const task = this.executeRun(input, ctx, controller.signal);
    this.activeRun = task;
    const clearActive = (): void => {
      if (this.activeRun === task) this.activeRun = null;
      if (this.activeAbortController === controller) this.activeAbortController = null;
    };
    void task.then(clearActive, clearActive);
    return task;
  }

  private async executeRun(
    input: SyncRunInput,
    ctx: ActorCtx,
    signal: AbortSignal,
  ): Promise<SyncRunResultDto> {
    const runId = newId();
    this.running = true;
    try {
      if (!input.dryRun) {
        const started = nowIso();
        this.deps.sqlite.prepare(`INSERT INTO sync_jobs(id,project_id,connector,mode,input_json,stage,selected,completed,failed,current_key,result_json,last_error,started_at,updated_at,finished_at) VALUES(?,?,?,?,?,'running',0,0,0,NULL,NULL,NULL,?,?,NULL)`)
          .run(runId, input.projectId ?? null, input.connector, input.mode, JSON.stringify(input), started, started);
        this.activeJobId = runId;
      }
      const result = await runSyncOnce(this.deps, this.config, input, ctx, input.dryRun ? { signal } : {
        runId,
        onPlan: (plan) => {
          this.deps.sqlite.prepare("UPDATE sync_jobs SET selected=?,updated_at=? WHERE id=?").run(plan.selected, nowIso(), runId);
        },
        onProgress: (progress) => {
          this.deps.sqlite.prepare("UPDATE sync_jobs SET completed=?,failed=?,current_key=?,updated_at=? WHERE id=? AND stage='running'")
            .run(progress.completed, progress.failed, progress.currentKey, nowIso(), runId);
        },
        shouldCancel: () => this.cancelledJobIds.has(runId),
        signal,
      });
      if (signal.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        throw new ApiError(409, "sync_interrupted", "Sync run was interrupted before completion.");
      }
      if (!input.dryRun && this.cancelledJobIds.has(runId)) throw new ApiError(409, "sync_cancelled", "Sync run was cancelled.");
      this.lastScanAt = result.finishedAt;
      this.lastResult = result;
      this.lastError = result.errors.length ? `${result.errors.length} artifact(s) failed.` : null;
      if (!input.dryRun) {
        const stage = result.errors.length ? "completed_with_errors" : "completed";
        const terminal = this.deps.sqlite.prepare("UPDATE sync_jobs SET stage=?,completed=?,failed=?,current_key=NULL,result_json=?,last_error=?,finished_at=?,updated_at=? WHERE id=? AND stage='running'")
          .run(stage, result.plan.selected, result.counts.failed, JSON.stringify(result), this.lastError, result.finishedAt, result.finishedAt, runId);
        if (terminal.changes !== 1) {
          const current = syncJobById(this.deps, runId);
          if (current?.stage === "cancelled") throw new ApiError(409, "sync_cancelled", "Sync run was cancelled.");
          throw new ApiError(409, "sync_job_state_changed", "Sync job state changed before completion.");
        }
        if (!result.errors.length) this.lastSuccessAt = result.finishedAt;
        this.persist(input.connector, result);
        writeAudit(this.deps.db, {
          actor: ctx.actor,
          action: "connector.sync_completed",
          targetType: "connector",
          targetId: input.connector,
          detail: {
            runId: result.runId,
            projectId: input.projectId ?? null,
            mode: input.mode,
            counts: result.counts,
            discovered: result.plan.discovered,
            eligible: result.plan.eligible,
            selected: result.plan.selected,
            estimatedCostUsd: result.plan.totalEstimatedCostUsd,
          },
          requestId: ctx.requestId ?? null,
        });
      }
      return result;
    } catch (error) {
      this.lastScanAt = nowIso();
      let current: SyncJobRow | undefined;
      if (!input.dryRun) {
        try {
          current = syncJobById(this.deps, runId);
        } catch {
          current = undefined;
        }
      }
      const cancelled =
        !input.dryRun &&
        (this.cancelledJobIds.has(runId) || current?.stage === "cancelled");
      const interrupted =
        !input.dryRun &&
        !cancelled &&
        (this.shuttingDown ||
          current?.stage === "interrupted" ||
          (signal.aborted &&
            signal.reason instanceof ApiError &&
            signal.reason.code === "sync_interrupted"));
      this.lastError = cancelled
        ? "Sync run cancelled."
        : interrupted
          ? error instanceof Error
            ? error.message
            : "Sync run interrupted by shutdown."
          : error instanceof Error
            ? error.message
            : "Sync run failed.";

      if (!input.dryRun && interrupted) {
        const finished = nowIso();
        try {
          this.deps.sqlite.prepare(
            "UPDATE sync_jobs SET stage='interrupted',current_key=NULL,last_error=?,finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=? AND stage='running'",
          ).run(this.lastError, finished, finished, runId);
        } catch {
          // Preserve the provider/original error; the database may be closing.
        }
      } else if (!input.dryRun && !cancelled) {
        const finished = nowIso();
        try {
          this.deps.sqlite.prepare("UPDATE sync_jobs SET stage='failed',current_key=NULL,last_error=?,finished_at=?,updated_at=? WHERE id=? AND stage='running'")
            .run(this.lastError, finished, finished, runId);
          this.persistError(input.connector, this.lastError);
        } catch {
          // Failure reporting is secondary and must never replace the cause.
        }
      }
      throw error;
    } finally {
      this.running = false;
      if (this.activeJobId === runId) this.activeJobId = null;
      this.cancelledJobIds.delete(runId);
    }
  }

  private persist(connector: SyncConnector, result: SyncRunResultDto): void {
    const stamp = nowIso();
    for (const name of connectorList(connector)) {
      this.deps.sqlite.prepare(`
        INSERT INTO connector_sync_state(connector,last_scan_at,last_success_at,last_error,last_result_json,updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(connector) DO UPDATE SET
          last_scan_at=excluded.last_scan_at,
          last_success_at=excluded.last_success_at,
          last_error=excluded.last_error,
          last_result_json=excluded.last_result_json,
          updated_at=excluded.updated_at
      `).run(
        name,
        result.finishedAt,
        this.lastSuccessAt,
        result.errors.length ? `${result.errors.length} artifact(s) failed.` : null,
        JSON.stringify(result),
        stamp,
      );
    }
  }

  private persistError(connector: SyncConnector, message: string): void {
    const stamp = nowIso();
    for (const name of connectorList(connector)) {
      this.deps.sqlite.prepare(`
        INSERT INTO connector_sync_state(connector,last_scan_at,last_success_at,last_error,last_result_json,updated_at)
        VALUES(?,?,NULL,?,NULL,?)
        ON CONFLICT(connector) DO UPDATE SET last_scan_at=excluded.last_scan_at,last_error=excluded.last_error,updated_at=excluded.updated_at
      `).run(name, stamp, message, stamp);
    }
  }
}
