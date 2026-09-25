import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { zstdDecompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import type {
  DshImportResultDto,
  DshMemoryCatalogDto,
  DshMemoryDto,
  DshMemoryImportInput,
  DshSessionCatalogDto,
  DshSessionDto,
  DshSessionImportInput,
  ImportTextInput,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { projects, sources } from "../db/schema.js";
import { sourceOrigins, workspaceBindings } from "../db/workspace-schema.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import type { ServiceDeps } from "./import.js";
import { runDurablyClaimedImport } from "./initial-import-claim.js";
import { writeAudit } from "./audit.js";
import { redactCredentialLikeText } from "./redaction.js";
import { normalizeGitRemote } from "./workspaces.js";

const MAX_CONNECTOR_TEXT_CHARS = 1_800_000;
const MAX_COMPRESSED_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_RAW_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_MEMORY_TEXT_CHARS = 1_800_000;
const ROOT_MEMORY_ALLOWLIST = new Set([
  "INDEX.md",
  "PROFILE.md",
  "PREFERENCES.md",
  "NETWORK.md",
  "APPS.md",
  "RUNBOOKS.md",
  "FACTS.md",
  "README.md",
]);

interface DshSessionFile {
  file: string;
  sessionId: string;
  workspaceFolder: string;
}

interface DshSessionMeta {
  sessionId: string;
  cwd: string | null;
  createdAt: string | null;
}

interface WorkspaceMatch {
  id: string;
  canonicalPath: string;
  displayName: string;
  projectId: string | null;
  projectName: string | null;
}

interface ParsedArtifact {
  externalId: string;
  externalPart: string;
  externalRevision: string | null;
  externalUpdatedAt: string;
  eventAt: string;
  title: string;
  authorLabel: string;
  text: string;
  safeItemCount: number;
  redactionCount: number;
  workspace: WorkspaceMatch | null;
}

interface SnapshotGuard {
  expectedExternalPart?: string;
  expectedProjectId?: string | null;
  expectedWorkspaceBindingId?: string | null;
}

function assertExpectedSnapshot(externalPart: string, guard: SnapshotGuard): void {
  if (guard.expectedExternalPart && guard.expectedExternalPart !== externalPart) {
    throw new ApiError(
      409,
      "sync_preview_drift",
      "Connector snapshot changed after planning and before persistence; retry sync.",
    );
  }
}

function assertExpectedWorkspace(workspace: WorkspaceMatch | null, guard: SnapshotGuard): void {
  if (guard.expectedProjectId !== undefined && workspace?.projectId !== guard.expectedProjectId) {
    throw new ApiError(
      409,
      "sync_workspace_mismatch",
      "DSH workspace/project identity changed between catalog planning and import; retry after reconciling the workspace.",
      { expectedProjectId: guard.expectedProjectId, actualProjectId: workspace?.projectId ?? null },
    );
  }
  if (guard.expectedWorkspaceBindingId !== undefined && workspace?.id !== guard.expectedWorkspaceBindingId) {
    throw new ApiError(
      409,
      "sync_workspace_mismatch",
      "DSH workspace binding changed between catalog planning and import; retry after reconciling the workspace.",
      { expectedWorkspaceBindingId: guard.expectedWorkspaceBindingId, actualWorkspaceBindingId: workspace?.id ?? null },
    );
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2500,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function workspaceRows(db: Db): WorkspaceMatch[] {
  const rows = db.select().from(workspaceBindings).all();
  const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => id !== null))];
  const projectRows = projectIds.length
    ? db.select().from(projects).where(inArray(projects.id, projectIds)).all()
    : [];
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  return rows.map((row) => ({
    id: row.id,
    canonicalPath: row.canonicalPath,
    displayName: row.displayName,
    projectId: row.projectId,
    projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
  }));
}

function encodeDshWorkspaceFolder(canonicalPath: string): string {
  const absolute = path.resolve(canonicalPath);
  const body = absolute.split(path.sep).filter(Boolean).join("-");
  return `--${body}--`;
}

function buildFolderWorkspaceResolver(db: Db): (folder: string) => WorkspaceMatch | null {
  const byFolder = new Map<string, WorkspaceMatch[]>();
  for (const row of workspaceRows(db)) {
    const key = encodeDshWorkspaceFolder(row.canonicalPath);
    const list = byFolder.get(key) ?? [];
    list.push(row);
    byFolder.set(key, list);
  }
  return (folder: string) => {
    const matches = byFolder.get(folder) ?? [];
    return matches.length === 1 ? matches[0]! : null;
  };
}

function buildCwdWorkspaceResolver(db: Db): (cwd: string | null) => WorkspaceMatch | null {
  const rows = workspaceRows(db);
  const byPath = new Map(rows.map((row) => [row.canonicalPath, row]));
  const rawRows = db.select().from(workspaceBindings).all();
  const byKey = new Map(rawRows.map((row) => [row.canonicalKey, row.id]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cache = new Map<string, WorkspaceMatch | null>();

  return (cwd: string | null): WorkspaceMatch | null => {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    let match: WorkspaceMatch | null = null;
    if (fs.existsSync(cwd)) {
      const remote = normalizeGitRemote(git(cwd, ["config", "--get", "remote.origin.url"]));
      if (remote) {
        const id = byKey.get(`git:${remote}`);
        if (id) match = byId.get(id) ?? null;
      }
      if (!match) {
        try {
          match = byPath.get(fs.realpathSync.native(cwd)) ?? null;
        } catch {
          // Fall through to lexical path.
        }
      }
    }
    if (!match) match = byPath.get(path.resolve(cwd)) ?? null;
    cache.set(cwd, match);
    return match;
  };
}

function importedSnapshotCounts(db: Db): Map<string, number> {
  const rows = db
    .select({ externalId: sourceOrigins.externalId })
    .from(sourceOrigins)
    .where(eq(sourceOrigins.connector, "dsh"))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.externalId, (counts.get(row.externalId) ?? 0) + 1);
  return counts;
}

function sessionFiles(dshHome: string): DshSessionFile[] {
  const root = path.join(dshHome, "sessions");
  if (!fs.existsSync(root)) return [];
  let workspaceEntries: fs.Dirent[];
  try {
    workspaceEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    throw new ApiError(409, "dsh_sessions_unreadable", "DSH sessions root exists but cannot be enumerated safely.");
  }
  const out: DshSessionFile[] = [];
  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) continue;
    if (!/^--.+--$/.test(workspaceEntry.name)) continue;
    const workspaceDir = path.join(root, workspaceEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(sessionEntry.name)) continue;
      const file = path.join(workspaceDir, sessionEntry.name, "session.jsonl.zstd");
      try {
        const lst = fs.lstatSync(file);
        if (!lst.isFile() || lst.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      out.push({ file, sessionId: sessionEntry.name, workspaceFolder: workspaceEntry.name });
    }
  }
  return out;
}

const DSH_RECENCY_CACHE_LIMIT = 512;
const dshRecencyCache = new Map<string, { signature: string; updatedAt: string }>();

function dshSessionUpdatedAt(file: string): string {
  const stat = fs.statSync(file);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = dshRecencyCache.get(file);
  if (cached?.signature === signature) return cached.updatedAt;

  let latestMs = Number.NEGATIVE_INFINITY;
  forEachZstdJsonLine(file, (line) => {
    let root: Record<string, unknown> | null = null;
    try {
      root = asObject(JSON.parse(line));
    } catch {
      throw new ApiError(409, "dsh_session_invalid", "DSH session contains an invalid JSONL record.");
    }
    if (!root) return;
    const data = asObject(root.data);
    const candidates = [root.time, root.createdAt, data?.createdAt];
    for (const value of candidates) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      latestMs = Math.max(latestMs, value);
    }
  });
  const updatedAt = Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : "1970-01-01T00:00:00.000Z";
  if (dshRecencyCache.size >= DSH_RECENCY_CACHE_LIMIT) dshRecencyCache.clear();
  dshRecencyCache.set(file, { signature, updatedAt });
  return updatedAt;
}

