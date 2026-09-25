import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { zstdDecompressSync } from "node:zlib";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { redactCredentialLikeText } from "./redaction.js";

const MAX_TEXT_CHARS = 1_800_000;
const MAX_CODEX_META_BYTES = 2 * 1024 * 1024;
// Bound raw JSONL allocation as well as safe visible text. Tool/reasoning blobs
// may be much larger than the user-visible material that survives filtering.
const MAX_CODEX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_DSH_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DSH_FRAME_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_DSH_RAW_BYTES = 128 * 1024 * 1024;
const ROOT_DSH_MEMORY_ALLOWLIST = new Set([
  "INDEX.md",
  "PROFILE.md",
  "PREFERENCES.md",
  "NETWORK.md",
  "APPS.md",
  "RUNBOOKS.md",
  "FACTS.md",
  "README.md",
]);

export interface AgentArtifactPreview {
  connector: "codex" | "dsh";
  kind: "session" | "summary" | "memory";
  externalId: string;
  externalPart: string;
  externalRevision: string | null;
  archiveState: "current" | "archived" | "unknown";
  externalUpdatedAt: string;
  eventAt: string;
  authorLabel: string;
  text: string;
  safeItemCount: number;
  safeCharCount: number;
  redactionCount: number;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function iso(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function epochIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeFile(base: string, relativePath: string, allowedPrefix: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  if (path.posix.normalize(normalized) !== normalized || normalized.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new ApiError(400, "connector_preview_invalid_path", "Connector preview path escapes its allowlisted root.");
  }
  if (!normalized.startsWith(allowedPrefix)) {
    throw new ApiError(400, "connector_preview_invalid_path", "Connector preview path is outside its allowlisted surface.");
  }
  const rootReal = fs.realpathSync.native(base);
  const file = path.join(base, ...normalized.split("/"));
  const lst = fs.lstatSync(file);
  if (!lst.isFile() || lst.isSymbolicLink()) throw new ApiError(404, "connector_preview_not_found", "Connector artifact not found.");
  const real = fs.realpathSync.native(file);
  if (!real.startsWith(`${rootReal}${path.sep}`)) {
    throw new ApiError(400, "connector_preview_invalid_path", "Connector artifact resolves outside its root.");
  }
  return file;
}

function readFirstLine(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_CODEX_META_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CODEX_META_BYTES - total));
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
    if (!chunks.length || total >= MAX_CODEX_META_BYTES) throw new Error("invalid first line");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function codexMeta(file: string): { sessionId: string; createdAt: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFirstLine(file));
  } catch {
    throw new ApiError(409, "codex_session_invalid", "Codex session metadata is invalid.");
  }
  const root = obj(parsed);
  const payload = obj(root?.payload);
  const sessionId = payload ? str(payload.session_id) : null;
  if (root?.type !== "session_meta" || !payload || !sessionId) {
    throw new ApiError(409, "codex_session_invalid", "Codex session does not begin with valid session_meta.");
  }
  return { sessionId, createdAt: iso(payload.timestamp) ?? iso(root.timestamp) };
}

function eligibleCodexText(role: "user" | "assistant", item: Record<string, unknown>): boolean {
  return item.type === "text" || (role === "user" && item.type === "input_text") || (role === "assistant" && item.type === "output_text");
}

function injectedEnvironmentContext(text: string): boolean {
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text.trim());
}

