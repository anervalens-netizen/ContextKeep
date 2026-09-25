import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDto } from "@contextkeep/shared";
import { HousekeepingCoordinator, runMemoryHousekeeping } from "../src/services/housekeeping.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
});

async function projectWithProposal(text: string): Promise<{ t: TestApp; project: ProjectDto; recordId: string }> {
  const t = await makeTestApp({ adapters: "manual,faketest" });
  apps.push(t);
  const projectRes = await t.post("/api/projects", { name: "Housekeeping Project" });
  expectStatus(projectRes, 200);
  const project = projectRes.json<ProjectDto>();
  const imported = await t.post("/api/imports/text", {
    projectId: project.id,
    adapterId: "faketest",
    text: "fact: " + text,
  });
  expectStatus(imported, 201);
  const row = t.app.ck.handle.sqlite
    .prepare("SELECT id FROM records WHERE project_id=? AND text=?")
    .get(project.id, text) as { id: string };
  return { t, project, recordId: row.id };
}

describe("L5.4 memory housekeeping", () => {
  it("recoverably archives only stale non-owner proposals while retaining evidence and accepted truth", async () => {
    const { t, project, recordId: staleId } = await projectWithProposal("stale agent proposal");
    const second = await t.post("/api/imports/text", {
      projectId: project.id,
      adapterId: "faketest",
      text: "fact: protected owner proposal",
    });
    expectStatus(second, 201);
    const third = await t.post("/api/imports/text", {
      projectId: project.id,
      adapterId: "faketest",
      text: "fact: accepted volatile truth",
    });
    expectStatus(third, 201);

    const ownerId = (t.app.ck.handle.sqlite
      .prepare("SELECT id FROM records WHERE project_id=? AND text='protected owner proposal'")
      .get(project.id) as { id: string }).id;
    const acceptedId = (t.app.ck.handle.sqlite
      .prepare("SELECT id FROM records WHERE project_id=? AND text='accepted volatile truth'")
      .get(project.id) as { id: string }).id;

    const old = "2026-07-01T00:00:00.000Z";
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=?,updated_at=? WHERE id IN (?,?,?)")
      .run(old, old, staleId, ownerId, acceptedId);
    t.app.ck.handle.sqlite.prepare("UPDATE records SET evidence_basis='owner_declaration' WHERE id=?").run(ownerId);
    t.app.ck.handle.sqlite.prepare(
      "UPDATE records SET review_status='accepted',volatile=1,review_due_at=?,reviewed_at=?,revision=2 WHERE id=?",
    ).run("2026-08-01T00:00:00.000Z", old, acceptedId);

    const beforeEvidence = (t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM record_evidence WHERE record_id=?")
      .get(staleId) as { n: number }).n;
    expect(beforeEvidence).toBeGreaterThan(0);

    const result = runMemoryHousekeeping(
      t.app.ck.deps,
      { housekeepingProposalRetentionDays: 30 },
      undefined,
      Date.parse("2026-09-18T05:30:00.000Z"),
    );

    expect(result.archivedProposals).toBe(1);
    expect(result.archivedRecordIds).toEqual([staleId]);
    expect(result.overdueAccepted).toBe(1);

    const stale = t.app.ck.handle.sqlite
      .prepare("SELECT review_status,revision FROM records WHERE id=?")
      .get(staleId) as { review_status: string; revision: number };
    expect(stale).toEqual({ review_status: "rejected", revision: 2 });

    const owner = t.app.ck.handle.sqlite
      .prepare("SELECT review_status FROM records WHERE id=?")
      .get(ownerId) as { review_status: string };
    expect(owner.review_status).toBe("proposed");

    const accepted = t.app.ck.handle.sqlite
      .prepare("SELECT review_status FROM records WHERE id=?")
      .get(acceptedId) as { review_status: string };
    expect(accepted.review_status).toBe("accepted");

    const afterEvidence = (t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM record_evidence WHERE record_id=?")
      .get(staleId) as { n: number }).n;
    expect(afterEvidence).toBe(beforeEvidence);

    const deletion = t.app.ck.handle.sqlite.prepare(
      "SELECT actor, json_extract(detail_json,'$.operation') AS operation, " +
      "json_extract(detail_json,'$.recoverable') AS recoverable " +
      "FROM audit_events WHERE target_type='record' AND target_id=? " +
      "ORDER BY timestamp DESC,id DESC LIMIT 1",
    ).get(staleId) as { actor: string; operation: string; recoverable: number };
    expect(deletion).toEqual({ actor: "system:housekeeping", operation: "record.delete", recoverable: 1 });
  });

  it("runs immediately when periodic housekeeping is enabled", async () => {
    const { t, recordId } = await projectWithProposal("scheduled stale proposal");
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=? WHERE id=?")
      .run("2026-07-01T00:00:00.000Z", recordId);
    t.config.housekeepingIntervalMinutes = 60;
    t.config.housekeepingProposalRetentionDays = 30;

    const coordinator = new HousekeepingCoordinator(t.app.ck.deps, t.config);
    coordinator.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const status = coordinator.status();
    coordinator.stop();

    expect(status.enabled).toBe(true);
    expect(status.lastResult?.archivedProposals).toBe(1);
    const row = t.app.ck.handle.sqlite.prepare("SELECT review_status FROM records WHERE id=?").get(recordId) as { review_status: string };
    expect(row.review_status).toBe("rejected");
  });

  it("is idempotent after stale proposals have been archived", async () => {
    const { t, recordId } = await projectWithProposal("archive once only");
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=? WHERE id=?")
      .run("2026-07-01T00:00:00.000Z", recordId);

    const at = Date.parse("2026-09-18T05:30:00.000Z");
    const first = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, at);
    const second = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, at);

    expect(first.archivedProposals).toBe(1);
    expect(second.archivedProposals).toBe(0);
  });
});
