import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBackup, restoreBackup } from "../src/services/backup.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/client.js";
import { makeTestApp } from "./helpers.js";

describe("RC09 recovery and durability", () => {
  it("production defaults FULL and an explicit NORMAL override remains supported", () => {
    const env = {NODE_ENV: "production", CK_SESSION_SECRET: "disposable-test-secret"};
    expect(loadConfig(env, {}).sqliteSynchronous).toBe("FULL");
    expect(loadConfig({...env, CK_SQLITE_SYNCHRONOUS: "NORMAL"}, {}).sqliteSynchronous).toBe("NORMAL");
    const db = openDatabase(":memory:", "FULL");
    try { expect(db.sqlite.pragma("synchronous", {simple:true})).toBe(2); } finally { db.sqlite.close(); }
  });
  for (const failure of ["copy", "promotion", "verification"] as const) it(`preserves old bytes on ${failure} failure, even with hardWipe`, async () => {
    const t = await makeTestApp();
    try {
      const backup = await createBackup(t.app.ck.handle, t.app.ck.deps, t.config.backupDir, 2, {actor:"test"});
      const target = path.join(t.dataDir, "restore-target"); fs.mkdirSync(target);
      const store = path.join(target, "store.sqlite"); fs.writeFileSync(store, "old-store-sentinel");
      const rename = fs.renameSync;
      const spy = failure === "copy" ? vi.spyOn(fs, "copyFileSync").mockImplementationOnce(() => {throw new Error("copy failure");}) : vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (String(from).includes(".restore-stage-") && to === store) {
          if (failure === "promotion") throw new Error("promotion failure");
          rename(from, to);
          fs.writeFileSync(store, "invalid promoted bytes");
          return;
        }
        return rename(from, to);
      });
      try { expect(() => restoreBackup({dataDir:target, backupFile:backup.file, hardWipe:true, ctx:{actor:"test"}})).toThrow(failure === "verification" ? /readable SQLite/ : `${failure} failure`); }
      finally { spy.mockRestore(); }
      expect(fs.readFileSync(store, "utf8")).toBe("old-store-sentinel");
      expect(fs.readdirSync(target).some((name) => name.startsWith('.restore-stage-'))).toBe(false);
    } finally { await t.cleanup(); }
  });
  it("refuses a live nonempty WAL instead of discarding it", async () => {
    const t = await makeTestApp();
    try {
      const backup = await createBackup(t.app.ck.handle, t.app.ck.deps, t.config.backupDir, 2, {actor:"test"});
      const wal = path.join(t.dataDir, "store.sqlite-wal");
      const before = fs.readFileSync(wal);
      // Directory ownership refuses earlier than the retained WAL guard.
      expect(() => restoreBackup({dataDir:t.dataDir, backupFile:backup.file, ctx:{actor:"test"}})).toThrow(expect.objectContaining({code:"directory_in_use"}));
      expect(fs.readFileSync(wal)).toEqual(before);
    } finally { await t.cleanup(); }
  });
  it("retains nonempty-WAL refusal for an offline target without an active lease", async () => {
    const t = await makeTestApp();
    try {
      const backup = await createBackup(t.app.ck.handle, t.app.ck.deps, t.config.backupDir, 2, {actor:"test"});
      const target = path.join(t.dataDir, "offline-target"); fs.mkdirSync(target);
      const store = path.join(target, "store.sqlite"); fs.copyFileSync(backup.file, store);
      const wal = `${store}-wal`; fs.writeFileSync(wal, "uncheckpointed-wal-sentinel");
      const before = fs.readFileSync(store);
      expect(() => restoreBackup({dataDir:target, backupFile:backup.file, ctx:{actor:"test"}})).toThrow(/WAL/);
      expect(fs.readFileSync(store)).toEqual(before);
      expect(fs.readFileSync(wal,"utf8")).toBe("uncheckpointed-wal-sentinel");
    } finally { await t.cleanup(); }
  });
});