export function catalogDshSessions(db: Db, dshHome: string, limit: number): DshSessionCatalogDto {
  const files = sessionFiles(dshHome);
  const imported = importedSnapshotCounts(db);
  const resolveFolder = buildFolderWorkspaceResolver(db);
  let unreadableCount = 0;
  const sessions: DshSessionDto[] = [];
  for (const item of files) {
    try {
      const stat = fs.statSync(item.file);
      const workspace = resolveFolder(item.workspaceFolder);
      sessions.push({
        sessionId: item.sessionId,
        relativePath: path.relative(dshHome, item.file),
        workspaceFolder: item.workspaceFolder,
        updatedAt: dshSessionUpdatedAt(item.file),
        byteSize: stat.size,
        workspaceBindingId: workspace?.id ?? null,
        workspaceName: workspace?.displayName ?? null,
        projectId: workspace?.projectId ?? null,
        projectName: workspace?.projectName ?? null,
        importedSnapshotCount: imported.get(item.sessionId) ?? 0,
      });
    } catch {
      unreadableCount += 1;
    }
  }
  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { totalCount: files.length, unreadableCount, sessions: sessions.slice(0, limit) };
}

function forEachZstdJsonLine(file: string, visit: (line: string) => void): void {
  const stat = fs.statSync(file);
  if (stat.size > MAX_COMPRESSED_SESSION_BYTES) {
    throw new ApiError(409, "dsh_session_too_large", "Compressed DSH session exceeds the M3.3 single-import bound.");
  }
  const input = fs.readFileSync(file);
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let rawBytes = 0;
  let carry = "";
  while (offset < input.length) {
    let result: ReturnType<typeof zstdDecompressSync> extends Buffer ? never : ReturnType<typeof zstdDecompressSync>;
    try {
      result = zstdDecompressSync(input.subarray(offset), {
        info: true,
        maxOutputLength: MAX_FRAME_OUTPUT_BYTES,
      }) as typeof result;
    } catch {
      throw new ApiError(409, "dsh_session_invalid_zstd", "DSH session contains an invalid or oversized zstd frame.");
    }
    const info = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = info.engine.bytesWritten;
    if (!Number.isInteger(consumed) || consumed <= 0 || consumed > input.length - offset) {
      throw new ApiError(409, "dsh_session_invalid_zstd", "DSH zstd frame did not report a valid consumed-byte count.");
    }
    offset += consumed;
    rawBytes += info.buffer.length;
    if (rawBytes > MAX_RAW_SESSION_BYTES) {
      throw new ApiError(409, "dsh_session_too_large", "Decompressed DSH session exceeds the M3.3 safety bound.");
    }
    const text = carry + decoder.write(info.buffer);
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) visit(line);
  }
  const tail = carry + decoder.end();
  if (tail.trim()) visit(tail);
}

