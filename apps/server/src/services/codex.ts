import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { and, eq, inArray } from "drizzle-orm";
import type {
  CodexArchiveState,
  CodexImportResultDto,
  CodexSessionCatalogDto,
  CodexSessionDto,
  CodexSessionImportInput,
  CodexSummaryCatalogDto,
  CodexSummaryDto,
  CodexSummaryImportInput,
  ImportTextInput,
} from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import { projects, sources } from "../db/schema.js";
import { sourceOrigins, workspaceBindings } from "../db/workspace-schema.js";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { newId } from "../lib/ids.js";
import { nowIso } from "../lib/time.js";
import { normalizeGitRemote } from "./workspaces.js";
import type { ServiceDeps } from "./import.js";
import { runDurablyClaimedImport } from "./initial-import-claim.js";
import { writeAudit } from "./audit.js";
import { redactCredentialLikeText } from "./redaction.js";

const MAX_CONNECTOR_TEXT_CHARS = 1_800_000;
const MAX_SESSION_META_LINE_BYTES = 2 * 1024 * 1024;
const SUMMARY_CATALOG_PREFIX_BYTES = 32 * 1024;

interface SessionFile {
  file: string;
  archiveState: CodexArchiveState;
}

interface SessionMeta {
  sessionId: string;
  cwd: string | null;
  createdAt: string | null;
}

interface WorkspaceMatch {
  id: string;
  displayName: string;
  projectId: string | null;
  projectName: string | null;
}

interface ParsedArtifact {
  externalId: string;
  externalPart: string;
  externalRevision: string | null;
  archiveState: "current" | "archived" | "unknown";
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validIso(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function isEligibleMessageText(role: "user" | "assistant", item: Record<string, unknown>): boolean {
  const type = item.type;
  return (
    type === "text" ||
    (role === "user" && type === "input_text") ||
    (role === "assistant" && type === "output_text")
  );
}

function isInjectedEnvironmentContext(text: string): boolean {
  const trimmed = text.trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed);
}

function readFirstLine(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_SESSION_META_LINE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SESSION_META_LINE_BYTES - total));
      const read = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (read <= 0) break;
      const chunk = buffer.subarray(0, read);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
      total += read;
    }
    if (chunks.length === 0) throw new Error("empty file");
    if (total >= MAX_SESSION_META_LINE_BYTES) throw new Error("session_meta line exceeds safety bound");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseSessionMeta(file: string): SessionMeta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFirstLine(file));
  } catch {
    throw new ApiError(409, "codex_session_invalid", "Codex session metadata is not valid JSON.");
  }
  const root = asObject(parsed);
  const payload = asObject(root?.payload);
  if (root?.type !== "session_meta" || !payload) {
    throw new ApiError(409, "codex_session_invalid", "Codex session does not begin with session_meta.");
  }
  const sessionId = asString(payload.session_id);
  if (!sessionId) throw new ApiError(409, "codex_session_invalid", "Codex session_meta has no session_id.");
  return {
    sessionId,
    cwd: asString(payload.cwd),
    createdAt: validIso(payload.timestamp) ?? validIso(root.timestamp),
  };
}

function listFiles(root: string, maxDepth: number): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function sessionFiles(codexHome: string): SessionFile[] {
  const current = listFiles(path.join(codexHome, "sessions"), 4).map((file) => ({
    file,
    archiveState: "current" as const,
  }));
  const archived = listFiles(path.join(codexHome, "archived_sessions"), 1).map((file) => ({
    file,
    archiveState: "archived" as const,
  }));
  return [...current, ...archived];
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

function buildWorkspaceResolver(db: Db): (cwd: string | null) => WorkspaceMatch | null {
  const workspaceRows = db.select().from(workspaceBindings).all();
  const projectIds = [...new Set(workspaceRows.map((row) => row.projectId).filter((id): id is string => id !== null))];
  const projectRows = projectIds.length
    ? db.select().from(projects).where(inArray(projects.id, projectIds)).all()
    : [];
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  const byKey = new Map(workspaceRows.map((row) => [row.canonicalKey, row]));
  const byPath = new Map(workspaceRows.map((row) => [row.canonicalPath, row]));
  const cache = new Map<string, WorkspaceMatch | null>();

  const toMatch = (row: typeof workspaceBindings.$inferSelect | undefined): WorkspaceMatch | null =>
    row
      ? {
          id: row.id,
          displayName: row.displayName,
          projectId: row.projectId,
          projectName: row.projectId ? (projectNames.get(row.projectId) ?? null) : null,
        }
      : null;

  return (cwd: string | null): WorkspaceMatch | null => {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    if (cache.has(cwd)) return cache.get(cwd) ?? null;

    let match: WorkspaceMatch | null = null;
    if (fs.existsSync(cwd)) {
      const remote = normalizeGitRemote(git(cwd, ["config", "--get", "remote.origin.url"]));
      if (remote) match = toMatch(byKey.get(`git:${remote}`));
      if (!match) {
        try {
          match = toMatch(byPath.get(fs.realpathSync.native(cwd)));
        } catch {
          // Fall through to exact lexical path.
        }
      }
    }
    if (!match) match = toMatch(byPath.get(path.resolve(cwd)));
    cache.set(cwd, match);
    return match;
  };
}

function importedSnapshotCounts(db: Db): Map<string, number> {
  const rows = db
    .select({ externalId: sourceOrigins.externalId })
    .from(sourceOrigins)
    .where(eq(sourceOrigins.connector, "codex"))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.externalId, (counts.get(row.externalId) ?? 0) + 1);
  return counts;
}

