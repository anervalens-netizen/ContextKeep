import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { bootstrapDatabase, SchemaVersionError } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { SERVER_SCHEMA_VERSION } from "../src/db/schema-version.js";
import { APP_SCHEMA_VERSION as SHARED_SCHEMA_VERSION } from "@contextkeep/shared";

function testConfig(dataDir: string) {
  return loadConfig(
    { NODE_ENV: "test", CK_DATA_DIR: dataDir, CK_SESSION_SECRET: "bootstrap-test-secret" },
    {},
  );
}

describe("A17: startup refuses a newer-version store", () => {
  it("boots a fresh store and stamps schema_version", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-a17-"));
    try {
      const config = testConfig(dataDir);
      const handle = openDatabase(config.dbPath);
      bootstrapDatabase(handle);
      const row = handle.sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(row.v).toBe(SERVER_SCHEMA_VERSION);
      const retiredTables = ["agent_events", "agent_session_items", "agent_codex_threads", "agent_runs", "agent_threads"];
      const present = handle.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?, ?, ?) ORDER BY name")
        .all(...retiredTables) as { name: string }[];
      expect(present).toEqual([]);
      handle.sqlite.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("server schema authority is v16 and the shared mirror stays in parity", () => {
    expect(SERVER_SCHEMA_VERSION).toBe(16);
    expect(SHARED_SCHEMA_VERSION).toBe(SERVER_SCHEMA_VERSION);
  });

  it("refuses to start when schema_version is newer than the server build supports", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-a17-"));
    try {
      const config = testConfig(dataDir);
      const handle = openDatabase(config.dbPath);
      bootstrapDatabase(handle);
      handle.sqlite
        .prepare("INSERT INTO schema_version (version, applied_at, app_version) VALUES (?, ?, ?)")
        .run(SERVER_SCHEMA_VERSION + 998, new Date().toISOString(), "99.0.0");
      handle.sqlite.close();

      let caught: unknown = null;
      try {
        const app = await buildApp({ config, logger: false });
        await app.close();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SchemaVersionError);
      expect((caught as SchemaVersionError).message).toMatch(/refusing to start/i);
      expect((caught as SchemaVersionError).message).toMatch(/A17/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("still starts when schema_version equals the supported version", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ck-a17-"));
    try {
      const config = testConfig(dataDir);
      const handle = openDatabase(config.dbPath);
      bootstrapDatabase(handle);
      handle.sqlite.close();
      const app = await buildApp({ config, logger: false });
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      await app.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
