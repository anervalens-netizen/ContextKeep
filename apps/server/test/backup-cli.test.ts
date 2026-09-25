import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { SERVER_SCHEMA_VERSION } from "../src/db/schema-version.js";

describe("M3.4 safety: backup CLI is non-migrating", () => {
  it("backs up an older compatible store without stamping or creating newer schema objects", () => {
    expect(SERVER_SCHEMA_VERSION).toBe(16);
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-backup-cli-data-"));
    const backupDir = mkdtempSync(path.join(tmpdir(), "ck-backup-cli-out-"));
    try {
      const config = loadConfig({
        NODE_ENV: "test",
        CK_DATA_DIR: dataDir,
        CK_BACKUP_DIR: backupDir,
        CK_BACKUP_KEEP: "5",
        CK_ADAPTERS: "manual",
        CK_SESSION_SECRET: "backup-cli-test-secret-0123456789",
      });
      const handle = openDatabase(config.dbPath);
      bootstrapDatabase(handle);
      handle.sqlite.exec("CREATE TABLE agent_threads (id TEXT PRIMARY KEY); CREATE TABLE agent_session_items (id INTEGER PRIMARY KEY); CREATE TABLE agent_runs (id TEXT PRIMARY KEY); CREATE TABLE agent_events (id INTEGER PRIMARY KEY); CREATE TABLE agent_codex_threads (agent_thread_id TEXT PRIMARY KEY);");

      // Reproduce the certification hazard at the current boundary: the
      // Drizzle ledger has already seen v11, while the visible ContextKeep store
      // is rolled back to a valid v10 shape. A backup command must not call
      // migrate/bootstrap and re-stamp the store to v11 while the v11
      // sync_jobs table is absent.
      handle.sqlite.prepare("DELETE FROM schema_version").run();
      handle.sqlite
        .prepare("INSERT INTO schema_version (version, applied_at, app_version) VALUES (15, ?, ?)")
        .run(new Date().toISOString(), "0.1.0");
      const beforeAudit = (handle.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n;
      handle.sqlite.close();

      execFileSync(
        process.execPath,
        ["--import", "tsx/esm", path.resolve("src/cli/backup.ts")],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            NODE_ENV: "test",
            CK_DATA_DIR: dataDir,
            CK_BACKUP_DIR: backupDir,
            CK_BACKUP_KEEP: "5",
            CK_ADAPTERS: "manual",
            CK_SESSION_SECRET: "backup-cli-test-secret-0123456789",
          },
          stdio: "pipe",
        },
      );

      const live = new Database(config.dbPath, { readonly: true });
      try {
        const version = live.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
        expect(version.v).toBe(15);
        const newerTables = live.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_jobs'").all();
        expect(newerTables).toHaveLength(1);
        const afterAudit = (live.prepare("SELECT count(*) AS n FROM audit_events").get() as { n: number }).n;
        expect(afterAudit).toBe(beforeAudit + 2); // attempted + completed; schema mutation is not.
        const backupActions = live.prepare("SELECT action FROM audit_events WHERE action LIKE 'backup.%' ORDER BY timestamp,id").all() as Array<{ action: string }>;
        expect(backupActions.slice(-2).map((row) => row.action)).toEqual(["backup.attempted", "backup.completed"]);
      } finally {
        live.close();
      }

      const backups = readdirSync(backupDir).filter((name) => /^store-.*\.sqlite$/.test(name));
      expect(backups).toHaveLength(1);
      const snapshot = new Database(path.join(backupDir, backups[0]!), { readonly: true });
      try {
        const version = snapshot.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
        expect(version.v).toBe(15);
        const newerTables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_jobs'").all();
        expect(newerTables).toHaveLength(1);
        const backupActions = snapshot.prepare("SELECT action FROM audit_events WHERE action LIKE 'backup.%' ORDER BY timestamp,id").all() as Array<{ action: string }>;
        expect(backupActions.map((row) => row.action)).toContain("backup.attempted");
        expect(backupActions.map((row) => row.action)).not.toContain("backup.completed");
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
