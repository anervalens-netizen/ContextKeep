import { describe, expect, it } from "vitest";
import type { BriefDto, ReviewResultDto } from "@contextkeep/shared";
import { expectStatus, getInboxCandidates, getProjectByName, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

async function createProject(t: TestApp, name: string): Promise<string> {
  const res = await t.post("/api/projects", { name });
  expectStatus(res, 200, `create project ${name}`);
  return res.json<{ id: string }>().id;
}

describe("A6: bulk accept of 100 records in one explicit action, atomic brief update", () => {
  it("accepts 100 proposed records in one transaction and the brief reflects all of them", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Bulk Project");
      const lines = Array.from({ length: 100 }, (_, i) => `fact: bulk acceptance item number ${i}`).join("\n");
      const imp = await t.post("/api/imports/text", {
        text: lines,
        adapterId: "faketest",
        projectId,
      });
      expectStatus(imp, 201, "import 100 facts");
      expect(imp.json<{ candidateCount: number }>().candidateCount).toBe(100);

      const candidates = await getInboxCandidates(t, projectId);
      expect(candidates.length).toBe(100);
      const ids = candidates.map((c) => c.id as string);
      const items = candidates.map((c) => ({ recordId: c.id as string, revision: c.revision as number }));

      const decide = await t.post("/api/inbox/decide", { items, action: "accept" });
      expectStatus(decide, 200, "bulk accept");
      const result = decide.json<ReviewResultDto>();
      expect(result.accepted.length).toBe(100);
      expect(result.blocked.length).toBe(0);

      // Brief atomically reflects all 100 accepted facts.
      const briefRes = await t.get(`/api/projects/${projectId}/brief`);
      expectStatus(briefRes, 200, "brief after bulk accept");
      const brief = briefRes.json<BriefDto>();
      expect(brief.facts.length).toBe(100);

      // Inbox is now empty for this project.
      const after = await getInboxCandidates(t, projectId);
      expect(after.length).toBe(0);

      // A15: every acceptance produced an audit event with before/after.
      const audit = await t.get("/api/audit?action=record.accepted&limit=500");
      const events = audit.json<{ targetId: string; beforeRef: string | null; afterRef: string | null }[]>();
      const relevant = events.filter((e) => ids.includes(e.targetId));
      expect(relevant.length).toBe(100);
      for (const e of relevant.slice(0, 5)) {
        expect(e.beforeRef).toBeTruthy();
        expect(e.afterRef).toBeTruthy();
        expect(JSON.parse(e.beforeRef!).reviewStatus).toBe("proposed");
        expect(JSON.parse(e.afterRef!).reviewStatus).toBe("accepted");
      }
    });
  });

  it("blocked items do not abort the rest of the batch but are reported", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Mixed Batch");
      const imp = await t.post("/api/imports/text", {
        text: "fact: first mixed item\nfact: second mixed item",
        adapterId: "faketest",
        projectId,
      });
      expectStatus(imp, 201, "import two");
      const candidates = await getInboxCandidates(t, projectId);
      const [c1, c2] = candidates as { id: string }[];

      // Accept c1 alone first.
      const first = await t.post("/api/inbox/decide", {
        items: [{ recordId: c1!.id, revision: (c1 as { revision: number }).revision }],
        action: "accept",
      });
      expectStatus(first, 200, "accept c1");
      expect(first.json<ReviewResultDto>().accepted).toEqual([c1!.id]);

      // Batch with current already-reviewed c1 + fresh c2 → c2 accepted, c1 blocked.
      const c1Current = (await t.get(`/api/records/${c1!.id}`)).json<{ revision: number }>();
      const mixed = await t.post("/api/inbox/decide", {
        items: [
          { recordId: c1!.id, revision: c1Current.revision },
          { recordId: c2!.id, revision: (c2 as { revision: number }).revision },
        ],
        action: "accept",
      });
      expectStatus(mixed, 200, "mixed batch");
      const r = mixed.json<ReviewResultDto>();
      expect(r.accepted).toEqual([c2!.id]);
      expect(r.blocked.length).toBe(1);
      expect(r.blocked[0]!.recordId).toBe(c1!.id);
      expect(r.blocked[0]!.code).toBe("already_reviewed");
    });
  });
});

