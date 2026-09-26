import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ApiError } from "../lib/errors.js";

// This inode is permanent. Moving/unlinking it could create two independent locks.
export const DIRECTORY_LOCK_FILE = ".contextkeep-lock.sqlite";
/** Separate from the shared DB/backup lease: one live application per data directory. */
export const RUNTIME_LOCK_FILE = ".contextkeep-runtime.sqlite";

export function isDirectoryLockFile(name: string): boolean {
  return [DIRECTORY_LOCK_FILE, RUNTIME_LOCK_FILE].some((prefix) => [
    prefix,
    `${prefix}-journal`,
    `${prefix}-wal`,
    `${prefix}-shm`,
  ].includes(name));
}

export function canonicalDatabasePath(file: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("Cannot open a dangling database symlink.");
    }
    canonical = path.join(
      fs.realpathSync(path.dirname(file)),
      path.basename(file),
    );
  }
  const stat = fs.statSync(canonical, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    throw new Error(
      "Database paths must refer to regular, non-hard-linked files.",
    );
  }
  return canonical;
}

interface Owner {
  sqlite: Database.Database;
  references: number;
  shared: boolean;
}

const owners = new Map<string, Owner>();

function occupied(directory: string, runtime: boolean): ApiError {
  return new ApiError(
    409,
    runtime ? "runtime_in_use" : "directory_in_use",
    runtime
      ? `A ContextKeep application already owns this data directory: ${directory}.`
      : `Data directory is in use: ${directory}. Close all database handles before restore.`,
  );
}

function acquireSqliteLease(
  directory: string,
  fileName: string,
  shared: boolean,
): { release(): void } {
  fs.mkdirSync(directory, { recursive: true });
  directory = fs.realpathSync(directory);
  const ownerKey = `${fileName}\0${directory}`;
  const runtime = fileName === RUNTIME_LOCK_FILE;
  let owner = owners.get(ownerKey);
  if (owner) {
    if (!shared || !owner.shared) throw occupied(directory, runtime);
    owner.references++;
  } else {
    const file = path.join(directory, fileName);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new Error(
        "The directory lock must be a regular, non-hard-linked file.",
      );
    }
    let sqlite: Database.Database | undefined;
    try {
      sqlite = new Database(file, { timeout: 0 });
      if (
        sqlite.pragma("journal_mode = DELETE", { simple: true }) !== "delete"
      ) {
        throw new Error("Directory lock requires SQLite DELETE journaling.");
      }
      sqlite.exec(
        "CREATE TABLE IF NOT EXISTS directory_lease (id INTEGER PRIMARY KEY);",
      );
      // Pin a SHARED lock for normal handles and online backups. EXCLUSIVE
      // restore cannot overlap any active managed database connection.
      sqlite.exec(
        shared
          ? "BEGIN; SELECT count(*) FROM directory_lease;"
          : "BEGIN EXCLUSIVE;",
      );
      owner = { sqlite, references: 1, shared };
      owners.set(ownerKey, owner);
    } catch (error) {
      if (sqlite?.open) sqlite.close();
      const code = (error as { code?: string }).code;
      if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED"))
        throw occupied(directory, runtime);
      throw error;
    }
  }
  const held = owner;
  let released = false;
  return {
    release() {
      if (released) return;
      if (held.references === 1) {
        held.sqlite.close(); // Releases the pinned transaction; OS also releases it on process death.
        owners.delete(ownerKey);
      } else {
        held.references--;
      }
      released = true;
    },
  };
}

/** Active handles share an OS-backed read lease; restore requires an exclusive lease. */
export function acquireDirectoryLock(
  directory: string,
  shared = false,
): { release(): void } {
  return acquireSqliteLease(directory, DIRECTORY_LOCK_FILE, shared);
}

/** One live application may mutate/recover a data directory at a time. */
export function acquireRuntimeLease(directory: string): { release(): void } {
  return acquireSqliteLease(directory, RUNTIME_LOCK_FILE, false);
}

/** Additional Linux safeguard for older, non-cooperating handles owned by this user.
 * Descriptor enumeration cannot fence a legacy process that opens the DB later.
 * The cooperative lock, not WAL size or this scan, fences updated processes.
 */
export function assertNoLegacyDatabaseHandles(store: string): {
  uninspectableProcesses: number;
} {
  const opaque = new Set<string>();
  const identities = new Set<string>();
  for (const file of [
    store,
    `${store}-wal`,
    `${store}-shm`,
    `${store}-journal`,
  ]) {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat) identities.add(`${stat.dev}:${stat.ino}`);
  }
  if (identities.size === 0) return { uninspectableProcesses: 0 };
  const unavailable = () =>
    new ApiError(
      409,
      "restore_legacy_check_unavailable",
      "Cannot inspect legacy database handles; restore refused before moving data.",
    );
  if (process.platform !== "linux" || !process.getuid) throw unavailable();
  const uid = process.getuid();
  let processes: string[];
  try {
    processes = fs.readdirSync("/proc");
  } catch {
    throw unavailable();
  }
  const disappeared = (error: unknown) =>
    ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
  for (const pid of processes.filter((name) => /^\d+$/.test(name))) {
    const root = `/proc/${pid}`;
    let descriptors: string[];
    try {
      if (fs.statSync(root).uid !== uid) continue;
      descriptors = fs.readdirSync(`${root}/fd`);
    } catch (error) {
      if (disappeared(error)) continue;
      if (
        pid !== String(process.pid) &&
        ["EACCES", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        // Opaque unrelated processes are not evidence of a live ContextKeep writer.
        // The directory lease remains the mandatory exclusion mechanism.
        opaque.add(pid);
        continue;
      }
      throw unavailable();
    }
    for (const descriptor of descriptors) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(`${root}/fd/${descriptor}`);
      } catch (error) {
        if (disappeared(error)) continue;
        if (
          pid !== String(process.pid) &&
          ["EACCES", "EPERM"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          opaque.add(pid);
          continue;
        }
        throw unavailable();
      }
      if (identities.has(`${stat.dev}:${stat.ino}`)) {
        throw new ApiError(
          409,
          "restore_database_open",
          `Process ${pid} has a database file open. Stop it before restore.`,
        );
      }
    }
  }
  return { uninspectableProcesses: opaque.size };
}
