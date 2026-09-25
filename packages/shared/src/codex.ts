import { z } from "zod";
import { ImportPreviewDto } from "./dto.js";

export const CodexArchiveState = z.enum(["current", "archived"]);
export type CodexArchiveState = z.infer<typeof CodexArchiveState>;

export const CodexSessionDto = z.object({
  sessionId: z.string(),
  archiveState: CodexArchiveState,
  relativePath: z.string(),
  cwd: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string(),
  byteSize: z.number().int().nonnegative(),
  workspaceBindingId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  importedSnapshotCount: z.number().int().nonnegative(),
});
export type CodexSessionDto = z.infer<typeof CodexSessionDto>;

export const CodexSessionCatalogDto = z.object({
  currentCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  unreadableCount: z.number().int().nonnegative(),
  sessions: z.array(CodexSessionDto),
});
export type CodexSessionCatalogDto = z.infer<typeof CodexSessionCatalogDto>;

export const CodexSummaryDto = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  updatedAt: z.string(),
  byteSize: z.number().int().nonnegative(),
  cwd: z.string().nullable(),
  workspaceBindingId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  importedSnapshotCount: z.number().int().nonnegative(),
});
export type CodexSummaryDto = z.infer<typeof CodexSummaryDto>;

export const CodexSummaryCatalogDto = z.object({
  totalCount: z.number().int().nonnegative(),
  unreadableCount: z.number().int().nonnegative(),
  summaries: z.array(CodexSummaryDto),
});
export type CodexSummaryCatalogDto = z.infer<typeof CodexSummaryCatalogDto>;

export const CodexSessionImportInput = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/),
  archiveState: CodexArchiveState,
  adapterId: z.string().min(1).max(64).default("manual"),
  confirmNearDuplicateOf: z.string().nullable().default(null),
});
export type CodexSessionImportInput = z.infer<typeof CodexSessionImportInput>;

export const CodexSummaryImportInput = z.object({
  fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,255}\.md$/),
  adapterId: z.string().min(1).max(64).default("manual"),
  confirmNearDuplicateOf: z.string().nullable().default(null),
});
export type CodexSummaryImportInput = z.infer<typeof CodexSummaryImportInput>;

export const CodexImportResultDto = z.object({
  status: z.enum(["created", "duplicate_linked", "unchanged", "near_duplicate_pending"]),
  externalId: z.string(),
  externalPart: z.string(),
  sourceId: z.string().nullable(),
  archiveState: z.enum(["current", "archived", "unknown"]),
  workspaceBindingId: z.string().nullable(),
  projectId: z.string().nullable(),
  safeItemCount: z.number().int().nonnegative(),
  safeCharCount: z.number().int().nonnegative(),
  redactionCount: z.number().int().nonnegative(),
  importResult: ImportPreviewDto.nullable(),
});
export type CodexImportResultDto = z.infer<typeof CodexImportResultDto>;