const CODEX_RECENCY_TAIL_BYTES = 256 * 1024;

function codexSessionUpdatedAt(file: string, fallback: string | null): string {
  const stat = fs.statSync(file);
  if (stat.size === 0) return fallback ?? "1970-01-01T00:00:00.000Z";
  const readBytes = Math.min(stat.size, CODEX_RECENCY_TAIL_BYTES);
  const buffer = Buffer.allocUnsafe(readBytes);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (stat.size > readBytes) lines.shift();
  let latest = fallback;
  let latestMs = fallback ? Date.parse(fallback) : Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const root = asObject(JSON.parse(line));
      const stamp = validIso(root?.timestamp);
      if (!stamp) continue;
      const millis = Date.parse(stamp);
      if (millis > latestMs) {
        latest = stamp;
        latestMs = millis;
      }
    } catch {
      // Tail fragments may be partial; fall back to other embedded timestamps.
    }
  }
  return latest ?? "1970-01-01T00:00:00.000Z";
}

export function catalogCodexSessions(
  db: Db,
  codexHome: string,
  opts: { state: "all" | CodexArchiveState; limit: number },
): CodexSessionCatalogDto {
  const files = sessionFiles(codexHome);
  const currentCount = files.filter((item) => item.archiveState === "current").length;
  const archivedCount = files.length - currentCount;
  const imported = importedSnapshotCounts(db);
  const resolveWorkspace = buildWorkspaceResolver(db);
  let unreadableCount = 0;
  const sessions: CodexSessionDto[] = [];

  for (const item of files) {
    if (opts.state !== "all" && item.archiveState !== opts.state) continue;
    try {
      const meta = parseSessionMeta(item.file);
      const stat = fs.statSync(item.file);
      const workspace = resolveWorkspace(meta.cwd);
      sessions.push({
        sessionId: meta.sessionId,
        archiveState: item.archiveState,
        relativePath: path.relative(codexHome, item.file),
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        updatedAt: codexSessionUpdatedAt(item.file, meta.createdAt),
        byteSize: stat.size,
        workspaceBindingId: workspace?.id ?? null,
        workspaceName: workspace?.displayName ?? null,
        projectId: workspace?.projectId ?? null,
        projectName: workspace?.projectName ?? null,
        importedSnapshotCount: imported.get(meta.sessionId) ?? 0,
      });
    } catch {
      unreadableCount += 1;
    }
  }

  sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { currentCount, archivedCount, unreadableCount, sessions: sessions.slice(0, opts.limit) };
}

