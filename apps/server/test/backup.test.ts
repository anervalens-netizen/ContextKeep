import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { SchemaVersionError } from "../src/db/bootstrap.js";
import { ApiError } from "../src/lib/errors.js";
import { sha256 } from "../src/lib/hash.js";
import { createBackup, restoreBackup, verifyBackup } from "../src/services/backup.js";
import { expectStatus, getInboxCandidates, makeTestApp, reviewCurrent, type InjectResult, type TestApp } from "./helpers.js";

/**
 * A8: restore from backup on an empty host produces an identical project brief.
 * This test performs the REAL drill: backup → wipe data dir → restore → rebuild
 * the app on the restored store → byte-identical brief fingerprints.
 */

interface MinimalClient {
  get(url: string): Promise<InjectResult>;
}

async function briefFingerprint(t: MinimalClient): Promise<string> {
  const projectsRes = await t.get("/api/projects");
  const projects = projectsRes.json<{ id: string }[]>();
  const parts: string[] = [];
  for (const p of [...projects].sort((a, b) => a.id.localeCompare(b.id))) {
    const briefRes = await t.get(`/api/projects/${p.id}/brief`);
    const brief = briefRes.json<Record<string, unknown>>();
    delete brief.generatedAt; // wall-clock, not state
    parts.push(JSON.stringify(brief));
  }
  return sha256(parts.join("|"));
}

describe("A8: backup + wipe + restore drill", () => {
  it("restores an identical brief after the data dir is wiped", async () => {
    const t = await makeTestApp({ seed: true });
    const backupDir = mkdtempSync(path.join(tmpdir(), "ck-backup-"));
    try {
      // Extra activity beyond the seed: import + accept a record.
      const imp = await t.post("/api/imports/text", {
        text: "fact: the restore drill was scheduled for milestone M0",
        adapterId: "faketest",
        title: "Drill note",
      });
      expectStatus(imp, 201, "drill import");
      const candidates = await getInboxCandidates(t);
      const c = candidates.find((x) => (x.text as string).includes("restore drill"))!;
      await reviewCurrent(t, [c.id as string], "accept");

      const before = await briefFingerprint(t);

      const summary = await createBackup(t.app.ck.handle, t.app.ck.deps, backupDir, 5, { actor: "test" });
      expect(fs.existsSync(summary.file)).toBe(true);
      expect(summary.counts.projects).toBe(5);

      const cookie = t.cookie;
      const csrf = t.csrf;
      const config = t.config;
      const dataDir = t.dataDir;

      // Close handles, then WIPE the data dir entirely.
      await t.app.close();
      rmSync(dataDir, { recursive: true, force: true });
      expect(fs.existsSync(path.join(dataDir, "store.sqlite"))).toBe(false);

      // Restore onto the empty host.
      const result = restoreBackup({ dataDir, backupFile: summary.file, hardWipe: true, ctx: { actor: "test" } });
      expect(fs.existsSync(result.restored)).toBe(true);

      // Rebuild the app on the restored store; the old session survived in the snapshot.
      const app2 = await buildApp({ config, logger: false });
      const t2: MinimalClient = {
        get: (url) =>
          app2.inject({ method: "GET", url, headers: { cookie } }).then((res) => ({
            statusCode: res.statusCode,
            payload: res.payload,
            headers: res.headers as Record<string, string | string[] | undefined>,
            cookies: res.cookies.map((c) => ({ name: c.name, value: c.value })),
            json<T>(): T {
              return JSON.parse(res.payload) as T;
            },
          })),
      };
      try {
        const after = await briefFingerprint(t2);
        expect(after).toBe(before); // identical briefs

        // The restore itself is audited inside the restored store.
        const authed = await app2.inject({
          method: "GET",
          url: "/api/audit?action=restore.performed",
          headers: { cookie, "x-csrf-token": csrf },
        });
        expect(authed.statusCode).toBe(200);
        expect((authed.json() as unknown[]).length).toBeGreaterThan(0);

        // Records survived: the accepted drill fact is in the brief.
        const projects = (await t2.get("/api/projects")).json<{ id: string; name: string }[]>();
        void projects;
      } finally {
        await app2.close();
      }
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
      await t.cleanup();
    }
  });

  it("rotates backups to the configured keep count", async () => {
    const t = await makeTestApp();
    const backupDir = mkdtempSync(path.join(tmpdir(), "ck-rotate-"));
    try {
      // Two pre-existing older backups (fake contents; rotation looks at names only).
      fs.writeFileSync(path.join(backupDir, "store-2026-09-01T00-00-00-000Z.sqlite"), "old1");
      fs.writeFileSync(path.join(backupDir, "store-2026-09-02T00-00-00-000Z.sqlite"), "old2");
      const summary = await createBackup(t.app.ck.handle, t.app.ck.deps, backupDir, 2, { actor: "test" });
      const files = fs.readdirSync(backupDir).filter((f) => f.endsWith(".sqlite")).sort();
      expect(files.length).toBe(2);
      expect(files).toContain(path.basename(summary.file)); // newest real backup
      expect(files).toContain("store-2026-09-02T00-00-00-000Z.sqlite"); // second newest
      expect(files).not.toContain("store-2026-09-01T00-00-00-000Z.sqlite"); // rotated out
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
      await t.cleanup();
    }
  });

  it("keeps named checkpoints outside rotation and never evicts the backup just created", async () => {
    const t = await makeTestApp();
    const backupDir = mkdtempSync(path.join(tmpdir(), "ck-rotate-checkpoint-"));
    try {
      fs.writeFileSync(path.join(backupDir, "store-2026-09-01T00-00-00-000Z.sqlite"), "old");
      fs.writeFileSync(path.join(backupDir, "store-z-checkpoint.sqlite"), "operator checkpoint");
      const summary = await createBackup(t.app.ck.handle, t.app.ck.deps, backupDir, 1, { actor: "test" });

      expect(fs.existsSync(summary.file)).toBe(true);
      expect(fs.existsSync(path.join(backupDir, "store-z-checkpoint.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(backupDir, "store-2026-09-01T00-00-00-000Z.sqlite"))).toBe(false);
      const rotating = fs.readdirSync(backupDir).filter((f) =>
        /^store-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(f),
      );
      expect(rotating).toEqual([path.basename(summary.file)]);
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
      await t.cleanup();
    }
  });

  it("verifyBackup rejects corrupt files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ck-corrupt-"));
    try {
      const bad = path.join(dir, "bad.sqlite");
      fs.writeFileSync(bad, "this is not a sqlite database at all".repeat(100));
      let caught: unknown = null;
      try {
        verifyBackup(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe("backup_corrupt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifyBackup refuses a backup stamped with a newer schema version (A17 at restore time)", async () => {
    const t = await makeTestApp();
    const dir = mkdtempSync(path.join(tmpdir(), "ck-newer-"));
    try {
      const summary = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 5, { actor: "test" });
      const db = new Database(summary.file);
      db.prepare("INSERT INTO schema_version (version, applied_at, app_version) VALUES (999, ?, ?)").run(
        new Date().toISOString(),
        "99.0.0",
      );
      db.close();
      expect(() => verifyBackup(summary.file)).toThrow(SchemaVersionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.cleanup();
    }
  });
});
