import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DbHandle } from "../db/client.js";
import { acquireDirectoryLock, assertNoLegacyDatabaseHandles, isDirectoryLockFile } from "../db/directory-lock.js";
import { SchemaVersionError } from "../db/bootstrap.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";
import { ApiError } from "../lib/errors.js";
import { nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

export interface BackupSummary {
  file: string;
  sizeBytes: number;
  counts: TableCounts;
  createdAt: string;
  verifiedAt: string;
  schemaVersion: number;
  manifestFile: string;
}

export interface BackupManifest {
  version: 1;
  fileName: string;
  attemptedAt: string;
  completedAt: string;
  verifiedAt: string;
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
  counts: TableCounts;
}

export interface TableCounts {
  projects: number;
  sources: number;
  records: number;
  supersessions: number;
  auditEvents: number;
}

const BASE_TABLES = [
  "schema_version",
  "projects",
  "sources",
  "source_excerpts",
  "records",
  "record_evidence",
  "import_jobs",
  "supersessions",
  "conflicts",
  "handoffs",
  "audit_events",
  "owner_credentials",
  "sessions",
] as const;

function requiredTablesForVersion(schemaVersion: number): string[] {
  const required = [...BASE_TABLES] as string[];
  if (schemaVersion >= 3) required.push("workspace_bindings");
  if (schemaVersion >= 3) required.push("source_origins");
  if (schemaVersion >= 5) required.push("source_extractions", "connector_sync_state");
  if (schemaVersion >= 6 && schemaVersion < 16) required.push("agent_threads", "agent_session_items", "agent_runs", "agent_events");
  if (schemaVersion >= 7 && schemaVersion < 16) required.push("agent_codex_threads");
  if (schemaVersion >= 8) required.push("idempotency_requests");
  if (schemaVersion >= 11) required.push("sync_jobs");
  if (schemaVersion >= 14) required.push("ck_records_fts");
  if (schemaVersion >= 15) required.push("context_cursor_snapshots", "context_delta_sessions");
  return required;
}

function assertRequiredNamedObjects(
  db: Database.Database,
  type: "index" | "trigger",
  names: string[],
  schemaVersion: number,
): void {
  if (names.length === 0) return;
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  const missing = names.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new ApiError(
      409,
      "backup_invalid_schema",
      "Backup declares schema version " + schemaVersion + " but is missing required " + type + "(s): " + missing.join(", ") + ".",
      { schemaVersion, objectType: type, missingObjects: missing },
    );
  }
}

function assertRequiredColumns(db: Database.Database, table: string, columns: string[], schemaVersion: number): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
  const missingColumns = columns.filter((column) => !existing.has(column));
  if (missingColumns.length > 0) {
    throw new ApiError(
      409,
      "backup_invalid_schema",
      `Backup declares schema version ${schemaVersion} but ${table} is missing required column(s): ${missingColumns.join(", ")}.`,
      { schemaVersion, table, missingColumns },
    );
  }
}

