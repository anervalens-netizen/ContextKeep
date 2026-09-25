import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { nowIso } from "../lib/time.js";
import type { DbHandle } from "./client.js";
import { SERVER_SCHEMA_VERSION } from "./schema-version.js";

export const APP_VERSION = "0.1.0";

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/drizzle — same relative depth from src/db and dist/db. */
export const migrationsFolder = path.resolve(here, "../../drizzle");

/** A17: refuse to start when the store was produced by a newer schema version. */
export class SchemaVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Refusing to start: this data store has schema version ${found}, newer than this build supports (${supported}). ` +
        `Update ContextKeep before starting against this data directory (A17).`,
    );
    this.name = "SchemaVersionError";
  }
}

export function checkSchemaVersion(handle: DbHandle): void {
  const { sqlite } = handle;
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!table) return; // fresh store — migrations will create it
  const row = sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  if (row && row.v !== null && row.v > SERVER_SCHEMA_VERSION) {
    throw new SchemaVersionError(row.v, SERVER_SCHEMA_VERSION);
  }
}

/** Runs inside startup/migrate: A17 check, then Drizzle migrations, then version stamp. */
export function bootstrapDatabase(handle: DbHandle): void {
  checkSchemaVersion(handle);
  migrate(handle.db, { migrationsFolder });
  handle.sqlite
    .prepare(
      `INSERT INTO schema_version (version, applied_at, app_version) VALUES (?, ?, ?)
       ON CONFLICT(version) DO UPDATE SET applied_at = excluded.applied_at, app_version = excluded.app_version`,
    )
    .run(SERVER_SCHEMA_VERSION, nowIso(), APP_VERSION);
}