async function parseSafeSession(file: string, expectedSessionId: string): Promise<{
  meta: SessionMeta;
  text: string;
  safeItemCount: number;
  redactionCount: number;
  lastOrdinal: number | null;
  lastSafeAt: string | null;
}> {
  const meta = parseSessionMeta(file);
  if (meta.sessionId !== expectedSessionId) {
    throw new ApiError(409, "codex_session_identity_mismatch", "Codex session id does not match its metadata.");
  }

  const parts: string[] = [];
  let chars = 0;
  let safeItemCount = 0;
  let lastOrdinal: number | null = null;
  let lastSafeAt: string | null = null;
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ApiError(409, "codex_session_invalid", "Codex session contains an invalid JSONL record.");
      }
      const root = asObject(parsed);
      if (!root) continue;
      if (typeof root.ordinal === "number" && Number.isInteger(root.ordinal)) {
        lastOrdinal = lastOrdinal === null ? root.ordinal : Math.max(lastOrdinal, root.ordinal);
      }
      if (root.type !== "response_item") continue;
      const payload = asObject(root.payload);
      if (!payload || payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      if (!Array.isArray(payload.content)) continue;
      const textParts = payload.content
        .map(asObject)
        .filter((item): item is Record<string, unknown> => item !== null && isEligibleMessageText(role, item))
        .map((item) => asString(item.text))
        .filter((text): text is string => text !== null)
        .filter((text) => role !== "user" || !isInjectedEnvironmentContext(text));
      if (textParts.length === 0) continue;

      const rendered = `${role === "user" ? "User" : "Assistant"}:\n${textParts.join("\n")}`;
      chars += rendered.length + 2;
      if (chars > MAX_CONNECTOR_TEXT_CHARS) {
        throw new ApiError(
          409,
          "codex_session_too_large",
          `Safe user-visible session text exceeds the M3.2 single-import bound (${MAX_CONNECTOR_TEXT_CHARS} chars).`,
        );
      }
      parts.push(rendered);
      safeItemCount += 1;
      lastSafeAt = validIso(root.timestamp);
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (safeItemCount === 0) {
    throw new ApiError(409, "codex_session_no_safe_text", "Codex session contains no eligible user-visible text messages.");
  }
  const redacted = redactCredentialLikeText(parts.join("\n\n"));
  return {
    meta,
    text: redacted.text,
    safeItemCount,
    redactionCount: redacted.redactionCount,
    lastOrdinal,
    lastSafeAt,
  };
}

function findSessionFile(codexHome: string, sessionId: string, archiveState: CodexArchiveState): string {
  const match = sessionFiles(codexHome).find((item) => {
    if (item.archiveState !== archiveState) return false;
    try {
      return parseSessionMeta(item.file).sessionId === sessionId;
    } catch {
      return false;
    }
  });
  if (!match) throw new ApiError(404, "codex_session_not_found", `Codex ${archiveState} session was not found.`);
  return match.file;
}

async function persistArtifact(
  deps: ServiceDeps,
  artifact: ParsedArtifact,
  adapterId: string,
  confirmNearDuplicateOf: string | null,
  ctx: { actor: string; requestId?: string | null },
): Promise<CodexImportResultDto> {
  const existingOrigin = deps.db
    .select()
    .from(sourceOrigins)
    .where(
      and(
        eq(sourceOrigins.connector, "codex"),
        eq(sourceOrigins.externalId, artifact.externalId),
        eq(sourceOrigins.externalPart, artifact.externalPart),
      ),
    )
    .get();
  if (existingOrigin) {
    deps.db
      .update(sourceOrigins)
      .set({
        archiveState: artifact.archiveState,
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
      archiveState: artifact.archiveState,
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
      archiveState: artifact.archiveState,
      workspaceBindingId: artifact.workspace?.id ?? null,
      projectId: artifact.workspace?.projectId ?? null,
      safeItemCount: artifact.safeItemCount,
      safeCharCount: artifact.text.length,
      redactionCount: artifact.redactionCount,
      importResult: result,
    };
  }

  const sourceId = result.source?.id ?? result.duplicateOf?.sourceId ?? null;
  if (!sourceId) throw new ApiError(500, "codex_import_source_missing", "Codex import produced no source identity.");
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
        connector: "codex",
        externalId: artifact.externalId,
        externalPart: artifact.externalPart,
        externalRevision: artifact.externalRevision,
        externalHash: sha256(artifact.text),
        workspaceBindingId: artifact.workspace?.id ?? null,
        archiveState: artifact.archiveState,
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
        connector: "codex",
        externalId: artifact.externalId,
        externalPart: artifact.externalPart,
        workspaceBindingId: artifact.workspace?.id ?? null,
        archiveState: artifact.archiveState,
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
    archiveState: artifact.archiveState,
    workspaceBindingId: artifact.workspace?.id ?? null,
    projectId: artifact.workspace?.projectId ?? null,
    safeItemCount: artifact.safeItemCount,
    safeCharCount: artifact.text.length,
    redactionCount: artifact.redactionCount,
    importResult: result,
  };
}