function assertVersionedSchemaShape(db: Database.Database, schemaVersion: number): void {
  const existing = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((row) => row.name),
  );
  const missing = requiredTablesForVersion(schemaVersion).filter((table) => !existing.has(table));
  if (missing.length > 0) {
    throw new ApiError(
      409,
      "backup_invalid_schema",
      `Backup declares schema version ${schemaVersion} but is missing required table(s): ${missing.join(", ")}.`,
      { schemaVersion, missingTables: missing },
    );
  }

  if (schemaVersion >= 16) {
    const retiredTables = ["agent_events", "agent_session_items", "agent_codex_threads", "agent_runs", "agent_threads"];
    const presentRetiredTables = retiredTables.filter((table) => existing.has(table));
    if (presentRetiredTables.length > 0) {
      throw new ApiError(
        409,
        "backup_invalid_schema",
        `Backup declares schema version ${schemaVersion} but still contains retired table(s): ${presentRetiredTables.join(", ")}.`,
        { schemaVersion, presentRetiredTables },
      );
    }
  }

  if (schemaVersion >= 2) assertRequiredColumns(db, "records", ["volatile", "review_due_at"], schemaVersion);
  if (schemaVersion >= 9) assertRequiredColumns(db, "projects", ["content_version"], schemaVersion);
  if (schemaVersion >= 12) assertRequiredColumns(db, "projects", ["working_memory_version"], schemaVersion);
  if (schemaVersion >= 10) assertRequiredColumns(db, "handoffs", ["source_content_version"], schemaVersion);
  if (schemaVersion >= 11) {
    assertRequiredColumns(
      db,
      "sync_jobs",
      ["id", "project_id", "connector", "mode", "input_json", "stage", "selected", "completed", "failed", "current_key", "result_json", "last_error", "started_at", "updated_at", "finished_at"],
      schemaVersion,
    );
  }
  if (schemaVersion >= 14) {
    assertRequiredColumns(
      db,
      "ck_records_fts",
      ["record_id", "project_id", "type", "basis", "review_status", "text", "subject", "predicate", "checkpoint_text"],
      schemaVersion,
    );
    assertRequiredNamedObjects(
      db,
      "trigger",
      ["trg_records_fts_ai", "trg_records_fts_au", "trg_records_fts_ad"],
      schemaVersion,
    );
  }
  if (schemaVersion >= 15) {
    assertRequiredColumns(
      db,
      "context_cursor_snapshots",
      ["project_id", "scope", "cursor", "project_revision", "manifest_json", "baseline", "created_at"],
      schemaVersion,
    );
    assertRequiredColumns(
      db,
      "context_delta_sessions",
      ["id", "project_id", "from_canonical_cursor", "from_working_cursor", "from_project_revision", "target_canonical_cursor", "target_working_cursor", "target_project_revision", "request_key", "changes_json", "project_json", "created_at"],
      schemaVersion,
    );
    assertRequiredNamedObjects(
      db,
      "index",
      ["ix_context_cursor_snapshots_project_scope", "ix_context_delta_sessions_project", "uq_context_delta_sessions_request"],
      schemaVersion,
    );
  }
}

function assertForeignKeys(db: Database.Database): void {
  let violations: unknown[];
  try {
    violations = db.pragma("foreign_key_check") as unknown[];
  } catch (error) {
    throw new ApiError(
      409,
      "backup_invalid_schema",
      "Backup foreign-key structure could not be validated.",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (violations.length > 0) {
    throw new ApiError(
      409,
      "backup_foreign_key_invalid",
      `Backup contains ${violations.length} foreign-key violation(s).`,
      { violations: violations.slice(0, 20) },
    );
  }
}

function backupFilename(now = new Date()): string {
  return `store-${now.toISOString().replace(/[:.]/g, "-")}.sqlite`;
}

/**
 * Backup (M0 scope 8): consistent SQLite online backup (WAL-safe) into the
 * owner-chosen local directory, rotated to CK_BACKUP_KEEP files. Nothing
 * leaves the host (handoff §11).
 *
 * IMPORTANT: schema migration is NOT part of backup. Callers may verify schema
 * compatibility, but the snapshot operation itself must never migrate/stamp
 * the source store.
 */
export async function createBackup(handle: DbHandle, deps: ServiceDeps, backupDir: string, keep: number, ctx: ActorCtx): Promise<BackupSummary> {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, backupFilename());
  const attemptedAt = nowIso();

  // Attempt is recorded before the snapshot so the snapshot can contain the
  // fact that backup work started. It deliberately does not claim success.
  writeAudit(deps.db, {
    actor: ctx.actor,
    action: "backup.attempted",
    targetType: "store",
    targetId: file,
    after: { file, attemptedAt },
    requestId: ctx.requestId ?? null,
  });

  try {
    await handle.sqlite.backup(file);
    const verification = verifyBackup(file);
    const sizeBytes = fs.statSync(file).size;
    const sha256 = fileSha256(file);
    const completedAt = nowIso();
    const verifiedAt = completedAt;
    const manifest: BackupManifest = {
      version: 1,
      fileName: path.basename(file),
      attemptedAt,
      completedAt,
      verifiedAt,
      schemaVersion: verification.schemaVersion,
      sizeBytes,
      sha256,
      counts: verification.counts,
    };
    writeJsonAtomic(manifestPath(file), manifest);

    // Rotate only after a verified snapshot + manifest exists. A failed new
    // attempt can never evict the previously useful backup.
    rotate(backupDir, keep, file);
    writeAudit(deps.db, {
      actor: ctx.actor,
      action: "backup.completed",
      targetType: "store",
      targetId: file,
      after: { file, completedAt, verifiedAt, schemaVersion: verification.schemaVersion, sizeBytes },
      requestId: ctx.requestId ?? null,
    });
    return {
      file,
      sizeBytes,
      counts: verification.counts,
      createdAt: completedAt,
      verifiedAt,
      schemaVersion: verification.schemaVersion,
      manifestFile: manifestPath(file),
    };
  } catch (error) {
    // A partial file is renamed outside the rotating namespace so age-based
    // freshness can never mistake it for a usable backup.
    if (fs.existsSync(file)) {
      try { fs.renameSync(file, `${file}.failed`); } catch { /* best effort; no manifest means unverified */ }
    }
    writeAudit(deps.db, {
      actor: ctx.actor,
      action: "backup.failed",
      targetType: "store",
      targetId: file,
      detail: { message: error instanceof Error ? error.message : "Backup failed." },
      requestId: ctx.requestId ?? null,
    });
    throw error;
  }
}

const ROTATING_BACKUP_NAME = /^store-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;

function fileSha256(file: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let position = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function manifestPath(file: string): string {
  return `${file}.meta.json`;
}

function restoreMarkerPath(file: string): string {
  return `${file}.restore.json`;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readManifest(file: string): BackupManifest | null {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath(file), "utf8")) as Partial<BackupManifest>;
    if (
      value.version !== 1 ||
      value.fileName !== path.basename(file) ||
      typeof value.attemptedAt !== "string" ||
      typeof value.completedAt !== "string" ||
      typeof value.verifiedAt !== "string" ||
      typeof value.schemaVersion !== "number" ||
      typeof value.sizeBytes !== "number" ||
      typeof value.sha256 !== "string" ||
      !value.counts
    ) return null;
    return value as BackupManifest;
  } catch {
    return null;
  }
}

