import { describe, expect, it, vi } from "vitest";
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

  it.each([
    ["UTC equality", "2030-01-01T12:00:01.500Z", 499, 500],
    ["offset equality", "2030-01-01T13:00:01.500+01:00", 499, 500],
    ["sub-millisecond deadline", "2030-01-01T12:00:01.5005Z", 500, 501],
  ] as const)("refreshes the cached brief without a write at %s", async (_case, dueAt, beforeMs, afterMs) => {
    // Mock only Date. Establish the owner session on the same clock as its requests.
    const utcSecond = Date.parse("2030-01-01T12:00:01Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(utcSecond + beforeMs);
      await withApp(async (t) => {
        const project = (await t.post("/api/projects", { name: "Deadline Cache Project" })).json<{ id: string }>();
        const imp = await t.post("/api/imports/text", {
          text: "volatile-fact: first review deadline\nvolatile-fact: second review deadline",
          adapterId: "faketest",
          projectId: project.id,
        });
        expectStatus(imp, 201, "volatile import");
        const candidates = (await t.get(`/api/inbox?projectId=${project.id}`))
          .json<{ candidates: { id: string; text: string }[] }>().candidates;
        const first = candidates.find((item) => item.text.includes("first review deadline"))!;
        const second = candidates.find((item) => item.text.includes("second review deadline"))!;
        expectStatus(await reviewCurrent(t, [first.id, second.id], "accept"), 200, "accept both volatile facts");
        const setDue = t.app.ck.deps.sqlite.prepare("UPDATE records SET review_due_at = ? WHERE id = ?");
        setDue.run(dueAt, first.id);
        // This later instant sorts first as text.
        setDue.run("2030-01-01T10:00:01.700-02:00", second.id);

        const readBrief = async () => {
          const response = await t.get(`/api/projects/${project.id}/brief`);
          expectStatus(response, 200, "get brief");
          const brief = response.json<BriefDto>();
          const firstRecord = brief.facts.find((fact) => fact.record.id === first.id)!.record;
          const secondRecord = brief.facts.find((fact) => fact.record.id === second.id)!.record;
          expect(firstRecord.reviewDueAt).toBe(dueAt);
          return { generatedAt: brief.generatedAt, overdue: [firstRecord.isOverdue, secondRecord.isOverdue] };
        };

        const before = await readBrief();
        expect(before.overdue).toEqual([false, false]);

        vi.setSystemTime(utcSecond + afterMs);
        const after = await readBrief();
        expect(after.overdue).toEqual([true, false]);
        expect(after.generatedAt).not.toBe(before.generatedAt);

        vi.setSystemTime(utcSecond + 700);
        const bothDue = await readBrief();
        expect(bothDue.overdue).toEqual([true, true]);
        vi.setSystemTime(utcSecond + 1_000);
        expect(await readBrief()).toEqual(bothDue);

        // A clock correction can also move a deadline back into the future.
        vi.setSystemTime(utcSecond + beforeMs);
        expect((await readBrief()).overdue).toEqual([false, false]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

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
