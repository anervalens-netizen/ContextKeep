import { describe, expect, it } from "vitest";
import { captureWork } from "../src/services/capture-work.js";
import { makeTestApp } from "./helpers.js";

describe("MCF-10 owner dashboard read-side", () => {
  it("shows proposal-only MCP-style working memory without promoting canonical truth", async () => {
    const t = await makeTestApp();
    try {
      const project = (await t.post("/api/projects", { name: "MCF10 dashboard" })).json<{ id: string }>();
      const captured = captureWork(t.app.ck.deps, {
        projectId: project.id,
        outcome: "Working-only dashboard capture",
        evidenceText: "Evidence for a working-only dashboard capture.",
        title: "MCF10 capture",
        eventAt: "2026-09-22T14:15:00.000Z",
        recordType: "fact",
        subject: "mcf10-dashboard",
        progressUpdates: [],
        checkpoint: {
          summary: "Dashboard checkpoint",
          nextAction: "Review explicitly",
          blockers: ["Owner review pending"],
          artifactRefs: ["git:test"],
        },
      }, { actor: "test:mcf10", requestId: null });

      expect(captured.outcome.reviewStatus).toBe("proposed");
      const response = await t.get(`/api/projects/${project.id}/work-context`);
      expect(response.statusCode).toBe(200);
      const body = response.json<any>();

      expect(body.project.id).toBe(project.id);
      expect(body.freshness.canonicalCursor).toBe(0);
      expect(body.freshness.workingCursor).toBeGreaterThan(0);
      expect(body.workingMemory.items.some((item: any) => item.recordId === captured.outcome.recordId)).toBe(true);
      expect(body.latestCheckpoint.checkpoint.summary).toBe("Dashboard checkpoint");
      expect(body.blockerState.activeCount).toBe(1);
      expect(body.blockerState.active[0].text).toBe("Owner review pending");

      const brief = await t.get(`/api/projects/${project.id}/brief`);
      expect(brief.statusCode).toBe(200);
      const canonical = brief.json<any>();
      expect(canonical.facts).toHaveLength(0);
      expect(canonical.decisions).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