type BackupVerificationCacheEntry = {
  identity: string;
  status: "verified" | "changed_or_invalid";
};

const backupVerificationCache = new Map<string, BackupVerificationCacheEntry>();

function statIdentity(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function cachedVerificationStatus(
  file: string,
  fileStat: fs.Stats,
  manifest: BackupManifest,
): BackupVerificationCacheEntry["status"] {
  let manifestStat: fs.Stats;
  try {
    manifestStat = fs.statSync(manifestPath(file));
  } catch {
    backupVerificationCache.delete(file);
    return "changed_or_invalid";
  }
  const identity = [statIdentity(fileStat), statIdentity(manifestStat), manifest.sha256].join("|");
  const cached = backupVerificationCache.get(file);
  if (cached?.identity === identity) return cached.status;

  let status: BackupVerificationCacheEntry["status"] = "changed_or_invalid";
  try {
    status = fileSha256(file) === manifest.sha256 ? "verified" : "changed_or_invalid";
  } catch {
    status = "changed_or_invalid";
  }
  backupVerificationCache.set(file, { identity, status });
  return status;
}

function readRestoreMarker(file: string): { restoredAt: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(restoreMarkerPath(file), "utf8")) as { restoredAt?: unknown };
    return typeof value.restoredAt === "string" ? { restoredAt: value.restoredAt } : null;
  } catch {
    return null;
  }
}

export interface BackupFreshnessStatus {
  /** Age only. A fresh file is not necessarily verified. */
  status: "fresh" | "stale" | "missing";
  latestCreatedAt: string | null;
  ageSeconds: number | null;
  rotatingCount: number;
  staleAfterHours: number;
  latestFile: string | null;
  manifestPresent: boolean;
  verificationStatus: "verified" | "unknown" | "changed_or_invalid";
  latestVerifiedAt: string | null;
  latestBackupRestoreTestedAt: string | null;
  lastRestoreTestedAt: string | null;
}