describe("A22: 'agent reported done' never enters the brief until accepted", () => {
  it("proposed done-action stays out of the brief; acceptance of an open action shows it", async () => {
    await withApp(async (t) => {
      const dsh = await getProjectByName(t, "ExampleAssistant");
      const briefRes = await t.get(`/api/projects/${dsh.id}/brief`);
      expectStatus(briefRes, 200, "dsh brief");
      const brief = briefRes.json<BriefDto>();
      // All seeded ExampleAssistant records are proposals → brief has no actions, no facts.
      expect(brief.actions.length).toBe(0);
      expect(brief.facts.length).toBe(0);
      const allTexts = [...brief.actions, ...brief.facts].map((s) => s.record.text).join(" ");
      expect(allTexts).not.toMatch(/agent reported done/i);

      const candidates = await getInboxCandidates(t, dsh.id);
      expect(candidates.length).toBe(3);
      const doneReport = candidates.find((c) => (c.taskStatus as string) === "done")!;
      const openAction = candidates.find((c) => (c.taskStatus as string) === "open")!;

      // Accept only the open action.
      const decide = await t.post("/api/inbox/decide", {
        items: [{ recordId: openAction.id as string, revision: openAction.revision as number }],
        action: "accept",
      });
      expectStatus(decide, 200, "accept open action");

      const brief2 = (await t.get(`/api/projects/${dsh.id}/brief`)).json<BriefDto>();
      expect(brief2.actions.length).toBe(1);
      expect(brief2.actions[0]!.record.id).toBe(openAction.id);
      const texts2 = brief2.actions.map((s) => s.record.text).join(" ");
      expect(texts2).not.toMatch(/agent reported done/i);

      // The done report is still proposed and still absent.
      const recRes = await t.get(`/api/records/${doneReport.id as string}`);
      expect(recRes.json<{ reviewStatus: string }>().reviewStatus).toBe("proposed");

      // Accepting the done report moves it to accepted, but a completed task
      // is history, not a next action — the brief's action list stays about open work.
      const decide2 = await t.post("/api/inbox/decide", {
        items: [{ recordId: doneReport.id as string, revision: doneReport.revision as number }],
        action: "accept",
      });
      expectStatus(decide2, 200, "accept done report");
      const brief3 = (await t.get(`/api/projects/${dsh.id}/brief`)).json<BriefDto>();
      expect(brief3.actions.map((s) => s.record.id)).not.toContain(doneReport.id);
      const timeline = (await t.get(`/api/projects/${dsh.id}/timeline`)).json<{ entries: { record: { id: string; reviewStatus: string } }[] }>();
      const inTimeline = timeline.entries.find((e) => e.record.id === doneReport.id);
      expect(inTimeline?.record.reviewStatus).toBe("accepted");
    }, { seed: true });
  });
});

