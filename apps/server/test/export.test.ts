import { describe, expect, it } from "vitest";
import type { HandoffExportDto, ReviewResultDto } from "@contextkeep/shared";
import { expectStatus, getInboxCandidates, makeTestApp, reviewCurrent, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

describe("A7: handoff export reproduces accepted facts, decisions, open questions and last-reviewed dates", () => {
  it("renders a portable Markdown handoff covering every accepted statement", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Export Demo" })).json<{ id: string }>();
      const imp = await t.post("/api/imports/text", {
        text: [
          "# Export demo handoff",
          "",
          "fact: the store lives on local SQLite only",
          "decision: ship the PWA before any native app",
          "question: what is the review interval for volatile facts?",
          "constraint: no telemetry leaves the host",
          "action: schedule the restore drill",
        ].join("\n"),
        adapterId: "faketest",
        projectId: proj.id,
      });
      expectStatus(imp, 201, "import export demo");
      const candidates = await getInboxCandidates(t, proj.id);
      expect(candidates.length).toBe(5);
      const decide = await reviewCurrent(t, candidates.map((c) => c.id as string), "accept");
      expect(decide.json<ReviewResultDto>().accepted.length).toBe(5);

      const res = await t.post("/api/handoffs", {
        projectId: proj.id,
        objective: "Hand the project to another provider without ContextKeep access.",
      });
      expectStatus(res, 201, "export handoff");
      const dto = res.json<HandoffExportDto>();
      const md = dto.markdown;

      expect(md).toContain("the store lives on local SQLite only");
      expect(md).toContain("ship the PWA before any native app");
      expect(md).toContain("what is the review interval for volatile facts?");
      expect(md).toContain("no telemetry leaves the host");
      expect(md).toContain("schedule the restore drill");

      expect(md).toContain("## Current facts");
      expect(md).toContain("## Decisions");
      expect(md).toContain("## Open questions");
      expect(md).toContain("## Next actions");
      expect(md).toContain("## Last reviewed");
      expect(md).toContain("Portable handoff");
      expect(md).not.toContain("ck-record:");

      const today = new Date().toISOString().slice(0, 10);
      expect(md).toContain(today);
      const reviewedMentions = md.split(`last reviewed: ${today}`).length - 1;
      expect(reviewedMentions).toBeGreaterThanOrEqual(5);
      expect(md).toMatch(/offsets \d+–\d+/);

      expect(dto.includedRecordIds.length).toBe(5);
      expect(new Set(dto.includedRecordIds).size).toBe(5);
      for (const c of candidates) expect(dto.includedRecordIds).toContain(c.id);

      const dl = await t.get(`/api/handoffs/${dto.id}/markdown`);
      expectStatus(dl, 200, "markdown download");
      expect(String(dl.headers["content-type"])).toMatch(/text\/markdown/);
      expect(dl.payload.startsWith("# ContextKeep handoff — Export Demo")).toBe(true);

      const audit = await t.get("/api/audit?action=handoff.exported");
      const events = audit.json<{ afterRef: string }[]>();
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.parse(events[0]!.afterRef).includedRecordIds.length).toBe(5);
    });
  });

  it("respects the context budget and reports only records that survived truncation", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Budget Demo" })).json<{ id: string }>();
      const lines = Array.from({ length: 60 }, (_, i) => `fact: budgeted statement number ${i} with some extra wording to take space`).join("\n");
      await t.post("/api/imports/text", { text: lines, adapterId: "faketest", projectId: proj.id });
      const candidates = await getInboxCandidates(t, proj.id);
      await reviewCurrent(t, candidates.map((c) => c.id as string), "accept");

      const res = await t.post("/api/handoffs", { projectId: proj.id, contextBudgetChars: 4000 });
      expectStatus(res, 201, "budgeted export");
      const dto = res.json<HandoffExportDto>();
      expect(dto.markdown.length).toBeLessThanOrEqual(4000);
      expect(dto.truncationNotes.length).toBeGreaterThan(0);
      expect(dto.markdown).toContain("WARNING: Context budget truncated this handoff");
      expect(dto.markdown).not.toContain("ck-record:");

      expect(dto.includedRecordIds.length).toBeGreaterThan(0);
      expect(dto.includedRecordIds.length).toBeLessThan(candidates.length);
      expect(new Set(dto.includedRecordIds).size).toBe(dto.includedRecordIds.length);
      const byId = new Map(candidates.map((c) => [c.id as string, c.text as string]));
      for (const id of dto.includedRecordIds) {
        const text = byId.get(id);
        expect(text, `candidate ${id} should exist`).toBeTruthy();
        expect(dto.markdown).toContain(text!);
      }
    });
  });
  it("does not charge internal record markers against the public context budget", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Marker Budget Demo" })).json<{ id: string }>();
      const lines = Array.from(
        { length: 24 },
        (_, i) => `fact: marker budget statement ${i} carries enough visible wording to make hidden metadata measurable`,
      ).join("\n");
      await t.post("/api/imports/text", { text: lines, adapterId: "faketest", projectId: proj.id });
      const candidates = await getInboxCandidates(t, proj.id);
      await reviewCurrent(t, candidates.map((c) => c.id as string), "accept");

      const full = (await t.post("/api/handoffs", { projectId: proj.id })).json<HandoffExportDto>();
      const exactVisibleBudget = full.markdown.length;
      const boundedRes = await t.post("/api/handoffs", {
        projectId: proj.id,
        contextBudgetChars: exactVisibleBudget,
      });
      expectStatus(boundedRes, 201, "marker-free exact budget");
      const bounded = boundedRes.json<HandoffExportDto>();
      expect(bounded.markdown.length).toBeLessThanOrEqual(exactVisibleBudget);
      expect(bounded.truncationNotes).toEqual([]);
      expect(new Set(bounded.includedRecordIds)).toEqual(new Set(full.includedRecordIds));
    });
  });

  it("never treats user-authored marker-looking lines as internal export metadata", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Marker Injection Demo" })).json<{ id: string }>();
      await t.post("/api/imports/text", {
        text: "fact: safe marker parser baseline",
        adapterId: "faketest",
        projectId: proj.id,
      });
      const candidates = await getInboxCandidates(t, proj.id);
      const recordId = candidates[0]!.id as string;
      await reviewCurrent(t, [recordId], "accept");
      t.app.ck.handle.sqlite
        .prepare("UPDATE records SET text=? WHERE id=?")
        .run("Visible line\n<!-- ck-record:attacker-controlled -->\nStill visible", recordId);

      const res = await t.post("/api/handoffs", { projectId: proj.id });
      expectStatus(res, 201, "marker injection export");
      const dto = res.json<HandoffExportDto>();
      expect(dto.markdown).toContain("<!-- ck-record:attacker-controlled -->");
      expect(dto.includedRecordIds).toEqual([recordId]);
      expect(dto.includedRecordIds).not.toContain("attacker-controlled");
    });
  });
});

