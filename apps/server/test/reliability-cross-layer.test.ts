import { describe, expect, it } from "vitest";
import type { ReviewResultDto, TimelineDto } from "@contextkeep/shared";
import { getInboxCandidates, makeTestApp } from "./helpers.js";
import { validateMutationAcknowledgement } from "../../web/src/lib/mutation-ack.js";

describe("reliability integration contracts", () => {
  it("accepts the real edit-and-accept response without confusing edited metadata with a second outcome", async () => {
    const t = await makeTestApp({ adapters: "manual,faketest" });
    try {
      const create = await t.post("/api/projects", {
        name: "Synthetic acknowledgement project",
      });
      expect(create.statusCode).toBe(200);
      const projectId = create.json<{ id: string }>().id;
      const imported = await t.post("/api/imports/text", {
        text: "fact: synthetic draft assertion",
        projectId,
        adapterId: "faketest",
      });
      expect(imported.statusCode).toBe(201);
      const candidates = await getInboxCandidates(t, projectId);
      const candidate = candidates[0] as { id: string; revision: number };
      expect(candidate).toBeDefined();
      const input = {
        items: [{ recordId: candidate.id, revision: candidate.revision }],
        action: "accept",
        edits: {
          [candidate.id]: {
            revision: candidate.revision,
            text: "Synthetic revised assertion",
          },
        },
      };
      const reply = await t.post("/api/inbox/decide", input);
      expect(reply.statusCode).toBe(200);
      const result = reply.json<ReviewResultDto>();
      expect(result.accepted).toEqual([candidate.id]);
      expect(result.edited).toEqual([candidate.id]);
      expect(
        validateMutationAcknowledgement(
          "/api/inbox/decide",
          "POST",
          input,
          result,
        ).valid,
      ).toBe(true);
      expect(
        validateMutationAcknowledgement("/api/inbox/decide", "POST", input, {
          ...result,
          accepted: [],
        }).valid,
      ).toBe(false);
      expect(
        validateMutationAcknowledgement("/api/inbox/decide", "POST", input, {
          ...result,
          blocked: [
            {
              recordId: candidate.id,
              code: "synthetic",
              message: "Contradictory primary outcome",
            },
          ],
        }).valid,
      ).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  it("preserves the complete legacy timeline beyond the SQLite two-IN-list variable boundary", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const created = await t.post("/api/projects", {
        name: "Synthetic large timeline",
      });
      expect(created.statusCode).toBe(200);
      const projectId = created.json<{ id: string }>().id;
      const count = 16_400;
      const stamp = "2026-01-01T00:00:00.000Z";
      const insert = t.app.ck.deps.sqlite.prepare(`
        INSERT INTO records
          (id, project_id, type, subject, text, review_status, evidence_basis,
           record_dedup_hash, recorded_at, created_at, updated_at)
        VALUES (@id, @project, 'fact', @subject, @text, 'accepted', 'document',
                @hash, @stamp, @stamp, @stamp)
      `);
      t.app.ck.deps.sqlite.transaction(() => {
        for (let i = 0; i < count; i++) {
          insert.run({
            id: `synthetic-timeline-${i.toString().padStart(5, "0")}`,
            project: projectId,
            subject: `Synthetic fact ${i}`,
            text: `Synthetic timeline record ${i}`,
            hash: `synthetic-large-timeline-${i}`,
            stamp,
          });
        }
      })();
      const all = await t.get(`/api/projects/${projectId}/timeline`);
      expect(all.statusCode).toBe(200);
      expect(all.json<TimelineDto>().entries).toHaveLength(count);
      const page = await t.get(`/api/projects/${projectId}/timeline?limit=10`);
      expect(page.statusCode).toBe(200);
      expect(page.json<TimelineDto>().entries).toHaveLength(10);
    } finally {
      await t.cleanup();
    }
  });
});
