import { describe, expect, it } from "vitest";
import type { HandoffExportDto } from "@contextkeep/shared";
import { expectStatus, getInboxCandidates, makeTestApp, reviewCurrent } from "./helpers.js";

describe("L2.3 handoff freshness metadata", () => {
  it("persists the source content cursor in metadata and portable markdown", async () => {
    const t = await makeTestApp({ adapters: "faketest" });
    try {
      const project = (await t.post("/api/projects", { name: "Handoff freshness" })).json<{ id: string }>();
      await t.post("/api/imports/text", {
        text: "fact: canonical handoff content",
        adapterId: "faketest",
        projectId: project.id,
      });
      const candidates = await getInboxCandidates(t, project.id);
      await reviewCurrent(t, candidates.map((r) => r.id as string), "accept");

      const response = await t.post("/api/handoffs", { projectId: project.id });
      expectStatus(response, 201, "create handoff");
      const handoff = response.json<HandoffExportDto>();
      expect(handoff.sourceRevision).toBe(1);
      expect(handoff.sourceContentVersion).toBe(1);
      expect(handoff.markdown).toContain("Content cursor: 1");

      const persisted = await t.get(`/api/handoffs/${handoff.id}`);
      expectStatus(persisted, 200, "read handoff");
      expect(persisted.json<HandoffExportDto>().sourceContentVersion).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});
