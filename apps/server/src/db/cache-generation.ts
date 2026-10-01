import type Database from "better-sqlite3";
import type { Db } from "./client.js";

// These epochs are process-local and cannot be restored by a portable dump.
const resetEpochs = new WeakMap<Db, number>();
const readSnapshots = new WeakMap<Db, string>();

/** Call only after the reset transaction/savepoint has succeeded. */
export function advanceDatabaseGeneration(db: Db): void {
  resetEpochs.set(db, (resetEpochs.get(db) ?? 0) + 1);
}

/**
 * Run synchronous, read-only cache work against one SQLite snapshot. The first
 * data_version read pins that snapshot and detects commits by other connections;
 * ordinary writes on this connection still use per-project version keys.
 * Nested reads share our snapshot. Caller-owned transactions (including Drizzle
 * transaction handles) bypass caches, so uncommitted truth is never published.
 */
export function readWithDatabaseGeneration<T>(
  db: Db,
  read: (generation: string | null) => T,
): T {
  const client = (db as Db & { $client?: Database.Database }).$client;
  if (!client) return read(null);
  if (client.inTransaction) return read(readSnapshots.get(db) ?? null);
  return client.transaction(() => {
    const generation = `${resetEpochs.get(db) ?? 0}:${client.pragma("data_version", { simple: true })}`;
    readSnapshots.set(db, generation);
    try {
      return read(generation);
    } finally {
      readSnapshots.delete(db);
    }
  })();
}
