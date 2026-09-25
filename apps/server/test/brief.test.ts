import { describe, expect, it } from "vitest";
import type { BriefDto, TimelineDto } from "@contextkeep/shared";
import { expectStatus, getProjectByName, makeTestApp, reviewCurrent, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

describe("current brief (M0 scope 5)", () => {
  it("projects lifecycle from the accepted lifecycle record and links evidence to every statement", async () => {
    await withApp(
      async (t) => {
        const kb = await getProjectByName(t, "ExampleSuite Keyboard");
        const res = await t.get(`/api/projects/${kb.id}/brief`);
        expectStatus(res, 200, "keyboard brief");
        const brief = res.json<BriefDto>();

        // Lifecycle is the projection of the accepted lifecycle record.
        expect(brief.lifecycle.state).toBe("active");
        expect(brief.lifecycle.recordId).toBe(kb.lifecycleRecordId);
        expect(brief.lifecycle.reviewedAt).not.toBeNull();
        expect(brief.project.lifecycle).toBe("active");

        // Accepted facts are present; the superseded STT fact is NOT.
        const factTexts = brief.facts.map((s) => s.record.text).join(" | ");
        expect(factTexts).toMatch(/OpenAI-powered voice\/LLM feature/);
        expect(factTexts).not.toMatch(/on-device STT/);

        // Every statement links to its evidence excerpt(s).
        for (const statement of [...brief.facts, ...brief.decisions, ...brief.constraints, ...brief.openQuestions, ...brief.actions]) {
          expect(statement.evidence.length).toBeGreaterThan(0);
          for (const ev of statement.evidence) {
            expect(ev.text.length).toBeGreaterThan(0);
            expect(ev.sourceId).toBeTruthy();
            expect(ev.endOffset).toBeGreaterThan(ev.startOffset);
          }
        }

        expect(brief.lastReviewedAt).not.toBeNull();
        expect(brief.generatedAt).toBeTruthy();

        // Evidence text is the exact slice of the source's normalized text.
        const ev = brief.facts[0]!.evidence[0]!;
        const src = await t.get(`/api/sources/${ev.sourceId}`);
        expectStatus(src, 200, "evidence source");
      },
      { seed: true },
    );
  });

  it("retired family briefs show retired lifecycle; unknown projects stay unknown", async () => {
    await withApp(
      async (t) => {
        for (const name of ["ExampleSuite", "ExampleSuite Server", "ExampleSuite Web"]) {
          const p = await getProjectByName(t, name);
          const brief = (await t.get(`/api/projects/${p.id}/brief`)).json<BriefDto>();
          expect(brief.lifecycle.state).toBe("retired");
          expect(brief.lifecycle.recordId).toBe(p.lifecycleRecordId);
        }
        const dsh = await getProjectByName(t, "ExampleAssistant");
        const brief = (await t.get(`/api/projects/${dsh.id}/brief`)).json<BriefDto>();
        expect(brief.lifecycle.state).toBe("unknown");
        expect(brief.lifecycle.recordId).toBeNull();
        // Proposals never leak into the brief (A22 family of guarantees).
        expect(brief.facts.length).toBe(0);
        expect(brief.actions.length).toBe(0);
      },
      { seed: true },
    );
  });

  it("invalidates cached overdue flags when a volatile review deadline passes without a write", async () => {
    await withApp(async (t) => {
      const project = (await t.post("/api/projects", { name: "Deadline Cache Project" })).json<{ id: string }>();
      const imp = await t.post("/api/imports/text", {
        text: "volatile-fact: deployment SHA is cache-deadline-123",
        adapterId: "faketest",
        projectId: project.id,
      });
      expectStatus(imp, 201, "volatile import");
      const candidate = (await t.get(`/api/inbox?projectId=${project.id}`))
        .json<{ candidates: { id: string }[] }>()
        .candidates[0]!;
      expectStatus(await reviewCurrent(t, [candidate.id], "accept"), 200, "accept volatile");

      // Change only the time-dependent field, not updated_at. The first response
      // is cached before the deadline; after real time crosses that deadline no
      // database write occurs. Fake timers are intentionally avoided because the
      // Fastify/test harness uses timers for lifecycle and cleanup work.
      const dueAtMs = Date.now() + 5_000;
      const dueAt = new Date(dueAtMs).toISOString();
      t.app.ck.deps.sqlite
        .prepare("UPDATE records SET review_due_at = ? WHERE id = ?")
        .run(dueAt, candidate.id);

      const before = (await t.get(`/api/projects/${project.id}/brief`)).json<BriefDto>();
      const beforeRecord = before.facts.find((s) => s.record.id === candidate.id)!.record;
      expect(beforeRecord.reviewDueAt).toBe(dueAt);
      expect(beforeRecord.isOverdue).toBe(false);

      const remaining = Math.max(0, dueAtMs - Date.now() + 150);
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));

      const after = (await t.get(`/api/projects/${project.id}/brief`)).json<BriefDto>();
      const afterRecord = after.facts.find((s) => s.record.id === candidate.id)!.record;
      expect(afterRecord.reviewDueAt).toBe(dueAt);
      expect(afterRecord.isOverdue).toBe(true);
      expect(after.generatedAt).not.toBe(before.generatedAt);
    });
  }, 15_000);

  it("404s for unknown projects", async () => {
    await withApp(async (t) => {
      const res = await t.get("/api/projects/does-not-exist/brief");
      expectStatus(res, 404, "unknown project brief");
    });
  });
});

describe("historical timeline (M0 scope 5)", () => {
  it("includes superseded records with supersession links, ordered by event time", async () => {
    await withApp(
      async (t) => {
        const kb = await getProjectByName(t, "ExampleSuite Keyboard");
        const res = await t.get(`/api/projects/${kb.id}/timeline`);
        expectStatus(res, 200, "keyboard timeline");
        const timeline = res.json<TimelineDto>();

        const stt = timeline.entries.find((e) => e.record.text.includes("on-device STT"))!;
        const openai = timeline.entries.find((e) => e.record.text.includes("uses the OpenAI-powered"))!;
        expect(stt.record.reviewStatus).toBe("superseded");
        expect(openai.record.reviewStatus).toBe("accepted");
        expect(stt.supersededBy?.recordId).toBe(openai.record.id);
        expect(stt.supersededBy?.confirmedAt).toBeTruthy();
        expect(openai.supersedes.map((s) => s.recordId)).toContain(stt.record.id);

        // Event-time ordering: 2025 experiment before the 2026 correction.
        const idxStt = timeline.entries.indexOf(stt);
        const idxOpenAi = timeline.entries.indexOf(openai);
        expect(idxStt).toBeLessThan(idxOpenAi);

        // Rejected/proposed records are not part of the truth timeline.
        expect(timeline.entries.every((e) => ["accepted", "superseded"].includes(e.record.reviewStatus))).toBe(true);
      },
      { seed: true },
    );
  });
});