export function previewCodexSession(
  codexHome: string,
  opts: { relativePath: string; sessionId: string; archiveState: "current" | "archived" },
): AgentArtifactPreview {
  const prefix = opts.archiveState === "archived" ? "archived_sessions/" : "sessions/";
  const file = safeFile(codexHome, opts.relativePath, prefix);
  const stat = fs.statSync(file);
  if (stat.size > MAX_CODEX_RAW_BYTES) {
    throw new ApiError(409, "codex_session_too_large", "Raw Codex session exceeds sync preview allocation bound.");
  }
  const meta = codexMeta(file);
  if (meta.sessionId !== opts.sessionId) throw new ApiError(409, "codex_session_identity_mismatch", "Codex session id mismatch.");
  const parts: string[] = [];
  let chars = 0;
  let safeItemCount = 0;
  let lastOrdinal: number | null = null;
  let lastSafeAt: string | null = null;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new ApiError(409, "codex_session_invalid", "Codex session contains invalid JSONL."); }
    const root = obj(parsed);
    if (!root) continue;
    if (typeof root.ordinal === "number" && Number.isInteger(root.ordinal)) lastOrdinal = lastOrdinal === null ? root.ordinal : Math.max(lastOrdinal, root.ordinal);
    if (root.type !== "response_item") continue;
    const payload = obj(root.payload);
    if (!payload || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(payload.content)) continue;
    const texts = payload.content
      .map(obj)
      .filter((item): item is Record<string, unknown> => item !== null && eligibleCodexText(role, item))
      .map((item) => str(item.text))
      .filter((text): text is string => text !== null)
      .filter((text) => role !== "user" || !injectedEnvironmentContext(text));
    if (!texts.length) continue;
    const rendered = `${role === "user" ? "User" : "Assistant"}:\n${texts.join("\n")}`;
    chars += rendered.length + 2;
    if (chars > MAX_TEXT_CHARS) throw new ApiError(409, "codex_session_too_large", "Safe Codex text exceeds sync preview bound.");
    parts.push(rendered);
    safeItemCount += 1;
    lastSafeAt = iso(root.timestamp);
  }
  if (!safeItemCount) throw new ApiError(409, "codex_session_no_safe_text", "Codex session has no eligible user-visible text.");
  const redacted = redactCredentialLikeText(parts.join("\n\n"));
  const hash = sha256(redacted.text);
  return {
    connector: "codex",
    kind: "session",
    externalId: opts.sessionId,
    externalPart: `snapshot:${hash}`,
    externalRevision: lastOrdinal === null ? null : String(lastOrdinal),
    archiveState: opts.archiveState,
    externalUpdatedAt: stat.mtime.toISOString(),
    eventAt: lastSafeAt ?? meta.createdAt ?? stat.mtime.toISOString(),
    authorLabel: "codex",
    text: redacted.text,
    safeItemCount,
    safeCharCount: redacted.text.length,
    redactionCount: redacted.redactionCount,
  };
}

export function previewCodexSummary(codexHome: string, fileName: string): AgentArtifactPreview {
  if (path.basename(fileName) !== fileName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(fileName)) {
    throw new ApiError(400, "codex_summary_invalid_name", "Invalid Codex rollout summary filename.");
  }
  const relativePath = `memories/rollout_summaries/${fileName}`;
  const file = safeFile(codexHome, relativePath, "memories/rollout_summaries/");
  const stat = fs.statSync(file);
  if (stat.size > MAX_TEXT_CHARS * 4) throw new ApiError(409, "codex_summary_too_large", "Codex summary exceeds preview bound.");
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length > MAX_TEXT_CHARS) throw new ApiError(409, "codex_summary_too_large", "Codex summary exceeds preview bound.");
  const redacted = redactCredentialLikeText(raw);
  const hash = sha256(redacted.text);
  const updated = stat.mtime.toISOString();
  return {
    connector: "codex",
    kind: "summary",
    externalId: `rollout-summary:${fileName}`,
    externalPart: `snapshot:${hash}`,
    externalRevision: String(Math.trunc(stat.mtimeMs)),
    archiveState: "unknown",
    externalUpdatedAt: updated,
    eventAt: updated,
    authorLabel: "codex-memory",
    text: redacted.text,
    safeItemCount: 1,
    safeCharCount: redacted.text.length,
    redactionCount: redacted.redactionCount,
  };
}

function eachDshLine(file: string, visit: (line: string) => void): void {
  const stat = fs.statSync(file);
  if (stat.size > MAX_DSH_COMPRESSED_BYTES) throw new ApiError(409, "dsh_session_too_large", "Compressed DSH session exceeds preview bound.");
  const input = fs.readFileSync(file);
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let rawBytes = 0;
  let carry = "";
  while (offset < input.length) {
    let result: unknown;
    try {
      result = zstdDecompressSync(input.subarray(offset), { info: true, maxOutputLength: MAX_DSH_FRAME_OUTPUT_BYTES });
    } catch {
      throw new ApiError(409, "dsh_session_invalid_zstd", "DSH session contains invalid/oversized zstd frame.");
    }
    const info = result as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = info.engine.bytesWritten;
    if (!Number.isInteger(consumed) || consumed <= 0 || consumed > input.length - offset) throw new ApiError(409, "dsh_session_invalid_zstd", "Invalid DSH zstd frame length.");
    offset += consumed;
    rawBytes += info.buffer.length;
    if (rawBytes > MAX_DSH_RAW_BYTES) throw new ApiError(409, "dsh_session_too_large", "Decompressed DSH session exceeds preview bound.");
    const lines = (carry + decoder.write(info.buffer)).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) visit(line);
  }
  const tail = carry + decoder.end();
  if (tail.trim()) visit(tail);
}