function missingFreshness(staleAfterHours: number): BackupFreshnessStatus {
  return {
    status: "missing",
    latestCreatedAt: null,
    ageSeconds: null,
    rotatingCount: 0,
    staleAfterHours,
    latestFile: null,
    manifestPresent: false,
    verificationStatus: "unknown",
    latestVerifiedAt: null,
    latestBackupRestoreTestedAt: null,
    lastRestoreTestedAt: null,
  };
}

export function backupFreshnessStatus(
  backupDir: string,
  nowMs = Date.now(),
  staleAfterHours = 36,
): BackupFreshnessStatus {
  let names: string[] = [];
  try {
    names = fs.readdirSync(backupDir).filter((name) => ROTATING_BACKUP_NAME.test(name));
  } catch {
    return missingFreshness(staleAfterHours);
  }
  const candidates = names
    .map((name) => {
      const file = path.join(backupDir, name);
      try { return { name, file, stat: fs.statSync(file) }; } catch { return null; }
    })
    .filter((entry): entry is { name: string; file: string; stat: fs.Stats } => entry !== null)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = candidates[0];
  if (!latest) return missingFreshness(staleAfterHours);

  const backupRoot = path.resolve(backupDir);
  const currentRotatingFiles = new Set(candidates.map((entry) => path.resolve(entry.file)));
  for (const cachedFile of backupVerificationCache.keys()) {
    if (path.dirname(path.resolve(cachedFile)) === backupRoot && !currentRotatingFiles.has(path.resolve(cachedFile))) {
      backupVerificationCache.delete(cachedFile);
    }
  }

  const manifestFileExists = fs.existsSync(manifestPath(latest.file));
  const manifest = readManifest(latest.file);
  let verificationStatus: BackupFreshnessStatus["verificationStatus"] = "unknown";
  if (manifestFileExists) {
    if (!manifest || manifest.sizeBytes !== latest.stat.size) {
      backupVerificationCache.delete(latest.file);
      verificationStatus = "changed_or_invalid";
    } else {
      verificationStatus = cachedVerificationStatus(latest.file, latest.stat, manifest);
    }
  } else {
    backupVerificationCache.delete(latest.file);
  }
  const createdAt = manifest?.completedAt ?? new Date(latest.stat.mtimeMs).toISOString();
  const createdMs = Date.parse(createdAt);
  const ageSeconds = Math.max(0, Math.floor((nowMs - (Number.isFinite(createdMs) ? createdMs : latest.stat.mtimeMs)) / 1000));
  const latestRestore = readRestoreMarker(latest.file);
  const allRestoreTimes = candidates
    .map((entry) => readRestoreMarker(entry.file)?.restoredAt ?? null)
    .filter((value): value is string => value !== null)
    .sort()
    .reverse();

  return {
    status: ageSeconds > staleAfterHours * 3600 ? "stale" : "fresh",
    latestCreatedAt: createdAt,
    ageSeconds,
    rotatingCount: candidates.length,
    staleAfterHours,
    latestFile: latest.name,
    manifestPresent: manifestFileExists,
    verificationStatus,
    latestVerifiedAt: verificationStatus === "verified" ? manifest?.verifiedAt ?? null : null,
    latestBackupRestoreTestedAt: latestRestore?.restoredAt ?? null,
    lastRestoreTestedAt: allRestoreTimes[0] ?? null,
  };
}

function rotate(backupDir: string, keep: number, protectedFile?: string): void {
  const protectedName = protectedFile ? path.basename(protectedFile) : null;
  const files = fs
    .readdirSync(backupDir)
    // Named operator checkpoints are intentionally outside automated rotation.
    // Only files produced by backupFilename() participate in CK_BACKUP_KEEP.
    .filter((f) => ROTATING_BACKUP_NAME.test(f))
    .sort()
    .reverse();
  const keepSet = new Set(files.slice(0, keep));
  if (protectedName && ROTATING_BACKUP_NAME.test(protectedName)) keepSet.add(protectedName);
  for (const old of files) {
    if (keepSet.has(old)) continue;
    const file = path.join(backupDir, old);
    fs.rmSync(file, { force: true });
    fs.rmSync(manifestPath(file), { force: true });
    fs.rmSync(restoreMarkerPath(file), { force: true });
  }
}

