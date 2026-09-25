import { z } from "zod";
import { LifecycleState } from "./enums.js";

/**
 * A discovered server workspace is observational metadata, not canonical
 * project truth. `projectId` is null until the owner explicitly links or
 * tracks it; observed activity never changes project lifecycle.
 */
export const WorkspaceDto = z.object({
  id: z.string(),
  canonicalKey: z.string(),
  canonicalPath: z.string(),
  displayName: z.string(),
  gitRemote: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitHeadSha: z.string().nullable(),
  lastGitActivity: z.string().nullable(),
  lastObservedActivity: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  projectLifecycle: LifecycleState.nullable(),
  ignored: z.boolean(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDto>;

export const WorkspaceScanResultDto = z.object({
  configuredRootCount: z.number().int().nonnegative(),
  discoveredCount: z.number().int().nonnegative(),
  insertedCount: z.number().int().nonnegative(),
  updatedCount: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceDto),
});
export type WorkspaceScanResultDto = z.infer<typeof WorkspaceScanResultDto>;

const WorkspaceActionVersion = {
  expectedUpdatedAt: z.string().min(1),
} as const;

/** Owner-only mutations for binding observational workspaces to canonical projects. */
export const WorkspaceActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), projectId: z.string().min(1), ...WorkspaceActionVersion }),
  z.object({ action: z.literal("unlink"), ...WorkspaceActionVersion }),
  z.object({ action: z.literal("ignore"), ...WorkspaceActionVersion }),
  z.object({ action: z.literal("unignore"), ...WorkspaceActionVersion }),
  z.object({ action: z.literal("track"), name: z.string().trim().min(1).max(200).optional(), ...WorkspaceActionVersion }),
]);
export type WorkspaceActionInput = z.infer<typeof WorkspaceActionInput>;

// ---------------------------------------------------------------------------
// M3.5 reconciliation — observational hints only, never automatic writes.
// ---------------------------------------------------------------------------

export const WorkspaceReconciliationStatus = z.enum(["tracked", "linked", "ignored", "unresolved"]);
export type WorkspaceReconciliationStatus = z.infer<typeof WorkspaceReconciliationStatus>;

export const WorkspaceSuggestionDto = z.object({
  action: z.enum(["track", "link", "ignore", "review"]).nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  reason: z.string().nullable(),
});
export type WorkspaceSuggestionDto = z.infer<typeof WorkspaceSuggestionDto>;

export const WorkspaceHistorySignalDto = z.object({
  codexCurrentCount: z.number().int().nonnegative(),
  codexArchivedCount: z.number().int().nonnegative(),
  codexSummaryCount: z.number().int().nonnegative(),
  dshSessionCount: z.number().int().nonnegative(),
  /** Latest mapped Codex/DSH session only; summaries must never masquerade as a work session. */
  lastSessionActivity: z.string().nullable().optional(),
  /** Latest mapped agent artifact of any kind, including Codex rollout summaries. */
  lastAgentActivity: z.string().nullable(),
});
export type WorkspaceHistorySignalDto = z.infer<typeof WorkspaceHistorySignalDto>;

export const WorkspaceReconciliationItemDto = z.object({
  workspace: WorkspaceDto,
  status: WorkspaceReconciliationStatus,
  history: WorkspaceHistorySignalDto,
  suggestion: WorkspaceSuggestionDto,
});
export type WorkspaceReconciliationItemDto = z.infer<typeof WorkspaceReconciliationItemDto>;

export const WorkspaceReconciliationDto = z.object({
  generatedAt: z.string(),
  total: z.number().int().nonnegative(),
  tracked: z.number().int().nonnegative(),
  linked: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  codexCatalogAvailable: z.boolean(),
  dshCatalogAvailable: z.boolean(),
  seededProjectIds: z.array(z.string()),
  items: z.array(WorkspaceReconciliationItemDto),
});
export type WorkspaceReconciliationDto = z.infer<typeof WorkspaceReconciliationDto>;