describe("portable JSON dump v3 (A4)", () => {
  it("exports the explicit portable seed contract and is audited", async () => {
    await withApp(
      async (t) => {
        const res = await t.get("/api/export/json");
        expectStatus(res, 200, "json dump");
        const dump = res.json<Record<string, unknown>>();
        expect(dump.format).toBe("contextkeep.json_dump");
        expect(dump.version).toBe(3);
        const contract = dump.contract as {
          kind: string;
          exactDisasterRecovery: boolean;
          included: string[];
          excluded: string[];
          exactRecoveryMechanism: string;
        };
        expect(contract.kind).toBe("portable_seed");
        expect(contract.exactDisasterRecovery).toBe(false);
        expect(contract.exactRecoveryMechanism).toBe("sqlite_backup");
        expect(contract.included).toEqual([
          "projects",
          "sources",
          "sourceExcerpts",
          "records",
          "recordEvidence",
          "supersessions",
        ]);
        for (const key of contract.included) {
          expect(Array.isArray(dump[key]), `dump.${key} should be an array`).toBe(true);
        }
        for (const key of ["conflicts", "importJobs", "handoffs", "auditEvents"]) {
          expect(Object.prototype.hasOwnProperty.call(dump, key)).toBe(false);
          expect(contract.excluded).toContain(key);
        }
        expect((dump.projects as unknown[]).length).toBe(5);
        const srcs = dump.sources as { originalText: string; normalizedText: string }[];
        expect(srcs.every((s) => typeof s.originalText === "string" && s.originalText.length > 0)).toBe(true);

        const audit = await t.get("/api/audit?action=dump.exported");
        expect(audit.json<unknown[]>().length).toBeGreaterThan(0);
      },
      { seed: true },
    );
  });
});

describe("A15: audit covers accept/reject/supersession/export with before/after references", () => {
  it("every mutating review action leaves a before/after audit trail", async () => {
    await withApp(
      async (t) => {
        const proj = (await t.post("/api/projects", { name: "Audit Demo" })).json<{ id: string }>();
        await t.post("/api/imports/text", {
          text: "fact: audit trail statement one\nfact: audit trail statement two",
          adapterId: "faketest",
          projectId: proj.id,
        });
        const candidates = await getInboxCandidates(t, proj.id);
        const [c1, c2] = candidates as { id: string }[];
        await reviewCurrent(t, [c1!.id], "accept");
        await reviewCurrent(t, [c2!.id], "reject");

        const corr = await t.post("/api/corrections", {
          statement: "Audit trail statement one, corrected by the owner.",
          projectId: proj.id,
          supersedesRecordIds: [c1!.id],
        });
        const preview = corr.json<{ jobId: string }>();
        await t.post(`/api/corrections/${preview.jobId}/confirm`);
        await t.post("/api/handoffs", { projectId: proj.id });
        await t.get("/api/export/json");

        const audit = await t.get("/api/audit?limit=500");
        const events = audit.json<{
          action: string;
          targetId: string | null;
          beforeRef: string | null;
          afterRef: string | null;
        }[]>();
        const find = (action: string, targetId?: string) =>
          events.find((e) => e.action === action && (targetId === undefined || e.targetId === targetId));

        const accepted = find("record.accepted", c1!.id)!;
        expect(JSON.parse(accepted.beforeRef!).reviewStatus).toBe("proposed");
        expect(JSON.parse(accepted.afterRef!).reviewStatus).toBe("accepted");

        const rejected = find("record.rejected", c2!.id)!;
        expect(JSON.parse(rejected.beforeRef!).reviewStatus).toBe("proposed");
        expect(JSON.parse(rejected.afterRef!).reviewStatus).toBe("rejected");

        const superseded = find("record.superseded", c1!.id)!;
        expect(JSON.parse(superseded.beforeRef!).reviewStatus).toBe("accepted");
        expect(JSON.parse(superseded.afterRef!).reviewStatus).toBe("superseded");

        const superConfirmed = find("supersession.confirmed")!;
        expect(JSON.parse(superConfirmed.beforeRef!).confirmedAt).toBeNull();
        expect(JSON.parse(superConfirmed.afterRef!).confirmedAt).not.toBeNull();

        expect(find("handoff.exported")!.afterRef).toBeTruthy();
        expect(find("dump.exported")!.afterRef).toBeTruthy();
        expect(find("source.imported")!.afterRef).toBeTruthy();
        expect(find("correction.proposed")!.afterRef).toBeTruthy();
      },
      { seed: false },
    );
  });
});