async function parseSafeSession(file: string, expectedSessionId: string): Promise<{
  meta: DshSessionMeta;
  text: string;
  safeItemCount: number;
  redactionCount: number;
  lastSeq: number | null;
  lastSafeAt: string | null;
}> {
  let meta: DshSessionMeta | null = null;
  const parts: string[] = [];
  let chars = 0;
  let safeItemCount = 0;
  let lastSeq: number | null = null;
  let lastSafeAt: string | null = null;

  forEachZstdJsonLine(file, (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ApiError(409, "dsh_session_invalid", "DSH session contains an invalid JSONL record.");
    }
    const root = asObject(parsed);
    if (!root) return;
    if (typeof root.seq === "number" && Number.isInteger(root.seq)) {
      lastSeq = lastSeq === null ? root.seq : Math.max(lastSeq, root.seq);
    }

    if (root.type === "session") {
      const nested = asObject(root.data);
      const data = nested ?? root;
      const id = asString(data.id) ?? asString(root.id);
      if (!id) throw new ApiError(409, "dsh_session_invalid", "DSH session record has no id.");
      meta = {
        sessionId: id,
        cwd: asString(data.cwd) ?? asString(root.cwd),
        createdAt: epochIso(data.createdAt) ?? epochIso(root.createdAt),
      };
      return;
    }

    const data = asObject(root.data);
    if (!data) return;
    let role: "user" | "assistant" | null = null;
    let content: unknown = null;
    if (root.type === "user/message") {
      role = "user";
      content = data.content;
    } else if (root.type === "assistant/message") {
      role = "assistant";
      content = asObject(data.message)?.content;
    } else {
      return;
    }
    if (!role || !Array.isArray(content)) return;
    const textParts = content
      .map(asObject)
      .filter((item): item is Record<string, unknown> => item !== null && item.type === "text")
      .map((item) => asString(item.text))
      .filter((text): text is string => text !== null);
    if (textParts.length === 0) return;
    const rendered = `${role === "user" ? "User" : "Assistant"}:\n${textParts.join("\n")}`;
    chars += rendered.length + 2;
    if (chars > MAX_CONNECTOR_TEXT_CHARS) {
      throw new ApiError(409, "dsh_session_too_large", `Safe DSH session text exceeds ${MAX_CONNECTOR_TEXT_CHARS} chars.`);
    }
    parts.push(rendered);
    safeItemCount += 1;
    lastSafeAt = epochIso(root.time) ?? lastSafeAt;
  });

  if (!meta) throw new ApiError(409, "dsh_session_invalid", "DSH session has no session identity record.");
  const sessionMeta = meta as DshSessionMeta;
  if (sessionMeta.sessionId !== expectedSessionId) {
    throw new ApiError(409, "dsh_session_identity_mismatch", "DSH session id does not match its directory identity.");
  }
  if (safeItemCount === 0) {
    throw new ApiError(409, "dsh_session_no_safe_text", "DSH session contains no eligible user-visible text messages.");
  }
  const redacted = redactCredentialLikeText(parts.join("\n\n"));
  return {
    meta: sessionMeta,
    text: redacted.text,
    safeItemCount,
    redactionCount: redacted.redactionCount,
    lastSeq,
    lastSafeAt,
  };
}

