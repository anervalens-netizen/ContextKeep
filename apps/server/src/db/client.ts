import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import {
  acquireDirectoryLock,
  acquireRuntimeLease,
  canonicalDatabasePath,
} from "./directory-lock.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

/** WAL durability is explicit; production configuration defaults to FULL. */
export function openDatabase(
  dbPath: string,
  synchronous: "NORMAL" | "FULL" = "NORMAL",
  options: { runtime?: boolean } = {},
): DbHandle {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    dbPath = canonicalDatabasePath(dbPath);
  }
  // Handles and online backups share a lease; restore requires exclusive ownership.
  let lease: { release(): void } | undefined;
  let runtimeLease: { release(): void } | undefined;
  let sqlite: Database.Database | undefined;
  try {
    if (dbPath !== ":memory:") {
      if (options.runtime)
        runtimeLease = acquireRuntimeLease(path.dirname(dbPath));
      lease = acquireDirectoryLock(path.dirname(dbPath), true);
    }
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL"); // no-op for :memory:
    sqlite.pragma(`synchronous = ${synchronous}`);
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    const close = sqlite.close.bind(sqlite);
    sqlite.close = () => {
      const result = close();
      // Do not release ownership if closing SQLite throws and leaves it open.
      try {
        lease?.release();
      } finally {
        runtimeLease?.release();
      }
      return result;
    };
    return { db, sqlite };
  } catch (error) {
    try {
      if (sqlite?.open) sqlite.close();
    } finally {
      if (!sqlite?.open) {
        try {
          lease?.release();
        } finally {
          runtimeLease?.release();
        }
      }
    }
    throw error;
  }
}
