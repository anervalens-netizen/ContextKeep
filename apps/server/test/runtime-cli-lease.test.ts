import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.js";
import { openDatabase } from "../src/db/client.js";

describe("runtime ownership for maintenance writers", () => {
  it("refuses real migration, seed and dump writers while keeping reads available", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      await t.post("/api/projects", {
        name: "Synthetic maintenance ownership",
      });
      const dump = await t.get("/api/export/json");
      expect(dump.statusCode).toBe(200);
      const dumpPath = path.join(t.dataDir, "synthetic-portable.json");
      fs.writeFileSync(dumpPath, dump.payload);
      const env = {
        ...process.env,
        NODE_OPTIONS: "",
        NODE_ENV: "test",
        CK_DATA_DIR: t.dataDir,
        CK_SESSION_SECRET: "synthetic-cli-runtime-secret",
        CK_ADAPTERS: "manual",
      };
      const run = (file: string, args: string[] = []) =>
        spawnSync(
          process.execPath,
          ["--import", "tsx/esm", `src/cli/${file}.ts`, ...args],
          { cwd: process.cwd(), env, encoding: "utf8", timeout: 15_000 },
        );
      const before = t.app.ck.deps.sqlite
        .prepare("SELECT count(*) AS n FROM projects")
        .get();
      for (const [file, args] of [
        ["migrate", []],
        ["seed", []],
        ["seed-from-dump", [dumpPath, "--mode=reset"]],
      ] as const) {
        const result = run(file, [...args]);
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("already owns this data directory");
      }
      const reader = openDatabase(t.config.dbPath);
      reader.sqlite.close();
      expect(run("seed-from-dump", [dumpPath, "--dry-run"]).status).toBe(0);
      expect(
        t.app.ck.deps.sqlite
          .prepare("SELECT count(*) AS n FROM projects")
          .get(),
      ).toEqual(before);
      await t.app.close();
      const migrated = run("migrate");
      expect(migrated.status, migrated.stderr).toBe(0);
      const nextWriter = openDatabase(t.config.dbPath, "NORMAL", {
        runtime: true,
      });
      nextWriter.sqlite.close();
    } finally {
      await t.cleanup();
    }
  }, 30_000);
});