function findSessionFile(dshHome: string, sessionId: string): DshSessionFile {
  const matches = sessionFiles(dshHome).filter((item) => item.sessionId === sessionId);
  if (matches.length === 0) throw new ApiError(404, "dsh_session_not_found", "DSH session was not found.");
  if (matches.length > 1) throw new ApiError(409, "dsh_session_ambiguous", "DSH session id exists in more than one workspace folder.");
  return matches[0]!;
}

async function persistArtifact(
  deps: ServiceDeps,
  artifact: ParsedArtifact,
  adapterId: string,
  confirmNearDuplicateOf: string | null,
  ctx: { actor: string; requestId?: string | null },
): Promise<DshImportResultDto> {
  const existingOrigin = deps.db
    .select()
    .from(sourceOrigins)
    .where(
      and(
        eq(sourceOrigins.connector, "dsh"),
        eq(sourceOrigins.externalId, artifact.externalId),
        eq(sourceOrigins.externalPart, artifact.externalPart),
      ),
    )
    .get();
  if (existingOrigin) {
    deps.db
      .update(sourceOrigins)
      .set({
        externalRevision: artifact.externalRevision,
        externalUpdatedAt: artifact.externalUpdatedAt,
        workspaceBindingId: artifact.workspace?.id ?? existingOrigin.workspaceBindingId,
      })
      .where(eq(sourceOrigins.id, existingOrigin.id))
      .run();
    return {
      status: "unchanged",
      externalId: artifact.externalId,
      externalPart: artifact.externalPart,
      sourceId: existingOrigin.sourceId,
      workspaceBindingId: artifact.workspace?.id ?? null,
      projectId: artifact.workspace?.projectId ?? null,
      safeItemCount: artifact.safeItemCount,
      safeCharCount: artifact.text.length,
      redactionCount: artifact.redactionCount,
      importResult: null,
    };
  }

  const input: ImportTextInput = {
    text: artifact.text,
    kind: "paste",
    title: artifact.title,
    originalFilename: null,
    projectId: artifact.workspace?.projectId ?? null,
    adapterId,
    eventAt: artifact.eventAt,
    authorLabel: artifact.authorLabel,
    confirmNearDuplicateOf,
  };
  const result = await runDurablyClaimedImport(deps, input, ctx);
  if (result.status === "near_duplicate_pending") {
    return {
      status: "near_duplicate_pending",
      externalId: artifact.externalId,
      externalPart: artifact.externalPart,
      sourceId: null,
      workspaceBindingId: artifact.workspace?.id ?? null,
      projectId: artifact.workspace?.projectId ?? null,
      safeItemCount: artifact.safeItemCount,
      safeCharCount: artifact.text.length,
      redactionCount: artifact.redactionCount,
      importResult: result,
    };
  }

  const sourceId = result.source?.id ?? result.duplicateOf?.sourceId ?? null;
  if (!sourceId) throw new ApiError(500, "dsh_import_source_missing", "DSH import produced no source identity.");
  const now = nowIso();
  deps.db.transaction((tx) => {
    if (result.source) {
      tx.update(sources)
        .set({
          provenanceBasis: "system",
          redactionState: artifact.redactionCount > 0 ? "automatic" : "none",
        })
        .where(eq(sources.id, sourceId))
        .run();
    }
    tx.insert(sourceOrigins)
      .values({
        id: newId(),
        sourceId,
        connector: "dsh",
        externalId: artifact.externalId,
        externalPart: artifact.externalPart,
        externalRevision: artifact.externalRevision,
        externalHash: sha256(artifact.text),
        workspaceBindingId: artifact.workspace?.id ?? null,
        archiveState: "unknown",
        externalUpdatedAt: artifact.externalUpdatedAt,
        createdAt: now,
      })
      .run();
    writeAudit(tx, {
      actor: ctx.actor,
      action: "connector.source_origin_linked",
      targetType: "source",
      targetId: sourceId,
      detail: {
        connector: "dsh",
        externalId: artifact.externalId,
        externalPart: artifact.externalPart,
        workspaceBindingId: artifact.workspace?.id ?? null,
        redacted: artifact.redactionCount > 0,
      },
      requestId: ctx.requestId ?? null,
    });
  });

  return {
    status: result.status === "duplicate_skipped" ? "duplicate_linked" : "created",
    externalId: artifact.externalId,
    externalPart: artifact.externalPart,
    sourceId,
    workspaceBindingId: artifact.workspace?.id ?? null,
    projectId: artifact.workspace?.projectId ?? null,
    safeItemCount: artifact.safeItemCount,
    safeCharCount: artifact.text.length,
    redactionCount: artifact.redactionCount,
    importResult: result,
  };
}

