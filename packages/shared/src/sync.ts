import { z } from "zod";

export const AdapterUsageDto = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  estCostUsd: z.number().nonnegative(),
  model: z.string().nullable(),
});
export type AdapterUsageDto = z.infer<typeof AdapterUsageDto>;

export const ExistingSourceExtractInput = z.object({
  adapterId: z.string().min(1).max(64).default("deepseek"),
});
export type ExistingSourceExtractInput = z.infer<typeof ExistingSourceExtractInput>;

export const ExistingSourceExtractionResultDto = z.object({
  status: z.enum(["created", "unchanged"]),
  sourceId: z.string(),
  projectId: z.string().nullable(),
  adapterId: z.string(),
  adapterVersion: z.string(),
  jobId: z.string().nullable(),
  candidateCount: z.number().int().nonnegative(),
  skippedDuplicates: z.number().int().nonnegative(),
  invalidExcerptCandidates: z.number().int().nonnegative(),
  clampedOwnerDeclarations: z.number().int().nonnegative(),
  providerUsage: AdapterUsageDto.nullable(),
  actualUsage: AdapterUsageDto.nullable(),
  warnings: z.array(z.string()),
});
export type ExistingSourceExtractionResultDto = z.infer<typeof ExistingSourceExtractionResultDto>;

export const SyncConnector = z.enum(["codex", "dsh", "both"]);
export type SyncConnector = z.infer<typeof SyncConnector>;

export const SyncMode = z.enum(["archiveOnly", "archiveAndExtract"]);
export type SyncMode = z.infer<typeof SyncMode>;

export const SyncRunInput = z.object({
  projectId: z.string().uuid().optional(),
  connector: SyncConnector.default("both"),
  dryRun: z.boolean().default(true),
  mode: SyncMode.default("archiveOnly"),
  extractionAdapterId: z.string().min(1).max(64).optional(),
  idleMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  maxArtifacts: z.number().int().min(1).max(500).optional(),
  maxChars: z.number().int().min(1).max(50_000_000).optional(),
  maxCostUsd: z.number().min(0).max(1000).optional(),
  allowUnassignedArchive: z.boolean().default(false),
});
export type SyncRunInput = z.infer<typeof SyncRunInput>;

export const SyncArtifactAction = z.enum([
  "skip_unlinked",
  "skip_unchanged",
  "archive",
  "archive_extract",
  "extract_existing",
  "defer_char_budget",
  "defer_cost_budget",
  "defer_estimate_error",
]);
export type SyncArtifactAction = z.infer<typeof SyncArtifactAction>;

export const SyncArtifactPlanDto = z.object({
  key: z.string(),
  connector: z.enum(["codex", "dsh"]),
  kind: z.enum(["session", "summary", "memory"]),
  externalId: z.string(),
  archiveState: z.enum(["current", "archived", "unknown"]).nullable(),
  updatedAt: z.string(),
  workspaceBindingId: z.string().nullable(),
  projectId: z.string().nullable(),
  eligibleReason: z.string(),
  safeItemCount: z.number().int().nonnegative(),
  safeCharCount: z.number().int().nonnegative(),
  importedSourceId: z.string().nullable(),
  alreadyExtracted: z.boolean(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  action: SyncArtifactAction,
  note: z.string().nullable(),
});
export type SyncArtifactPlanDto = z.infer<typeof SyncArtifactPlanDto>;

export const SyncPlanDto = z.object({
  // Exact project scope resolved for this plan (M-history-backfill). `null`
  // means the run was NOT project-scoped (a global/timer run), which is the
  // safe default when reading a persisted result written before this field
  // existed.
  projectId: z.string().uuid().nullable().default(null),
  connector: SyncConnector,
  mode: SyncMode,
  extractionAdapterId: z.string(),
  idleMinutes: z.number().int().positive(),
  maxArtifacts: z.number().int().positive(),
  maxChars: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  discovered: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  unlinked: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  plannedArchive: z.number().int().nonnegative(),
  plannedExtract: z.number().int().nonnegative(),
  deferredByArtifactLimit: z.number().int().nonnegative(),
  deferredByCharBudget: z.number().int().nonnegative(),
  deferredByCostBudget: z.number().int().nonnegative(),
  estimateErrors: z.number().int().nonnegative(),
  totalSafeChars: z.number().int().nonnegative(),
  totalEstimatedCostUsd: z.number().nonnegative(),
  items: z.array(SyncArtifactPlanDto),
});
export type SyncPlanDto = z.infer<typeof SyncPlanDto>;

export const SyncExecutionCountsDto = z.object({
  archivedCreated: z.number().int().nonnegative(),
  archivedUnchanged: z.number().int().nonnegative(),
  extractedCreated: z.number().int().nonnegative(),
  extractionUnchanged: z.number().int().nonnegative(),
  skippedUnlinked: z.number().int().nonnegative(),
  skippedUnchanged: z.number().int().nonnegative(),
  deferredBudget: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SyncExecutionCountsDto = z.infer<typeof SyncExecutionCountsDto>;

export const SyncRunResultDto = z.object({
  runId: z.string(),
  dryRun: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string(),
  plan: SyncPlanDto,
  counts: SyncExecutionCountsDto,
  accountedProviderCostUsd: z.number().nonnegative().default(0),
  providerBudgetExhausted: z.boolean().default(false),
  errors: z.array(z.object({ key: z.string(), code: z.string(), message: z.string() })),
});
export type SyncRunResultDto = z.infer<typeof SyncRunResultDto>;

export const SyncJobStage = z.enum(["running", "completed", "completed_with_errors", "failed", "interrupted", "cancelled"]);
export type SyncJobStage = z.infer<typeof SyncJobStage>;

export const SyncJobAction = z.enum(["retry", "resume", "cancel"]);
export type SyncJobAction = z.infer<typeof SyncJobAction>;

export const SyncJobActionInput = z.object({ action: SyncJobAction });
export type SyncJobActionInput = z.infer<typeof SyncJobActionInput>;

export const SyncJobDto = z.object({
  id: z.string(),
  projectId: z.string().uuid().nullable(),
  connector: SyncConnector,
  mode: SyncMode,
  stage: SyncJobStage,
  selected: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  currentKey: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SyncJobDto = z.infer<typeof SyncJobDto>;

export const SyncStatusDto = z.object({
  running: z.boolean(),
  intervalEnabled: z.boolean(),
  intervalMinutes: z.number().int().nonnegative(),
  scheduledMode: SyncMode,
  lastScanAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastResult: SyncRunResultDto.nullable(),
  currentJob: SyncJobDto.nullable(),
  lastJob: SyncJobDto.nullable(),
});
export type SyncStatusDto = z.infer<typeof SyncStatusDto>;
