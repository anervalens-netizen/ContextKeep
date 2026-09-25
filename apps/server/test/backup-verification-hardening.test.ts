import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { createBackup, verifyBackup } from "../src/services/backup.js";
import { makeTestApp } from "./helpers.js";

function captureApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected ApiError");
}

describe("F12: backup verification hardening", () => {
  it("rejects a SQLite-integrity-clean backup that contains orphaned foreign keys", async () => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 10, { actor: "test:f12" });
      const broken = path.join(dir, "orphan.sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO source_excerpts
             (id, source_id, start_offset, end_offset, exact_text, exact_text_hash)
           VALUES (?, ?, 0, 1, 'x', 'orphan-hash')`,
        ).run("orphan-excerpt", "missing-source");
        const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
        expect(integrity).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_foreign_key_invalid");
    } finally {
      await t.cleanup();
    }
  });

  it("rejects a current-schema backup that is missing a version-required column", async () => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 10, { actor: "test:f12" });
      const broken = path.join(dir, "missing-content-version.sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE projects_without_content_version AS
            SELECT id,name,aliases_json,parent_project_id,description,lifecycle,lifecycle_record_id,revision,created_at,updated_at
            FROM projects;
          DROP TABLE projects;
          ALTER TABLE projects_without_content_version RENAME TO projects;
        `);
        const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
        expect(integrity).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toMatch(/projects.*content_version/i);
    } finally {
      await t.cleanup();
    }
  });

  it("rejects a v16 backup that still contains a retired table", async () => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 10, { actor: "test:mcf05" });
      const broken = path.join(dir, "retired-table-present.sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec("CREATE TABLE agent_threads (id TEXT PRIMARY KEY)");
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toMatch(/retired table.*agent_threads/i);
    } finally {
      await t.cleanup();
    }
  });

  it("keeps v15 backups strict about the historical runtime tables", async () => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 10, { actor: "test:mcf05" });
      const broken = path.join(dir, "missing-agent-events-v15.sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec(`
          CREATE TABLE agent_threads (id TEXT PRIMARY KEY);
          CREATE TABLE agent_session_items (id INTEGER PRIMARY KEY);
          CREATE TABLE agent_runs (id TEXT PRIMARY KEY);
          CREATE TABLE agent_codex_threads (agent_thread_id TEXT PRIMARY KEY);
          DELETE FROM schema_version;
          INSERT INTO schema_version(version, applied_at, app_version)
          VALUES (15, '2026-09-22T00:00:00.000Z', 'historical-test');
        `);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toMatch(/agent_events/);
    } finally {
      await t.cleanup();
    }
  });

  it.each([
    ["table", "context_cursor_snapshots", "DROP TABLE context_cursor_snapshots"],
    ["table", "context_delta_sessions", "DROP TABLE context_delta_sessions"],
    ["table", "ck_records_fts", "DROP TABLE ck_records_fts"],
    ["index", "ix_context_cursor_snapshots_project_scope", "DROP INDEX ix_context_cursor_snapshots_project_scope"],
    ["index", "ix_context_delta_sessions_project", "DROP INDEX ix_context_delta_sessions_project"],
    ["index", "uq_context_delta_sessions_request", "DROP INDEX uq_context_delta_sessions_request"],
    ["trigger", "trg_records_fts_ai", "DROP TRIGGER trg_records_fts_ai"],
    ["trigger", "trg_records_fts_au", "DROP TRIGGER trg_records_fts_au"],
    ["trigger", "trg_records_fts_ad", "DROP TRIGGER trg_records_fts_ad"],
  ] as const)("rejects current-schema backup missing required %s %s", async (_kind, name, ddl) => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 20, { actor: "test:mcf01" });
      const broken = path.join(dir, "missing-" + name + ".sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec(ddl);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toContain(name);
    } finally {
      await t.cleanup();
    }
  });

  it.each([
    ["context_cursor_snapshots", "baseline"],
    ["context_delta_sessions", "project_json"],
  ] as const)("rejects current-schema backup missing required %s.%s column", async (table, column) => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 20, { actor: "test:mcf01" });
      const broken = path.join(dir, "missing-" + table + "-" + column + ".sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec("ALTER TABLE " + table + " DROP COLUMN " + column);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toContain(table);
      expect(error.message).toContain(column);
    } finally {
      await t.cleanup();
    }
  });

  it("keeps version-3 backups strict about source_origins", async () => {
    const t = await makeTestApp();
    try {
      const dir = path.join(t.dataDir, "verification-backups");
      const source = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 10, { actor: "test:f12" });
      const broken = path.join(dir, "missing-source-origins-v3.sqlite");
      fs.copyFileSync(source.file, broken);

      const db = new Database(broken);
      try {
        db.exec("PRAGMA foreign_keys = OFF; DROP TABLE source_origins; DELETE FROM schema_version; INSERT INTO schema_version(version, applied_at, app_version) VALUES (3, '2026-09-20T00:00:00.000Z', 'test');");
        const integrity = db.pragma("integrity_check") as { integrity_check: string }[];
        expect(integrity).toEqual([{ integrity_check: "ok" }]);
      } finally {
        db.close();
      }

      const error = captureApiError(() => verifyBackup(broken));
      expect(error.code).toBe("backup_invalid_schema");
      expect(error.message).toMatch(/source_origins/);
    } finally {
      await t.cleanup();
    }
  });
});