describe("reject + edit flows", () => {
  it("clears action-only taskStatus when a proposed action is edited into a non-action type", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Type Edit Project");
      const imported = await t.post("/api/imports/text", {
        text: "action: convert this candidate to a fact",
        adapterId: "faketest",
        projectId,
      });
      expectStatus(imported, 201, "import action");
      const [candidate] = await getInboxCandidates(t, projectId);
      expect(candidate?.type).toBe("action");
      expect(candidate?.taskStatus).toBe("open");

      const edited = await t.put("/api/records/" + (candidate!.id as string), {
        revision: candidate!.revision,
        type: "fact",
      });
      expectStatus(edited, 200, "edit action type");
      const updated = edited.json<{ type: string; taskStatus: string | null }>();
      expect(updated).toMatchObject({ type: "fact", taskStatus: null });
    });
  });

  it("rejects a proposal, and re-deciding it is blocked", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Reject Project");
      await t.post("/api/imports/text", {
        text: "fact: something we will not accept",
        adapterId: "faketest",
        projectId,
      });
      const candidates = await getInboxCandidates(t, projectId);
      const id = candidates[0]!.id as string;

      const rej = await t.post("/api/inbox/decide", {
        items: [{ recordId: id, revision: candidates[0]!.revision as number }],
        action: "reject",
      });
      expectStatus(rej, 200, "reject");
      expect(rej.json<ReviewResultDto>().rejected).toEqual([id]);

      const rejectedCurrent = (await t.get(`/api/records/${id}`)).json<{ revision: number }>();
      const again = await t.post("/api/inbox/decide", {
        items: [{ recordId: id, revision: rejectedCurrent.revision }],
        action: "accept",
      });
      const r = again.json<ReviewResultDto>();
      expect(r.accepted.length).toBe(0);
      expect(r.blocked[0]!.code).toBe("already_reviewed");

      const audit = await t.get("/api/audit?action=record.rejected");
      const events = audit.json<{ targetId: string; beforeRef: string; afterRef: string }[]>();
      const ev = events.find((e) => e.targetId === id)!;
      expect(JSON.parse(ev.beforeRef).reviewStatus).toBe("proposed");
      expect(JSON.parse(ev.afterRef).reviewStatus).toBe("rejected");
    });
  });

  it("accept-with-edit applies the edit; stale edits are rejected and reviewed semantic edits require correction", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Edit Project");
      await t.post("/api/imports/text", {
        text: "fact: rough draft wording",
        adapterId: "faketest",
        projectId,
      });
      const candidates = await getInboxCandidates(t, projectId);
      const c = candidates[0]!;

      const decide = await t.post("/api/inbox/decide", {
        items: [{ recordId: c.id as string, revision: c.revision as number }],
        action: "accept",
        edits: {
          [c.id as string]: { revision: c.revision as number, text: "polished wording (manual edit required)" },
        },
      });
      expectStatus(decide, 200, "accept with edit");
      const r = decide.json<ReviewResultDto>();
      expect(r.accepted).toEqual([c.id]);
      expect(r.edited).toEqual([c.id]);

      const updated = (await t.get(`/api/records/${c.id as string}`)).json<{ text: string; revision: number; reviewStatus: string }>();
      expect(updated.text).toBe("polished wording (manual edit required)");
      expect(updated.reviewStatus).toBe("accepted");
      expect(updated.revision).toBe((c.revision as number) + 1);

      // Stale edit is rejected before semantic immutability is evaluated.
      const stale = await t.put(`/api/records/${c.id as string}`, { revision: 1, text: "stale tab edit" });
      expectStatus(stale, 409, "stale revision");
      expect(stale.json<{ error: { code: string } }>().error.code).toBe("stale_revision");

      // Once accepted, semantic content is immutable in place: corrections keep
      // the prior truth and its evidence traceable instead of rewriting history.
      const semantic = await t.put(`/api/records/${c.id as string}`, {
        revision: updated.revision,
        text: "fresh semantic rewrite",
      });
      expectStatus(semantic, 409, "reviewed semantic edit");
      expect(semantic.json<{ error: { code: string } }>().error.code).toBe("semantic_edit_requires_correction");
      const unchanged = (await t.get(`/api/records/${c.id as string}`)).json<{ text: string; revision: number }>();
      expect(unchanged.text).toBe(updated.text);
      expect(unchanged.revision).toBe(updated.revision);
    });
  });

  it("rejects an edit whose revision does not match its selected review item", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Stale Bulk");
      await t.post("/api/imports/text", { text: "fact: bulk stale candidate", adapterId: "faketest", projectId });
      const candidates = await getInboxCandidates(t, projectId);
      const c = candidates[0]!;
      const decide = await t.post("/api/inbox/decide", {
        items: [{ recordId: c.id as string, revision: c.revision as number }],
        action: "accept",
        edits: { [c.id as string]: { revision: 99, text: "nope" } },
      });
      expectStatus(decide, 409, "edit/selection revision mismatch");
      expect(decide.json<{ error: { code: string } }>().error.code).toBe("review_edit_revision_mismatch");
      const current = (await t.get(`/api/records/${c.id as string}`)).json<{ reviewStatus: string; revision: number }>();
      expect(current).toMatchObject({ reviewStatus: "proposed", revision: c.revision as number });
    });
  });
});


