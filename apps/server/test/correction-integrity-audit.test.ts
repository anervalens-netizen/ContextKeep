import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { records, supersessions } from "../src/db/schema.js";
import { expectStatus, makeTestApp, reviewCurrent } from "./helpers.js";

interface CorrectionPreview {
  jobId: string;
  proposedRecordIds: string[];
  warnings: string[];
}

describe("audit hardening: correction integrity", () => {
  it("does not supersede accepted truth when the proposed replacement was rejected after preview", async () => {
    const t = await makeTestApp();
    try {
      const project = (await t.post("/api/projects", { name: "Correction stale guard" })).json<{ id: string }>();

      const first = await t.post("/api/corrections", {
        statement: "Release policy requires signed exact-SHA promotion.",
        projectId: project.id,
        recordType: "fact",
        subject: "release-policy",
        predicate: "policy",
      });
      expectStatus(first, 201, "initial correction");
      const p1 = first.json<CorrectionPreview>();
      const priorId = p1.proposedRecordIds[0]!;
      expectStatus(await t.post(`/api/corrections/${p1.jobId}/confirm`), 200, "confirm initial correction");

      const second = await t.post("/api/corrections", {
        statement: "Release policy requires green CI only.",
        projectId: project.id,
        recordType: "fact",
        subject: "release-policy",
        predicate: "policy",
        supersedesRecordIds: [priorId],
      });
      expectStatus(second, 201, "replacement correction");
      const p2 = second.json<CorrectionPreview>();
      const replacementId = p2.proposedRecordIds[0]!;

      const reject = await reviewCurrent(t, [replacementId], "reject");
      expectStatus(reject, 200, "reject replacement after preview");

      const confirm = await t.post(`/api/corrections/${p2.jobId}/confirm`);
      expectStatus(confirm, 409, "confirm stale correction");
      expect(confirm.json<{ error: { code: string } }>().error.code).toBe("correction_proposal_changed");

      const prior = t.app.ck.deps.db.select().from(records).where(eq(records.id, priorId)).get()!;
      const replacement = t.app.ck.deps.db.select().from(records).where(eq(records.id, replacementId)).get()!;
      const supersession = t.app.ck.deps.db
        .select()
        .from(supersessions)
        .where(eq(supersessions.jobId, p2.jobId))
        .get()!;
      expect(prior.reviewStatus).toBe("accepted");
      expect(prior.effectiveTo).toBeNull();
      expect(replacement.reviewStatus).toBe("rejected");
      expect(supersession.confirmedAt).toBeNull();
      expect(supersession.confirmedBy).toBeNull();
    } finally {
      await t.cleanup();
    }
  });

  it("keys open-correction idempotency by complete intent rather than statement text alone", async () => {
    const t = await makeTestApp();
    try {
      const a = (await t.post("/api/projects", { name: "Correction intent A" })).json<{ id: string }>();
      const b = (await t.post("/api/projects", { name: "Correction intent B" })).json<{ id: string }>();
      const statement = "The deployment window is Sunday at 02:00 UTC.";

      const first = await t.post("/api/corrections", {
        statement,
        projectId: a.id,
        recordType: "fact",
        subject: "deployment-window",
        predicate: "schedule",
      });
      expectStatus(first, 201, "intent A");
      const p1 = first.json<CorrectionPreview>();

      const second = await t.post("/api/corrections", {
        statement,
        projectId: b.id,
        recordType: "fact",
        subject: "deployment-window",
        predicate: "schedule",
      });
      expectStatus(second, 201, "intent B with identical wording");
      const p2 = second.json<CorrectionPreview>();
      expect(p2.jobId).not.toBe(p1.jobId);
      expect(p2.proposedRecordIds).not.toEqual(p1.proposedRecordIds);

      const r1 = t.app.ck.deps.db.select().from(records).where(eq(records.id, p1.proposedRecordIds[0]!)).get()!;
      const r2 = t.app.ck.deps.db.select().from(records).where(eq(records.id, p2.proposedRecordIds[0]!)).get()!;
      expect(r1.projectId).toBe(a.id);
      expect(r2.projectId).toBe(b.id);

      const again = await t.post("/api/corrections", {
        statement,
        projectId: b.id,
        recordType: "fact",
        subject: "deployment-window",
        predicate: "schedule",
      });
      expectStatus(again, 201, "repeat identical intent B");
      const p2Again = again.json<CorrectionPreview>();
      expect(p2Again.jobId).toBe(p2.jobId);
      expect(p2Again.proposedRecordIds).toEqual(p2.proposedRecordIds);
      expect(p2Again.warnings.join(" ")).toMatch(/idempotent/i);
    } finally {
      await t.cleanup();
    }
  });
});