export function countTables(file: string): TableCounts {
  const db = new Database(file, { readonly: true });
  try {
    const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      projects: count("projects"),
      sources: count("sources"),
      records: count("records"),
      supersessions: count("supersessions"),
      auditEvents: count("audit_events"),
    };
  } finally {
    db.close();
  }
}

/**
 * Verify a backup file before restore:
 * - SQLite page/index integrity;
 * - A17 schema-version compatibility;
 * - version-appropriate ContextKeep table/column shape;
 * - referential integrity across declared foreign keys;
 * - core table readability/counts.
 */
export function verifyBackup(file: string): { ok: true; schemaVersion: number; counts: TableCounts } {
  if (!fs.existsSync(file)) throw new ApiError(404, "backup_not_found", `Backup file not found: ${file}`);
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true });
  } catch {
    throw new ApiError(409, "backup_corrupt", "Backup file is not a readable SQLite database.");
  }
  try {
    let integrity: { integrity_check: string }[];
    try {
      integrity = db.pragma("integrity_check") as { integrity_check: string }[];
    } catch {
      throw new ApiError(409, "backup_corrupt", "Backup file is not a readable SQLite database.");
    }
    const ok = integrity.length === 1 && integrity[0]?.integrity_check === "ok";
    if (!ok) throw new ApiError(409, "backup_corrupt", `Backup failed integrity_check: ${JSON.stringify(integrity)}`);

    let schemaVersion: number;
    try {
      const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
      schemaVersion = row?.v ?? 0;
    } catch {
      throw new ApiError(409, "backup_invalid", "Backup is not a ContextKeep store (schema_version table missing).");
    }
    if (schemaVersion > SERVER_SCHEMA_VERSION) {
      throw new SchemaVersionError(schemaVersion, SERVER_SCHEMA_VERSION);
    }

    assertVersionedSchemaShape(db, schemaVersion);
    assertForeignKeys(db);

    let counts: TableCounts;
    try {
      counts = countTables(file);
    } catch {
      throw new ApiError(409, "backup_invalid", "Backup is missing or cannot read required ContextKeep core tables.");
    }
    return { ok: true, schemaVersion, counts };
  } finally {
    db.close();
  }
}