describe("CK-A01: review decisions are bound to the revision the owner read", () => {
  for (const action of ["accept", "reject"] as const) {
    it(`refuses stale R1 -> R2 ${action} with zero review-side mutations`, async () => {
      await withApp(async (t) => {
        const projectId = await createProject(t, `Revision-safe ${action}`);
        await t.post("/api/imports/text", {
          text: `fact: revision-safe ${action} candidate`,
          adapterId: "faketest",
          projectId,
        });
        const [candidate] = await getInboxCandidates(t, projectId);
        const recordId = candidate!.id as string;
        const readRevision = candidate!.revision as number;

        // The owner read R1, but another tab changes the proposal to R2.
        const edit = await t.put(`/api/records/${recordId}`, {
          revision: readRevision,
          text: `fact: server-side R2 before stale ${action}`,
        });
        expectStatus(edit, 200, "advance proposal to R2");
        expect(edit.json<{ revision: number }>().revision).toBe(readRevision + 1);

        const sqlite = t.app.ck.deps.sqlite;
        const snapshot = () => ({
          record: sqlite.prepare(
            "SELECT review_status AS reviewStatus, revision, text FROM records WHERE id=?",
          ).get(recordId),
          evidenceCount: (sqlite.prepare(
            "SELECT count(*) AS n FROM record_evidence WHERE record_id=?",
          ).get(recordId) as { n: number }).n,
          auditCount: (sqlite.prepare(
            "SELECT count(*) AS n FROM audit_events WHERE target_type='record' AND target_id=?",
          ).get(recordId) as { n: number }).n,
          project: sqlite.prepare(
            "SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?",
          ).get(projectId),
        });
        const before = snapshot();

        // Hybrid payload intentionally carries the legacy field too. The
        // pre-remediation REST path ignores items and therefore demonstrates
        // the bug by deciding R2. The revision-safe contract must use items
        // and refuse the stale R1 decision atomically.
        const stale = await t.post("/api/inbox/decide", {
          recordIds: [recordId],
          items: [{ recordId, revision: readRevision }],
          action,
        });
        expectStatus(stale, 409, `stale ${action}`);
        expect(stale.json<{ error: { code: string } }>().error.code).toBe("stale_revision");
        expect(snapshot()).toEqual(before);
      });
    });
  }

  it("aborts a mixed current/stale batch before any review mutation", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Revision-safe mixed batch");
      await t.post("/api/imports/text", {
        text: "fact: current member\nfact: stale member",
        adapterId: "faketest",
        projectId,
      });
      const candidates = await getInboxCandidates(t, projectId);
      const [a, b] = candidates;
      const staleRevision = b!.revision as number;
      expectStatus(
        await t.put(`/api/records/${b!.id as string}`, {
          revision: staleRevision,
          text: "fact: stale member advanced to R2",
        }),
        200,
        "advance one batch member",
      );

      const sqlite = t.app.ck.deps.sqlite;
      const snapshot = () => ({
        records: sqlite.prepare(
          "SELECT id, review_status AS reviewStatus, revision FROM records WHERE id IN (?, ?) ORDER BY id",
        ).all(a!.id, b!.id),
        reviewAudits: (sqlite.prepare(
          "SELECT count(*) AS n FROM audit_events WHERE target_type='record' AND target_id IN (?, ?) AND action IN ('record.accepted','record.rejected')",
        ).get(a!.id, b!.id) as { n: number }).n,
        project: sqlite.prepare(
          "SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?",
        ).get(projectId),
      });
      const before = snapshot();

      const decide = await t.post("/api/inbox/decide", {
        items: [
          { recordId: a!.id as string, revision: a!.revision as number },
          { recordId: b!.id as string, revision: staleRevision },
        ],
        action: "accept",
      });
      expectStatus(decide, 409, "mixed stale batch");
      expect(decide.json<{ error: { code: string } }>().error.code).toBe("stale_revision");
      expect(snapshot()).toEqual(before);
    });
  });

  it("rejects contradictory duplicate revisions and missing targets before mutation", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Revision-safe malformed batch");
      await t.post("/api/imports/text", {
        text: "fact: duplicate-revision candidate",
        adapterId: "faketest",
        projectId,
      });
      const [candidate] = await getInboxCandidates(t, projectId);
      const recordId = candidate!.id as string;
      const revision = candidate!.revision as number;
      const before = (await t.get(`/api/records/${recordId}`)).json<{ reviewStatus: string; revision: number }>();

      const duplicate = await t.post("/api/inbox/decide", {
        items: [
          { recordId, revision },
          { recordId, revision: revision + 1 },
        ],
        action: "reject",
      });
      expectStatus(duplicate, 409, "contradictory duplicate revisions");
      expect(duplicate.json<{ error: { code: string } }>().error.code).toBe("review_revision_conflict");
      expect((await t.get(`/api/records/${recordId}`)).json()).toMatchObject(before);

      const missing = await t.post("/api/inbox/decide", {
        items: [{ recordId: "00000000-0000-4000-8000-000000000099", revision: 1 }],
        action: "accept",
      });
      expectStatus(missing, 404, "missing review target");
      expect(missing.json<{ error: { code: string } }>().error.code).toBe("record_not_found");
      expect((await t.get(`/api/records/${recordId}`)).json()).toMatchObject(before);
    });
  });

  it("fails an old recordIds-only tab with an intelligible revision-required error", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Legacy review tab");
      await t.post("/api/imports/text", {
        text: "fact: legacy tab must reload",
        adapterId: "faketest",
        projectId,
      });
      const [candidate] = await getInboxCandidates(t, projectId);
      const legacy = await t.post("/api/inbox/decide", {
        recordIds: [candidate!.id as string],
        action: "accept",
      });
      expectStatus(legacy, 409, "legacy review payload");
      const error = legacy.json<{ error: { code: string; message: string } }>().error;
      expect(error.code).toBe("review_revision_required");
      expect(error.message).toMatch(/reload.*decide again/i);
      const current = (await t.get(`/api/records/${candidate!.id as string}`)).json<{ reviewStatus: string; revision: number }>();
      expect(current).toMatchObject({ reviewStatus: "proposed", revision: candidate!.revision as number });
    });
  });
});

describe("project revision: stale-edit rejection on PATCH", () => {
  it("rejects a stale project revision and accepts a fresh one", async () => {
    await withApp(async (t) => {
      const projectId = await createProject(t, "Revision Project");
      const stale = await t.patch(`/api/projects/${projectId}`, { revision: 42, description: "from another tab" });
      expectStatus(stale, 409, "stale project revision");
      expect(stale.json<{ error: { code: string } }>().error.code).toBe("stale_revision");

      const fresh = await t.patch(`/api/projects/${projectId}`, { revision: 1, description: "fresh description" });
      expectStatus(fresh, 200, "fresh project revision");
      const dto = fresh.json<{ revision: number; description: string }>();
      expect(dto.revision).toBe(2);
      expect(dto.description).toBe("fresh description");
    });
  });
});
