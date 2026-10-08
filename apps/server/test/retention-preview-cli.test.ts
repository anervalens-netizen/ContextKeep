import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openReadOnlyDatabase } from "../src/db/client.js";
import { acquireDirectoryLock } from "../src/db/directory-lock.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-retention-readonly-"));
  dirs.push(dir);
  const file = path.join(dir, "store.sqlite");
  const db = new Database(file);
  db.exec(`CREATE TABLE records (
    id TEXT, revision INTEGER, type TEXT, review_status TEXT, evidence_basis TEXT,
    project_id TEXT, task_status TEXT, predicate TEXT, value_json TEXT, created_at TEXT
  );
  INSERT INTO records VALUES ('synthetic',1,'fact','proposed','agent_report',NULL,NULL,NULL,NULL,'2020-01-01T00:00:00.000Z');`);
  db.close();
  return { dir, file };
}
function cli(file: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "src/cli/housekeeping-preview.ts",
      "--db",
      file,
      "--at",
      "2030-01-01T00:00:00.000Z",
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 15000,
    },
  );
}
describe("Read-only retention preview restore fence", () => {
  it("holds the directory lease until the readonly handle closes", () => {
    const { dir, file } = fixture();
    const db = openReadOnlyDatabase(file);
    try {
      expect(() => db.exec("CREATE TABLE forbidden(value TEXT)")).toThrow(
        /readonly/,
      );
      expect(() => acquireDirectoryLock(dir, false)).toThrow(/in use/);
    } finally {
      db.close();
    }
    const exclusive = acquireDirectoryLock(dir, false);
    exclusive.release();
  });
  it("releases the lease when opening a missing store fails", () => {
    const { dir } = fixture();
    const missing = path.join(dir, "missing.sqlite");
    expect(() => openReadOnlyDatabase(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    const exclusive = acquireDirectoryLock(dir, false);
    exclusive.release();
  });
  it("refuses a preview while another process owns the exclusive restore lease", () => {
    const { dir, file } = fixture();
    const before = fs.readFileSync(file);
    const exclusive = acquireDirectoryLock(dir, false);
    try {
      const result = cli(file);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /directory_in_use|Data directory is in use/,
      );
    } finally {
      exclusive.release();
    }
    expect(fs.readFileSync(file)).toEqual(before);
  });
  it("runs the real CLI without changing the store or its schema", () => {
    const { file } = fixture();
    const before = fs.readFileSync(file);
    const result = cli(file);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).pageSummary.archive).toBe(1);
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
