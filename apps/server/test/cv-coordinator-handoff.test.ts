import { describe, expect, it } from "vitest";
import { getInboxCandidates, makeTestApp, reviewCurrent } from "./helpers.js";

describe("CV independent review: handoff resume projection", () => {
  it("maps accepted brief identities and trust metadata into the shared resume section", async () => {
    const t = await makeTestApp();
    try {
      const project = (await t.post("/api/projects", { name: "CV handoff identity" })).json<{ id: string }>();
      const imported = await t.post("/api/imports/text", {
        text: "decision: pin the release before deployment\nconstraint: preserve the owner database\nfact: SQLite is the memory store",
        adapterId: "faketest", projectId: project.id,
      });
      expect(imported.statusCode).toBe(201);
      const candidates = await getInboxCandidates(t, project.id);
      await reviewCurrent(t, candidates.map(c => c.id as string), "accept");
      const response = await t.post("/api/handoffs", { projectId: project.id });
      expect(response.statusCode).toBe(201);
      const markdown = response.json<{ markdown: string }>().markdown;
      const resume = markdown.split("## Resume\n")[1]?.split("\n## ")[0];
      expect(resume).toBeDefined();
      expect(resume).toContain("pin the release before deployment");
      expect(resume).toContain("preserve the owner database");
      expect(resume).toContain("SQLite is the memory store");
      for (const candidate of candidates) expect(resume).toContain(candidate.id);
      expect(resume).toContain("accepted");
    } finally { await t.cleanup(); }
  });
});
