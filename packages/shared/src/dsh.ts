import { z } from "zod";
import { ImportPreviewDto } from "./dto.js";

export const DshSessionDto = z.object({
  sessionId: z.string(),
  relativePath: z.string(),
  workspaceFolder: z.string(),
  updatedAt: z.string(),
  byteSize: z.number().int().nonnegative(),
  workspaceBindingId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  importedSnapshotCount: z.number().int().nonnegative(),
});
export type DshSessionDto = z.infer<typeof DshSessionDto>;

export const DshSessionCatalogDto = z.object({
  totalCount: z.number().int().nonnegative(),
  unreadableCount: z.number().int().nonnegative(),
  sessions: z.array(DshSessionDto),
});
export type DshSessionCatalogDto = z.infer<typeof DshSessionCatalogDto>;

export const DshMemoryDto = z.object({
  relativePath: z.string(),
  updatedAt: z.string(),
  byteSize: z.number().int().nonnegative(),
  importedSnapshotCount: z.number().int().nonnegative(),
});
export type DshMemoryDto = z.infer<typeof DshMemoryDto>;

export const DshMemoryCatalogDto = z.object({
  totalCount: z.number().int().nonnegative(),
  unreadableCount: z.number().int().nonnegative(),
  files: z.array(DshMemoryDto),
});
export type DshMemoryCatalogDto = z.infer<typeof DshMemoryCatalogDto>;

export const DshSessionImportInput = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/),
  adapterId: z.string().min(1).max(64).default("manual"),
  confirmNearDuplicateOf: z.string().nullable().default(null),
});
export type DshSessionImportInput = z.infer<typeof DshSessionImportInput>;

export const DshMemoryImportInput = z.object({
  relativePath: z.string().min(1).max(255),
  adapterId: z.string().min(1).max(64).default("manual"),
  confirmNearDuplicateOf: z.string().nullable().default(null),
});
export type DshMemoryImportInput = z.infer<typeof DshMemoryImportInput>;

export const DshImportResultDto = z.object({
  status: z.enum(["created", "duplicate_linked", "unchanged", "near_duplicate_pending"]),
  externalId: z.string(),
  externalPart: z.string(),
  sourceId: z.string().nullable(),
  workspaceBindingId: z.string().nullable(),
  projectId: z.string().nullable(),
  safeItemCount: z.number().int().nonnegative(),
  safeCharCount: z.number().int().nonnegative(),
  redactionCount: z.number().int().nonnegative(),
  importResult: ImportPreviewDto.nullable(),
});
export type DshImportResultDto = z.infer<typeof DshImportResultDto>;