export async function importCodexSession(
  deps: ServiceDeps,
  codexHome: string,
  input: CodexSessionImportInput,
  ctx: { actor: string; requestId?: string | null },
  guard: SnapshotGuard = {},
): Promise<CodexImportResultDto> {
  const file = findSessionFile(codexHome, input.sessionId, input.archiveState);
  const parsed = await parseSafeSession(file, input.sessionId);
  const stat = fs.statSync(file);
  const workspace = buildWorkspaceResolver(deps.db)(parsed.meta.cwd);
  const hash = sha256(parsed.text);
  const externalPart = `snapshot:${hash}`;
  assertExpectedSnapshot(externalPart, guard);
  return persistArtifact(
    deps,
    {
      externalId: input.sessionId,
      externalPart,
      externalRevision: parsed.lastOrdinal === null ? null : String(parsed.lastOrdinal),
      archiveState: input.archiveState,
      externalUpdatedAt: codexSessionUpdatedAt(file, parsed.meta.createdAt),
      eventAt: parsed.lastSafeAt ?? parsed.meta.createdAt ?? stat.mtime.toISOString(),
      title: `Codex session ${input.sessionId.slice(0, 12)}`,
      authorLabel: "codex",
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

function summaryRoot(codexHome: string): string {
  return path.join(codexHome, "memories", "rollout_summaries");
}

function summaryFiles(codexHome: string): string[] {
  const root = summaryRoot(codexHome);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));
}

function readPrefix(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function extractSummaryCwd(text: string): string | null {
  const match = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:cwd|working directory)\s*[:=]\s*[`"']?([^`"'\n]+)[`"']?/i);
  const cwd = match?.[1]?.trim();
  return cwd && path.isAbsolute(cwd) ? cwd : null;
}

export function catalogCodexSummaries(db: Db, codexHome: string, limit: number): CodexSummaryCatalogDto {
  const files = summaryFiles(codexHome);
  const imported = importedSnapshotCounts(db);
  const resolveWorkspace = buildWorkspaceResolver(db);
  let unreadableCount = 0;
  const summaries: CodexSummaryDto[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const fileName = path.basename(file);
      const cwd = extractSummaryCwd(readPrefix(file, SUMMARY_CATALOG_PREFIX_BYTES));
      const workspace = resolveWorkspace(cwd);
      const externalId = `rollout-summary:${fileName}`;
      summaries.push({
        fileName,
        relativePath: path.relative(codexHome, file),
        updatedAt: stat.mtime.toISOString(),
        byteSize: stat.size,
        cwd,
        workspaceBindingId: workspace?.id ?? null,
        workspaceName: workspace?.displayName ?? null,
        projectId: workspace?.projectId ?? null,
        projectName: workspace?.projectName ?? null,
        importedSnapshotCount: imported.get(externalId) ?? 0,
      });
    } catch {
      unreadableCount += 1;
    }
  }
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { totalCount: files.length, unreadableCount, summaries: summaries.slice(0, limit) };
}

export async function importCodexSummary(
  deps: ServiceDeps,
  codexHome: string,
  input: CodexSummaryImportInput,
  ctx: { actor: string; requestId?: string | null },
  guard: SnapshotGuard = {},
): Promise<CodexImportResultDto> {
  if (path.basename(input.fileName) !== input.fileName) {
    throw new ApiError(400, "codex_summary_invalid_name", "Codex summary filename must be a basename.");
  }
  const root = summaryRoot(codexHome);
  const file = path.join(root, input.fileName);
  let stat: fs.Stats;
  try {
    const lst = fs.lstatSync(file);
    if (!lst.isFile() || lst.isSymbolicLink()) throw new Error("not a regular file");
    stat = fs.statSync(file);
  } catch {
    throw new ApiError(404, "codex_summary_not_found", "Codex rollout summary was not found.");
  }
  if (stat.size > MAX_CONNECTOR_TEXT_CHARS * 4) {
    throw new ApiError(409, "codex_summary_too_large", "Codex rollout summary exceeds the M3.2 single-import bound.");
  }
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length > MAX_CONNECTOR_TEXT_CHARS) {
    throw new ApiError(409, "codex_summary_too_large", "Codex rollout summary exceeds the M3.2 single-import bound.");
  }
  const cwd = extractSummaryCwd(raw.slice(0, SUMMARY_CATALOG_PREFIX_BYTES));
  const redacted = redactCredentialLikeText(raw);
  const workspace = buildWorkspaceResolver(deps.db)(cwd);
  const hash = sha256(redacted.text);
  const externalPart = `snapshot:${hash}`;
  assertExpectedSnapshot(externalPart, guard);
  const updatedAt = stat.mtime.toISOString();
  return persistArtifact(
    deps,
    {
      externalId: `rollout-summary:${input.fileName}`,
      externalPart,
      externalRevision: String(Math.trunc(stat.mtimeMs)),
      archiveState: "unknown",
      externalUpdatedAt: updatedAt,
      eventAt: updatedAt,
      title: `Codex rollout summary ${input.fileName.replace(/\.md$/i, "")}`,
      authorLabel: "codex-memory",
      text: redacted.text,
      safeItemCount: 1,
      redactionCount: redacted.redactionCount,
      workspace,
    },
    input.adapterId,
    input.confirmNearDuplicateOf,
    ctx,
  );
}