export interface RestoreOptions {
  dataDir: string;
  backupFile: string;
  /** When true, existing store files are deleted instead of moved to .trash-<ts>. */
  hardWipe?: boolean;
  ctx: ActorCtx;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Restore (M0 scope 8, A8): verify the backup first (integrity + A17), then
 * stage and verify the audited replacement before moving old data to trash.
 * Roll back promotion failures; hardWipe only applies after verified success.
 * Directory ownership is held through staging, promotion, verification and cleanup.
 * The CLI acknowledgement is not evidence that SQLite has been closed.
 */
export function restoreBackup(opts: RestoreOptions): { restored: string; trashDir: string | null; counts: TableCounts } {
  const verification = verifyBackup(opts.backupFile);
  fs.mkdirSync(opts.dataDir, { recursive: true });

  // Refuse destructive overlap before enumerating or moving any victim. realpath
  // resolves symlinks so a backup symlinked into dataDir cannot bypass the guard.
  const canonicalDataDir = fs.realpathSync(opts.dataDir);
  const canonicalBackupFile = fs.realpathSync(opts.backupFile);
  if (isPathInside(canonicalDataDir, canonicalBackupFile)) {
    throw new ApiError(
      409,
      "backup_inside_data_dir",
      "Restore refused: the backup file is inside the data directory that would be wiped. Move or copy the backup outside dataDir first.",
    );
  }

  const lease = acquireDirectoryLock(canonicalDataDir);
  try {
    return restoreLocked({ ...opts, dataDir: canonicalDataDir }, canonicalBackupFile, verification);
  } finally {
    lease.release();
  }
}

function restoreLocked(
  opts: RestoreOptions,
  canonicalBackupFile: string,
  verification: ReturnType<typeof verifyBackup>,
): { restored: string; trashDir: string | null; counts: TableCounts } {
  const storePath = path.join(opts.dataDir, "store.sqlite");
  const storeStat = fs.lstatSync(storePath, { throwIfNoEntry: false });
  if (storeStat?.isSymbolicLink() || (storeStat && storeStat.nlink !== 1)) {
    throw new ApiError(409, "restore_aliased_store", "Restore requires a regular, non-hard-linked store.sqlite; use its actual data directory.");
  }
  // Older binaries do not own our cooperative lock. Check observable open
  // descriptors as an additional safeguard, including a checkpointed-empty WAL.
  const legacyInspection = assertNoLegacyDatabaseHandles(storePath);
  for (const file of [canonicalBackupFile, storePath]) {
    const wal = `${file}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      throw new ApiError(409, "restore_wal_present", "Stop the service and checkpoint/close SQLite before restore; a nonempty WAL must not be discarded.");
    }
  }
  // Prepare beside the destination so promotion is an atomic same-filesystem rename.
  // The existing store is untouched until the staged bytes have passed verification.
  const stageDir = fs.mkdtempSync(path.join(opts.dataDir, ".restore-stage-"));
  const stagedPath = path.join(stageDir, "store.sqlite");
  let trashDir: string | null = null;
  let promoted = false;
  const moved: string[] = [];
  try {
    fs.copyFileSync(canonicalBackupFile, stagedPath, fs.constants.COPYFILE_EXCL);
    verification = verifyBackup(stagedPath);
    // Prove the restored store opens and audit the restore inside it.
    const restoredAt = nowIso();
    const db = new Database(stagedPath);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
      if (!(integrity.length === 1 && integrity[0]?.integrity_check === "ok")) {
        throw new ApiError(500, "restore_failed_integrity", "Restored store failed integrity_check.");
      }
      db.prepare(
        `INSERT INTO audit_events (id, actor, action, target_type, target_id, timestamp, before_ref, after_ref, detail_json, request_id)
         VALUES (?, ?, 'restore.performed', 'store', ?, ?, NULL, ?, ?, ?)`,
      ).run(
        crypto.randomUUID(),
        opts.ctx.actor,
        storePath,
        restoredAt,
        JSON.stringify({ counts: verification.counts }),
        JSON.stringify({ backupFile: canonicalBackupFile, schemaVersion: verification.schemaVersion, legacyInspection }),
        opts.ctx.requestId ?? null,
      );
    } finally {
      db.close();
    }
    verifyBackup(stagedPath);
    const fd = fs.openSync(stagedPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const victims = fs.readdirSync(opts.dataDir).filter(
      (f) => !f.startsWith(".trash-") && f !== path.basename(stageDir) && !isDirectoryLockFile(f),
    );
    if (victims.length) {
      trashDir = fs.mkdtempSync(path.join(opts.dataDir, ".trash-"));
      for (const file of victims) {
        fs.renameSync(path.join(opts.dataDir, file), path.join(trashDir, file));
        moved.push(file);
      }
    }
    fs.renameSync(stagedPath, storePath);
    promoted = true;
    verifyBackup(storePath);
  } catch (error) {
    if (promoted) fs.renameSync(storePath, stagedPath);
    if (trashDir) {
      for (const file of moved.reverse()) fs.renameSync(path.join(trashDir, file), path.join(opts.dataDir, file));
    }
    throw error;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  // Destructive opt-in applies only after a successful, verified promotion.
  if (opts.hardWipe && trashDir) {
    fs.rmSync(trashDir, { recursive: true, force: true });
    trashDir = null;
  }
  const restoredAt = nowIso();
  // Restore success is a distinct, optional local marker next to the source
  // backup. Failure to persist the marker does not invalidate a completed
  // restore; freshness will truthfully report restore-tested as unknown.
  try {
    writeJsonAtomic(restoreMarkerPath(canonicalBackupFile), {
      version: 1,
      fileName: path.basename(canonicalBackupFile),
      restoredAt,
      schemaVersion: verification.schemaVersion,
      counts: verification.counts,
    });
  } catch {
    // best effort metadata only; restore itself is already proven in the DB
  }
  return { restored: storePath, trashDir, counts: verification.counts };
}