export async function importDshSession(
  deps: ServiceDeps,
  dshHome: string,
  input: DshSessionImportInput,
  ctx: { actor: string; requestId?: string | null },
  guard: SnapshotGuard = {},
): Promise<DshImportResultDto> {
  const item = findSessionFile(dshHome, input.sessionId);
  const parsed = await parseSafeSession(item.file, input.sessionId);
  const stat = fs.statSync(item.file);
  const workspace = buildCwdWorkspaceResolver(deps.db)(parsed.meta.cwd);
  const hash = sha256(parsed.text);
  const externalPart = `snapshot:${hash}`;
  assertExpectedSnapshot(externalPart, guard);
  assertExpectedWorkspace(workspace, guard);
  return persistArtifact(
    deps,
    {
      externalId: input.sessionId,
      externalPart,
      externalRevision: parsed.lastSeq === null ? null : String(parsed.lastSeq),
      externalUpdatedAt: dshSessionUpdatedAt(item.file),
      eventAt: parsed.lastSafeAt ?? parsed.meta.createdAt ?? stat.mtime.toISOString(),
      title: `DSH session ${input.sessionId.slice(0, 12)}`,
      authorLabel: "dsh",
      text: parsed.text,
      safeItemCount: parsed.safeItemCount,
      redactionCount: parsed.redactionCount,
      workspace,
    },
    input.adapterId,
    input.confirmNearDuplicateOf,
    ctx,
  );
}

function allowedMemoryRelativePath(relativePath: string): boolean {
  if (ROOT_MEMORY_ALLOWLIST.has(relativePath)) return true;
  return /^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(relativePath);
}

function memoryRoot(dshHome: string, required: boolean): string | null {
  const rootPath = path.join(dshHome, "memory");
  if (!fs.existsSync(rootPath)) {
    if (required) throw new ApiError(404, "dsh_memory_not_found", "DSH memory root does not exist.");
    return null;
  }
  try {
    const homeReal = fs.realpathSync.native(dshHome);
    const rootStat = fs.lstatSync(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ApiError(409, "dsh_memory_unsafe_root", "DSH memory root must be a real directory, not a symlink.");
    }
    const rootReal = fs.realpathSync.native(rootPath);
    if (rootReal !== path.join(homeReal, "memory")) {
      throw new ApiError(409, "dsh_memory_unsafe_root", "DSH memory root resolves outside the configured DSH home.");
    }
    return rootReal;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "dsh_memory_unsafe_root", "DSH memory root cannot be resolved safely.");
  }
}

