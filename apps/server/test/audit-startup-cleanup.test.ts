import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase } from "../src/db/client.js";
import { acquireDirectoryLock } from "../src/db/directory-lock.js";

describe("A02 startup failure releases all database ownership", () => {
  it("does not keep a directory lease after a future-schema refusal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ck-startup-audit-"));
    const dataDir = path.join(root, "data");
    const handle = openDatabase(path.join(dataDir, "store.sqlite"));
    try {
      bootstrapDatabase(handle);
      handle.sqlite
        .prepare(
          "INSERT INTO schema_version(version, applied_at, app_version) VALUES(999, ?, 'fixture')",
        )
        .run(new Date().toISOString());
      handle.sqlite.close();
      const config = loadConfig({
        NODE_ENV: "test",
        CK_DATA_DIR: dataDir,
        CK_BACKUP_DIR: path.join(root, "backups"),
        CK_ADAPTERS: "manual",
        CK_SYNC_INTERVAL_MINUTES: "0",
        CK_HOUSEKEEPING_INTERVAL_MINUTES: "0",
      });
      await expect(buildApp({ config, logger: false })).rejects.toThrow(/999/);
      const exclusive = acquireDirectoryLock(dataDir);
      exclusive.release();
    } finally {
      if (handle.sqlite.open) handle.sqlite.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
