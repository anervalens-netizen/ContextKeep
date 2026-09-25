import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { createBackup, restoreBackup } from "../src/services/backup.js";
import { makeTestApp } from "./helpers.js";

describe("restore path safety", () => {
  it("refuses an in-dataDir backup before hard-wipe can remove either store or backup", async () => {
    const t = await makeTestApp();
    try {
      const backupDir = path.join(t.dataDir, "nested-backups");
      const summary = await createBackup(
        t.app.ck.handle,
        t.app.ck.deps,
        backupDir,
        2,
        { actor: "test:restore-safety" },
      );
      const storePath = path.join(t.dataDir, "store.sqlite");
      const storeBefore = fs.readFileSync(storePath);
      const backupBefore = fs.readFileSync(summary.file);

      let thrown: unknown;
      try {
        restoreBackup({
          dataDir: t.dataDir,
          backupFile: summary.file,
          hardWipe: true,
          ctx: { actor: "test:restore-safety" },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe("backup_inside_data_dir");
      expect(fs.existsSync(storePath)).toBe(true);
      expect(fs.existsSync(summary.file)).toBe(true);
      expect(fs.readFileSync(storePath)).toEqual(storeBefore);
      expect(fs.readFileSync(summary.file)).toEqual(backupBefore);
    } finally {
      await t.cleanup();
    }
  });
});