function memoryFiles(dshHome: string): string[] {
  const root = memoryRoot(dshHome, false);
  if (!root) return [];
  const out: string[] = [];
  for (const name of ROOT_MEMORY_ALLOWLIST) {
    const file = path.join(root, name);
    try {
      const lst = fs.lstatSync(file);
      if (lst.isFile() && !lst.isSymbolicLink()) out.push(file);
    } catch {
      // Optional memory file absent.
    }
  }
  const journal = path.join(root, "journal");
  try {
    const journalStat = fs.lstatSync(journal);
    if (journalStat.isDirectory() && !journalStat.isSymbolicLink()) {
      for (const entry of fs.readdirSync(journal, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue;
        out.push(path.join(journal, entry.name));
      }
    }
  } catch {
    // Journal is optional.
  }
  return out;
}

export function catalogDshMemory(db: Db, dshHome: string, limit: number): DshMemoryCatalogDto {
  const root = memoryRoot(dshHome, false);
  const files = memoryFiles(dshHome);
  const imported = importedSnapshotCounts(db);
  let unreadableCount = 0;
  const items: DshMemoryDto[] = [];
  if (!root) return { totalCount: 0, unreadableCount: 0, files: [] };
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const relativePath = path.relative(root, file).split(path.sep).join("/");
      const externalId = `memory:${relativePath}`;
      items.push({
        relativePath,
        updatedAt: stat.mtime.toISOString(),
        byteSize: stat.size,
        importedSnapshotCount: imported.get(externalId) ?? 0,
      });
    } catch {
      unreadableCount += 1;
    }
  }
  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { totalCount: files.length, unreadableCount, files: items.slice(0, limit) };
}

export async function importDshMemory(
  deps: ServiceDeps,
  dshHome: string,
  input: DshMemoryImportInput,
  ctx: { actor: string; requestId?: string | null },
  guard: SnapshotGuard = {},
): Promise<DshImportResultDto> {
  const relativePath = input.relativePath.replaceAll("\\", "/");
  if (!allowedMemoryRelativePath(relativePath) || path.posix.normalize(relativePath) !== relativePath) {
    throw new ApiError(400, "dsh_memory_invalid_path", "DSH memory path is outside the M3.3 allowlist.");
  }
  const rootReal = memoryRoot(dshHome, true)!;
  const file = path.join(rootReal, ...relativePath.split("/"));
  let stat: fs.Stats;
  try {
    const lst = fs.lstatSync(file);
    if (!lst.isFile() || lst.isSymbolicLink()) throw new Error("not a regular file");
    const real = fs.realpathSync.native(file);
    if (real !== path.join(rootReal, ...relativePath.split("/"))) throw new Error("path escapes memory root");
    stat = fs.statSync(file);
  } catch {
    throw new ApiError(404, "dsh_memory_not_found", "DSH memory file was not found on the safe allowlist surface.");
  }
  if (stat.size > MAX_MEMORY_TEXT_CHARS * 4) {
    throw new ApiError(409, "dsh_memory_too_large", "DSH memory file exceeds the M3.3 single-import bound.");
  }
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length > MAX_MEMORY_TEXT_CHARS) {
    throw new ApiError(409, "dsh_memory_too_large", "DSH memory file exceeds the M3.3 single-import bound.");
  }
  const redacted = redactCredentialLikeText(raw);
  const hash = sha256(redacted.text);
  const externalPart = `snapshot:${hash}`;
  assertExpectedSnapshot(externalPart, guard);
  const updatedAt = stat.mtime.toISOString();
  return persistArtifact(
    deps,
    {
      externalId: `memory:${relativePath}`,
      externalPart,
      externalRevision: String(Math.trunc(stat.mtimeMs)),
      externalUpdatedAt: updatedAt,
      eventAt: updatedAt,
      title: `DSH memory ${relativePath}`,
      authorLabel: "dsh-memory",
      text: redacted.text,
      safeItemCount: 1,
      redactionCount: redacted.redactionCount,
      workspace: null,
    },
    input.adapterId,
    input.confirmNearDuplicateOf,
    ctx,
  );
}
