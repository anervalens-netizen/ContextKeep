import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupFreshnessStatus, createBackup, restoreBackup } from "../src/services/backup.js";
import { createRecord } from "../src/services/memory-management.js";
import { runMemoryHousekeeping } from "../src/services/housekeeping.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
afterEach(async () => { for (const t of tracked.splice(0)) await t.cleanup(); });

describe("CKR housekeeping and backup Definition of Done", () => {
  it("continues a mixed housekeeping batch after one archive error and retries it later", async () => {
    const t = await makeTestApp({ adapters: "manual" }); tracked.push(t);
    const p = await t.post("/api/projects", { name: "CKR housekeeping mixed" });
    const projectId = p.json<{ id: string }>().id;
    const source = await t.post("/api/imports/text", {
      projectId, adapterId: "manual", text: "housekeeping evidence", title: "fixture",
    });
    const sourceId = source.json<any>().source.id;
    const sourceRow = t.app.ck.handle.sqlite.prepare("SELECT id FROM source_excerpts WHERE source_id=? ORDER BY start_offset LIMIT 1").get(sourceId) as { id: string };
    const mk = (subject: string, predicate: string | null = null, valueJson: string | null = null) =>
      createRecord(t.app.ck.deps, {
        projectId, sourceExcerptId: sourceRow.id, recordType: "fact", subject,
        text: subject, predicate, valueJson, evidenceBasis: "agent_report",
        sourceEventAt: null, taskStatus: null, volatile: false,
      }, { actor: "test:ckr", requestId: null }).record.id;
    const first = mk("archive-one");
    const fails = mk("archive-error");
    const last = mk("archive-two");
    const lifecycle = mk("lifecycle-old", "lifecycle", JSON.stringify("active"));
    const old = "2020-01-01T00:00:00.000Z";
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=?,updated_at=? WHERE id IN (?,?,?,?)")
      .run(old, old, first, fails, last, lifecycle);
    t.app.ck.handle.sqlite.exec(`CREATE TRIGGER ckr_housekeeping_fail
      BEFORE UPDATE OF review_status ON records
      WHEN OLD.id='${fails}' AND NEW.review_status='rejected'
      BEGIN SELECT RAISE(ABORT,'injected archive failure'); END`);

    const run = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, Date.parse("2026-09-21T00:00:00Z"));
    expect(run.status).toBe("partial");
    expect(run.archivedRecordIds.sort()).toEqual([first, last].sort());
    expect(run.skipped).toContainEqual({ recordId: lifecycle, reason: "lifecycle_requires_transition" });
    expect(run.errors.some((e) => e.recordId === fails)).toBe(true);
    expect((t.app.ck.handle.sqlite.prepare("SELECT review_status FROM records WHERE id=?").get(fails) as any).review_status).toBe("proposed");

    t.app.ck.handle.sqlite.exec("DROP TRIGGER ckr_housekeeping_fail");
    const retry = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, Date.parse("2026-09-21T00:00:00Z"));
    expect(retry.archivedRecordIds).toContain(fails);
  });

  it("protects the newest useful checkpoint even when it is outside the aged candidate set", async () => {
    const t = await makeTestApp({ adapters: "manual" }); tracked.push(t);
    const p = await t.post("/api/projects", { name: "CKR checkpoint retention" });
    const projectId = p.json<{ id: string }>().id;
    const seed = await t.post("/api/imports/text", { projectId, adapterId: "manual", text: "checkpoint source" });
    const sid = seed.json<any>().source.id;
    const excerpt = (t.app.ck.handle.sqlite.prepare("SELECT id FROM source_excerpts WHERE source_id=? LIMIT 1").get(sid) as { id: string }).id;
    const cp = (summary: string) => createRecord(t.app.ck.deps, {
      projectId, sourceExcerptId: excerpt, recordType: "fact", subject: summary, text: summary,
      evidenceBasis: "agent_report", sourceEventAt: null, taskStatus: null, volatile: false,
      valueJson: JSON.stringify({ kind: "working_checkpoint", summary, nextAction: "continue", blockers: [], artifactRefs: [] }),
      dedupIdentity: summary,
    }, { actor: "test:ckr", requestId: null }).record.id;
    const oldCheckpoint = cp("old checkpoint");
    const latestCheckpoint = cp("new checkpoint");
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(oldCheckpoint);
    const result = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, Date.parse("2026-09-21T00:00:00Z"));
    expect(result.archivedRecordIds).toContain(oldCheckpoint);
    expect((t.app.ck.handle.sqlite.prepare("SELECT review_status FROM records WHERE id=?").get(latestCheckpoint) as any).review_status).toBe("proposed");
  });

  it("distinguishes fresh file age from verified integrity and restore testing", async () => {
    const t = await makeTestApp(); tracked.push(t);
    const dir = mkdtempSync(path.join(tmpdir(), "ckr-backup-semantics-"));
    const restoreDir = mkdtempSync(path.join(tmpdir(), "ckr-restore-semantics-"));
    try {
      const summary = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 5, { actor: "test:ckr" });
      expect(fs.existsSync(summary.manifestFile)).toBe(true);
      const fresh = backupFreshnessStatus(dir);
      expect(fresh.status).toBe("fresh");
      expect(fresh.verificationStatus).toBe("verified");
      expect(fresh.latestVerifiedAt).toBeTruthy();
      expect(fresh.latestBackupRestoreTestedAt).toBeNull();

      restoreBackup({ dataDir: restoreDir, backupFile: summary.file, hardWipe: true, ctx: { actor: "test:ckr" } });
      const restored = backupFreshnessStatus(dir);
      expect(restored.latestBackupRestoreTestedAt).toBeTruthy();
      expect(restored.lastRestoreTestedAt).toBe(restored.latestBackupRestoreTestedAt);

      fs.appendFileSync(summary.file, Buffer.from([0]));
      const changed = backupFreshnessStatus(dir);
      expect(changed.status).toBe("fresh");
      expect(changed.verificationStatus).toBe("changed_or_invalid");
      expect(changed.latestVerifiedAt).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(restoreDir, { recursive: true, force: true });
    }
  });

  it("does not rotate away the previous verified backup when a new snapshot attempt fails", async () => {
    const t = await makeTestApp(); tracked.push(t);
    const dir = mkdtempSync(path.join(tmpdir(), "ckr-backup-failure-"));
    try {
      const prior = await createBackup(t.app.ck.handle, t.app.ck.deps, dir, 1, { actor: "test:ckr" });
      const original = t.app.ck.handle.sqlite.backup.bind(t.app.ck.handle.sqlite);
      const spy = vi.spyOn(t.app.ck.handle.sqlite, "backup").mockRejectedValueOnce(new Error("injected snapshot failure"));
      await expect(createBackup(t.app.ck.handle, t.app.ck.deps, dir, 1, { actor: "test:ckr" })).rejects.toThrow("injected snapshot failure");
      spy.mockRestore();
      void original;
      expect(fs.existsSync(prior.file)).toBe(true);
      expect(backupFreshnessStatus(dir).verificationStatus).toBe("verified");
      const actions = t.app.ck.handle.sqlite.prepare("SELECT action FROM audit_events WHERE action LIKE 'backup.%' ORDER BY timestamp,id").all() as Array<{ action: string }>;
      expect(actions.map((x) => x.action)).toContain("backup.failed");
      expect(actions.filter((x) => x.action === "backup.completed")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
