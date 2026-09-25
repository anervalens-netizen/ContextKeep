import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { verifyBackup } from "../src/services/backup.js";

describe("A02 preserves the existing online backup CLI", () => {
  it("snapshots a live managed database without requiring its writer to stop", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "ck-live-backup-audit-"),
    );
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    const handle = openDatabase(path.join(data, "store.sqlite"));
    try {
      bootstrapDatabase(handle);
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx/esm", "src/cli/backup.ts"],
        {
          cwd: path.resolve("."),
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            NODE_ENV: "test",
            CK_DATA_DIR: data,
            CK_BACKUP_DIR: backups,
            CK_ADAPTERS: "manual",
            CK_SESSION_SECRET: "isolated-live-backup-fixture",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(output).toContain("backup written:");
      const files = fs
        .readdirSync(backups)
        .filter((name) => name.endsWith(".sqlite"));
      expect(files).toHaveLength(1);
      expect(verifyBackup(path.join(backups, files[0]!)).ok).toBe(true);
      expect(handle.sqlite.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      handle.sqlite.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