export function previewDshSession(
  dshHome: string,
  opts: { relativePath: string; sessionId: string },
): AgentArtifactPreview {
  const file = safeFile(dshHome, opts.relativePath, "sessions/");
  let sessionId: string | null = null;
  let createdAt: string | null = null;
  const parts: string[] = [];
  let chars = 0;
  let safeItemCount = 0;
  let lastSeq: number | null = null;
  let lastSafeAt: string | null = null;
  eachDshLine(file, (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new ApiError(409, "dsh_session_invalid", "DSH session contains invalid JSONL."); }
    const root = obj(parsed);
    if (!root) return;
    if (typeof root.seq === "number" && Number.isInteger(root.seq)) lastSeq = lastSeq === null ? root.seq : Math.max(lastSeq, root.seq);
    if (root.type === "session") {
      const nested = obj(root.data);
      const data = nested ?? root;
      sessionId = str(data.id) ?? str(root.id);
      createdAt = epochIso(data.createdAt) ?? epochIso(root.createdAt);
      return;
    }
    const data = obj(root.data);
    if (!data) return;
    let role: "user" | "assistant" | null = null;
    let content: unknown = null;
    if (root.type === "user/message") { role = "user"; content = data.content; }
    else if (root.type === "assistant/message") { role = "assistant"; content = obj(data.message)?.content; }
    else return;
    if (!role || !Array.isArray(content)) return;
    const texts = content.map(obj)
      .filter((item): item is Record<string, unknown> => item !== null && item.type === "text")
      .map((item) => str(item.text)).filter((text): text is string => text !== null);
    if (!texts.length) return;
    const rendered = `${role === "user" ? "User" : "Assistant"}:\n${texts.join("\n")}`;
    chars += rendered.length + 2;
    if (chars > MAX_TEXT_CHARS) throw new ApiError(409, "dsh_session_too_large", "Safe DSH text exceeds sync preview bound.");
    parts.push(rendered);
    safeItemCount += 1;
    lastSafeAt = epochIso(root.time) ?? lastSafeAt;
  });
  if (!sessionId || sessionId !== opts.sessionId) throw new ApiError(409, "dsh_session_identity_mismatch", "DSH session id mismatch.");
  if (!safeItemCount) throw new ApiError(409, "dsh_session_no_safe_text", "DSH session has no eligible user-visible text.");
  const redacted = redactCredentialLikeText(parts.join("\n\n"));
  const stat = fs.statSync(file);
  const hash = sha256(redacted.text);
  return {
    connector: "dsh",
    kind: "session",
    externalId: opts.sessionId,
    externalPart: `snapshot:${hash}`,
    externalRevision: lastSeq === null ? null : String(lastSeq),
    archiveState: "unknown",
    externalUpdatedAt: stat.mtime.toISOString(),
    eventAt: lastSafeAt ?? createdAt ?? stat.mtime.toISOString(),
    authorLabel: "dsh",
    text: redacted.text,
    safeItemCount,
    safeCharCount: redacted.text.length,
    redactionCount: redacted.redactionCount,
  };
}

function allowedDshMemory(relativePath: string): boolean {
  return ROOT_DSH_MEMORY_ALLOWLIST.has(relativePath) || /^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(relativePath);
}

export function previewDshMemory(dshHome: string, relativePathInput: string): AgentArtifactPreview {
  const relativePath = relativePathInput.replaceAll("\\", "/");
  if (!allowedDshMemory(relativePath) || path.posix.normalize(relativePath) !== relativePath) {
    throw new ApiError(400, "dsh_memory_invalid_path", "DSH memory path is outside the allowlist.");
  }
  const file = safeFile(dshHome, `memory/${relativePath}`, "memory/");
  const stat = fs.statSync(file);
  if (stat.size > MAX_TEXT_CHARS * 4) throw new ApiError(409, "dsh_memory_too_large", "DSH memory exceeds preview bound.");
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length > MAX_TEXT_CHARS) throw new ApiError(409, "dsh_memory_too_large", "DSH memory exceeds preview bound.");
  const redacted = redactCredentialLikeText(raw);
  const hash = sha256(redacted.text);
  const updated = stat.mtime.toISOString();
  return {
    connector: "dsh",
    kind: "memory",
    externalId: `memory:${relativePath}`,
    externalPart: `snapshot:${hash}`,
    externalRevision: String(Math.trunc(stat.mtimeMs)),
    archiveState: "unknown",
    externalUpdatedAt: updated,
    eventAt: updated,
    authorLabel: "dsh-memory",
    text: redacted.text,
    safeItemCount: 1,
    safeCharCount: redacted.text.length,
    redactionCount: redacted.redactionCount,
  };
}
