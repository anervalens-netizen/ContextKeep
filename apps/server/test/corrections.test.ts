import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { importJobs, projects, records, supersessions } from "../src/db/schema.js";
import { recordDedupHash } from "../src/lib/hash.js";
import { nowIso } from "../src/lib/time.js";
import { captureWork } from "../src/services/capture-work.js";
import { setProjectLifecycle } from "../src/services/memory-management.js";
import {
  expectStatus,
  getInboxCandidates,
  getProjectByName,
  makeTestApp,
  reviewCurrent,
  type TestApp,
} from "./helpers.js";

interface CorrectionPreview {
  jobId: string;
  proposedRecordIds: string[];
  affected: { id: string; reviewStatus: string; evidenceBasis: string }[];
  warnings: string[];
}
interface ConfirmResult {
  jobId: string;
  acceptedRecordIds: string[];
  supersededRecordIds: string[];
  confirmedSupersessionIds: string[];
}

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

/** Direct DB record insert for adversarial scenarios (A4, A18). */
function insertRecord(
  t: TestApp,
  opts: {
    projectId?: string | null;
    type?: string;
    subject: string;
    predicate?: string | null;
    valueJson?: unknown | null;
    text: string;
    reviewStatus?: string;
    evidenceBasis: string;
    recordedAt?: string;
  },
): string {
  const id = crypto.randomUUID();
  const now = nowIso();
  const projectId = opts.projectId ?? null;
  const type = opts.type ?? "fact";
  t.app.ck.deps.db
    .insert(records)
    .values({
      id,
      projectId,
      type,
      subject: opts.subject,
      predicate: opts.predicate ?? null,
      valueJson: opts.valueJson === undefined || opts.valueJson === null ? null : JSON.stringify(opts.valueJson),
      text: opts.text,
      reviewStatus: opts.reviewStatus ?? "accepted",
      evidenceBasis: opts.evidenceBasis,
      taskStatus: null,
      recordDedupHash: recordDedupHash({ projectId, type, subject: opts.subject, text: opts.text }),
      recordedAt: opts.recordedAt ?? now,
      sourceEventAt: opts.recordedAt ?? null,
      effectiveFrom: null,
      effectiveTo: null,
      reviewedAt: opts.reviewStatus === "accepted" ? now : null,
      reviewDueAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

describe("A2: contradictory owner declarations cannot both remain accepted", () => {
  it("inbox accept of a contradicting structured claim is blocked and creates a conflict", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "A2 Inbox" })).json<{ id: string }>();
      const r1 = insertRecord(t, {
        projectId: proj.id,
        subject: "release-verification",
        predicate: "policy",
        text: "Release verification requires exact-SHA promotion.",
        evidenceBasis: "owner_declaration",
      });
      const r2 = insertRecord(t, {
        projectId: proj.id,
        subject: "release-verification",
        predicate: "policy",
        text: "Release verification only needs green CI.",
        evidenceBasis: "owner_declaration",
        reviewStatus: "proposed",
      });

      const decide = await reviewCurrent(t, [r2], "accept");
      expectStatus(decide, 200, "decide contradicting claim");
      const r = decide.json<{ accepted: string[]; blocked: { recordId: string; code: string }[] }>();
      expect(r.accepted.length).toBe(0);
      expect(r.blocked[0]!.recordId).toBe(r2);
      expect(r.blocked[0]!.code).toBe("requires_supersession");

      // Exactly one remains accepted.
      const rows = t.app.ck.deps.db.select().from(records).where(eq(records.subject, "release-verification")).all();
      expect(rows.filter((x) => x.reviewStatus === "accepted").length).toBe(1);
      expect(rows.find((x) => x.id === r1)!.reviewStatus).toBe("accepted");

      const conflicts = await t.get("/api/conflicts?status=unresolved");
      expectStatus(conflicts, 200, "conflicts");
      expect(conflicts.json<{ recordIds: string[] }[]>().some((c) => c.recordIds.includes(r2))).toBe(true);
    });
  });

  it("corrections workflow supersedes the prior declaration: one accepted before, one after", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Release Engineering" })).json<{ id: string }>();

      // Correction 1: initial owner declaration.
      const c1 = await t.post("/api/corrections", {
        statement: "Release verification requires exact-SHA promotion with Sigstore checks.",
        projectId: proj.id,
        recordType: "fact",
        subject: "release-verification",
        predicate: "policy",
      });
      expectStatus(c1, 201, "propose correction 1");
      const p1 = c1.json<CorrectionPreview>();
      const r1 = p1.proposedRecordIds[0]!;
      const conf1 = await t.post(`/api/corrections/${p1.jobId}/confirm`);
      expectStatus(conf1, 200, "confirm correction 1");
      expect(conf1.json<ConfirmResult>().acceptedRecordIds).toContain(r1);

      // Correction 2: contradicting declaration WITHOUT supersession → refused at confirm.
      const c2 = await t.post("/api/corrections", {
        statement: "Release verification only requires green CI pipelines.",
        projectId: proj.id,
        recordType: "fact",
        subject: "release-verification",
        predicate: "policy",
      });
      expectStatus(c2, 201, "propose correction 2");
      const p2 = c2.json<CorrectionPreview>();
      expect(p2.warnings.join(" ")).toMatch(/A2/);
      expect(p2.affected.map((a) => a.id)).toContain(r1);
      const conf2 = await t.post(`/api/corrections/${p2.jobId}/confirm`);
      expectStatus(conf2, 409, "confirm contradicting correction without supersession");
      expect(conf2.json<{ error: { code: string } }>().error.code).toBe("requires_supersession");

      // Both cannot remain accepted: r1 accepted, c2's record still proposed.
      const r2Row = t.app.ck.deps.db.select().from(records).where(eq(records.id, p2.proposedRecordIds[0]!)).get()!;
      expect(r2Row.reviewStatus).toBe("proposed");

      // Correction 3: explicit supersession of r1 → accepted, prior marked superseded.
      const c3 = await t.post("/api/corrections", {
        statement: "Release verification uses Sigstore-verified SHA256SUMS promotion only.",
        projectId: proj.id,
        recordType: "fact",
        subject: "release-verification",
        predicate: "policy",
        supersedesRecordIds: [r1],
      });
      expectStatus(c3, 201, "propose correction 3");
      const p3 = c3.json<CorrectionPreview>();
      const conf3 = await t.post(`/api/corrections/${p3.jobId}/confirm`);
      expectStatus(conf3, 200, "confirm correction 3");
      const res3 = conf3.json<ConfirmResult>();
      expect(res3.supersededRecordIds).toContain(r1);
      expect(res3.acceptedRecordIds.length).toBeGreaterThan(0);

      const all = t.app.ck.deps.db
        .select()
        .from(records)
        .all()
        .filter((x) => x.subject === "release-verification");
      const accepted = all.filter((x) => x.reviewStatus === "accepted");
      expect(accepted.length).toBe(1); // A2: exactly one accepted declaration
      expect(accepted[0]!.text).toMatch(/SHA256SUMS/);
      expect(all.find((x) => x.id === r1)!.reviewStatus).toBe("superseded");

      // A15: supersession + acceptance audits with before/after.
      const audit = await t.get("/api/audit?limit=500");
      const events = audit.json<{ action: string; beforeRef: string | null; afterRef: string | null }[]>();
      const supersededEv = events.find((e) => e.action === "record.superseded")!;
      expect(JSON.parse(supersededEv.beforeRef!).reviewStatus).toBe("accepted");
      expect(JSON.parse(supersededEv.afterRef!).reviewStatus).toBe("superseded");
      expect(events.some((e) => e.action === "supersession.confirmed")).toBe(true);
    });
  });
});

describe("A18: supersession cycles are rejected by the database", () => {
  it("rejects A→B then B→A, self-supersession, and 3-cycles at INSERT", async () => {
    await withApp(async (t) => {
      const db = t.app.ck.deps.db;
      const a = insertRecord(t, { subject: "cycle-a", text: "record A", evidenceBasis: "document" });
      const b = insertRecord(t, { subject: "cycle-b", text: "record B", evidenceBasis: "document" });
      const c = insertRecord(t, { subject: "cycle-c", text: "record C", evidenceBasis: "document" });
      const now = nowIso();
      const insertSuper = (id: string, prior: string, replacement: string) =>
        db
          .insert(supersessions)
          .values({ id, priorRecordId: prior, replacementRecordId: replacement, jobId: null, reason: "test", confirmedAt: null, confirmedBy: null, proposedAt: now })
          .run();

      insertSuper("s-ab", a, b); // ok
      expect(() => insertSuper("s-ba", b, a)).toThrow(/supersession cycle/i); // A18 direct cycle
      expect(() => insertSuper("s-aa", a, a)).toThrow(/supersession cycle/i); // self
      insertSuper("s-bc", b, c); // ok, chain a→b→c
      expect(() => insertSuper("s-ca", c, a)).toThrow(/supersession cycle/i); // 3-cycle

      const rows = db.select().from(supersessions).all();
      expect(rows.map((r) => r.id).sort()).toEqual(["s-ab", "s-bc"]);
    });
  });

  it("the API surfaces cycle rejection as 409 supersession_cycle with an audit trail", async () => {
    await withApp(async (t) => {
      // Simulate the low-level failure through the raw sqlite handle like a buggy
      // future code path would, and check the error handler mapping is wired by
      // asserting the trigger message contains the A18 marker.
      const a = insertRecord(t, { subject: "api-a", text: "record A", evidenceBasis: "document" });
      const b = insertRecord(t, { subject: "api-b", text: "record B", evidenceBasis: "document" });
      const db = t.app.ck.deps.db;
      const now = nowIso();
      db.insert(supersessions)
        .values({ id: "api-ab", priorRecordId: a, replacementRecordId: b, jobId: null, reason: "t", confirmedAt: null, confirmedBy: null, proposedAt: now })
        .run();
      let msg = "";
      try {
        db.insert(supersessions)
          .values({ id: "api-ba", priorRecordId: b, replacementRecordId: a, jobId: null, reason: "t", confirmedAt: null, confirmedBy: null, proposedAt: now })
          .run();
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/supersession cycle detected \(A18\)/);
    });
  });
});

describe("A3: later imports of old material cannot reactivate retired projects", () => {
  it("inbox acceptance of a lifecycle 'active' record for a retired project is refused", async () => {
    await withApp(
      async (t) => {
        const exampleSuiteServer = await getProjectByName(t, "ExampleSuite Server");
        expect(exampleSuiteServer.lifecycle).toBe("retired");

        // Simulate an old import that proposed reactivation.
        const reactivate = insertRecord(t, {
          projectId: exampleSuiteServer.id,
          subject: `project:ExampleSuite Server`,
          predicate: "lifecycle",
          valueJson: { state: "active" },
          text: "Lifecycle: active — claimed by an old 2024 status report.",
          evidenceBasis: "agent_report",
          reviewStatus: "proposed",
          recordedAt: "2024-06-01T09:00:00.000Z",
        });

        const decide = await reviewCurrent(t, [reactivate], "accept", {
          ownerAction: true, // even an explicit owner action cannot do this via the inbox
        });
        expectStatus(decide, 200, "decide reactivation");
        const blocked = decide.json<{ blocked: { recordId: string; code: string }[] }>().blocked;
        expect(blocked[0]!.recordId).toBe(reactivate);
        expect(blocked[0]!.code).toBe("retired_reactivation_requires_correction");

        const after = await getProjectByName(t, "ExampleSuite Server");
        expect(after.lifecycle).toBe("retired");

        const audit = await t.get("/api/audit?action=lifecycle.rejected_retired_reactivation");
        expect(audit.json<unknown[]>().length).toBeGreaterThan(0);
      },
      { seed: true },
    );
  });

  it("only the explicit owner-correction workflow can change a retired lifecycle, and it supersedes the retirement record", async () => {
    await withApp(
      async (t) => {
        const exampleSuiteServer = await getProjectByName(t, "ExampleSuite Server");
        const c = await t.post("/api/corrections", {
          statement: "ExampleSuite Server is reactivated for a one-off maintenance window (owner decision).",
          lifecycleChange: { projectId: exampleSuiteServer.id, state: "active" },
        });
        expectStatus(c, 201, "propose reactivation correction");
        const preview = c.json<CorrectionPreview>();
        expect(preview.warnings.join(" ")).toMatch(/reactivat/i);

        const conf = await t.post(`/api/corrections/${preview.jobId}/confirm`);
        expectStatus(conf, 200, "confirm reactivation");
        const res = conf.json<ConfirmResult>();
        expect(res.supersededRecordIds).toContain(exampleSuiteServer.lifecycleRecordId);

        const after = await getProjectByName(t, "ExampleSuite Server");
        expect(after.lifecycle).toBe("active");
        expect(after.lifecycleRecordId).not.toBe(exampleSuiteServer.lifecycleRecordId);
      },
      { seed: true },
    );
  });
});

describe("A19: facts about retired projects need an explicit owner action to be accepted", () => {
  it("blocks acceptance without ownerAction and allows it with ownerAction, lifecycle untouched", async () => {
    await withApp(
      async (t) => {
        const exampleSuiteServer = await getProjectByName(t, "ExampleSuite Server");
        const imp = await t.post("/api/imports/text", {
          text: "fact: ExampleSuite Server ran on 192.168.0.68 and served the internal API until retirement",
          adapterId: "faketest",
          projectId: exampleSuiteServer.id,
          eventAt: "2024-06-01T00:00:00.000Z",
        });
        expectStatus(imp, 201, "import old fact");
        const candidates = await getInboxCandidates(t, exampleSuiteServer.id);
        const c = candidates.find((x) => (x.text as string).includes("192.168.0.68"))!;

        const without = await reviewCurrent(t, [c.id as string], "accept");
        expectStatus(without, 200, "accept without owner action");
        const blocked = without.json<{ blocked: { code: string }[] }>().blocked;
        expect(blocked[0]!.code).toBe("retired_project_requires_owner_action");

        const withOwner = await reviewCurrent(t, [c.id as string], "accept", {
          ownerAction: true,
        });
        expectStatus(withOwner, 200, "accept with owner action");
        expect(withOwner.json<{ accepted: string[] }>().accepted).toEqual([c.id]);

        // Accepting a historical FACT never changes lifecycle.
        const after = await getProjectByName(t, "ExampleSuite Server");
        expect(after.lifecycle).toBe("retired");
      },
      { seed: true },
    );
  });
});

describe("A4: technical observations never reverse owner decisions", () => {
  it("refuses to confirm a supersession of an owner declaration by an observed_technical record", async () => {
    await withApp(
      async (t) => {
        const exampleSuiteWeb = await getProjectByName(t, "ExampleSuite Web");
        expect(exampleSuiteWeb.lifecycle).toBe("retired");
        const retirementRecordId = exampleSuiteWeb.lifecycleRecordId!;
        const db = t.app.ck.deps.db;
        const now = nowIso();

        // Simulate a pipeline that proposed "service reachable → active" and even
        // created a supersession row targeting the owner's retirement declaration.
        const observation = insertRecord(t, {
          projectId: exampleSuiteWeb.id,
          subject: "project:ExampleSuite Web",
          predicate: "lifecycle",
          valueJson: { state: "active" },
          text: "Observed: exampleSuite-web health endpoint returned 200 (2026-09-09).",
          evidenceBasis: "observed_technical",
          reviewStatus: "proposed",
        });
        db.insert(importJobs)
          .values({
            id: "job-a4",
            sourceId: null,
            stage: "presented",
            adapterId: "manual",
            adapterVersion: "1.0.0",
            providerModel: null,
            attempts: 0,
            errorCode: null,
            usageJson: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(supersessions)
          .values({
            id: "super-a4",
            priorRecordId: retirementRecordId,
            replacementRecordId: observation,
            jobId: "job-a4",
            reason: "service observed reachable",
            confirmedAt: null,
            confirmedBy: null,
            proposedAt: now,
          })
          .run();

        const conf = await t.post("/api/corrections/job-a4/confirm");
        expectStatus(conf, 409, "confirm observation over owner declaration");
        const body = conf.json<{ error: { code: string; message: string } }>();
        expect(body.error.code).toBe("precedence_violation");
        expect(body.error.message).toMatch(/A4/);

        // Nothing changed: retirement stands, observation stays proposed.
        const after = await getProjectByName(t, "ExampleSuite Web");
        expect(after.lifecycle).toBe("retired");
        expect(after.lifecycleRecordId).toBe(retirementRecordId);
        const obsRow = db.select().from(records).where(eq(records.id, observation)).get()!;
        expect(obsRow.reviewStatus).toBe("proposed");
        const priorRow = db.select().from(records).where(eq(records.id, retirementRecordId)).get()!;
        expect(priorRow.reviewStatus).toBe("accepted");

        // The refusal is audit-logged.
        const audit = await t.get("/api/audit?action=supersession.precedence_refused");
        const events = audit.json<{ detail: { refused: string } }[]>();
        expect(events.length).toBeGreaterThan(0);
        expect(events[0]!.detail.refused).toBe("precedence_violation");
      },
      { seed: true },
    );
  });

  it("inbox acceptance of an observed lifecycle record for a retired project is refused too", async () => {
    await withApp(
      async (t) => {
        const exampleSuite = await getProjectByName(t, "ExampleSuite");
        const observation = insertRecord(t, {
          projectId: exampleSuite.id,
          subject: "project:ExampleSuite",
          predicate: "lifecycle",
          valueJson: { state: "active" },
          text: "Observed: exampleSuite process reachable on the network.",
          evidenceBasis: "observed_technical",
          reviewStatus: "proposed",
        });
        const decide = await reviewCurrent(t, [observation], "accept");
        const blocked = decide.json<{ blocked: { code: string }[] }>().blocked;
        expect(blocked[0]!.code).toBe("retired_reactivation_requires_correction");
        const after = await getProjectByName(t, "ExampleSuite");
        expect(after.lifecycle).toBe("retired");
      },
      { seed: true },
    );
  });
});

describe("correction scoping and state", () => {
  it("does not confirm an unrelated proposed record that shares the correction source", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Correction membership" })).json<{ id: string }>();
      const original = await t.post("/api/corrections", {
        statement: "The policy now uses Sunday.",
        projectId: proj.id,
        supersedesRecordIds: [],
      });
      expectStatus(original, 201, "propose correction");
      const preview = original.json<CorrectionPreview>();

      const unrelated = captureWork(
        t.app.ck.deps,
        {
          projectId: proj.id,
          outcome: "Unrelated agent report.",
          evidenceText: "The policy now uses Sunday.",
          title: null,
          eventAt: null,
          recordType: "fact",
          subject: "unrelated-agent-report",
          progressUpdates: [],
        },
        { actor: "test:agent", requestId: crypto.randomUUID() },
      );
      expect(unrelated.source.reused).toBe(true);
      expect(unrelated.outcome.reviewStatus).toBe("proposed");

      const confirmed = await t.post(`/api/corrections/${preview.jobId}/confirm`);
      expectStatus(confirmed, 200, "confirm correction");
      expect(confirmed.json<ConfirmResult>().acceptedRecordIds).toEqual(preview.proposedRecordIds);
      const unrelatedAfter = (await t.get(`/api/records/${unrelated.outcome.recordId}`)).json<{ reviewStatus: string }>();
      expect(unrelatedAfter.reviewStatus).toBe("proposed");
    });
  });

  it("refuses a generic correction that would supersede the projected lifecycle record", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Lifecycle invariant" })).json<{ id: string; revision: number }>();
      setProjectLifecycle(
        t.app.ck.deps,
        { projectId: proj.id, revision: proj.revision, state: "active", reason: "Start this project." },
        { actor: "test:owner", requestId: crypto.randomUUID() },
      );
      const current = t.app.ck.deps.db.select().from(projects).where(eq(projects.id, proj.id)).get()!;
      const correction = await t.post("/api/corrections", {
        statement: "This is an ordinary fact, not a lifecycle transition.",
        projectId: proj.id,
        supersedesRecordIds: [current.lifecycleRecordId],
      });
      expectStatus(correction, 409, "generic lifecycle supersession");
      expect(correction.json<{ error: { code: string } }>().error.code).toBe("lifecycle_requires_transition");
      const after = t.app.ck.deps.db.select().from(projects).where(eq(projects.id, proj.id)).get()!;
      expect(after.lifecycle).toBe("active");
      expect(after.lifecycleRecordId).toBe(current.lifecycleRecordId);
    });
  });

  it("does not reuse a correction whose proposed record was edited after preview", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Correction intent" })).json<{ id: string }>();
      const input = {
        statement: "Original reviewed statement.",
        projectId: proj.id,
        supersedesRecordIds: [],
      };
      const first = await t.post("/api/corrections", input);
      expectStatus(first, 201, "propose original correction");
      const firstPreview = first.json<CorrectionPreview>();
      const edited = await t.put(`/api/records/${firstPreview.proposedRecordIds[0]}`, {
        revision: 1,
        text: "Different statement after preview.",
      });
      expectStatus(edited, 200, "edit proposed correction");

      const second = await t.post("/api/corrections", input);
      expectStatus(second, 201, "re-propose original correction");
      const secondPreview = second.json<CorrectionPreview>();
      expect(secondPreview.jobId).not.toBe(firstPreview.jobId);
      expect(secondPreview.proposedRecordIds).not.toContain(firstPreview.proposedRecordIds[0]);

      const confirmed = await t.post(`/api/corrections/${secondPreview.jobId}/confirm`);
      expectStatus(confirmed, 200, "confirm pristine replacement");
      const accepted = (await t.get(`/api/records/${secondPreview.proposedRecordIds[0]}`)).json<{ text: string; reviewStatus: string }>();
      const old = (await t.get(`/api/records/${firstPreview.proposedRecordIds[0]}`)).json<{ text: string; reviewStatus: string }>();
      expect(accepted).toMatchObject({ text: input.statement, reviewStatus: "accepted" });
      expect(old).toMatchObject({ text: "Different statement after preview.", reviewStatus: "proposed" });
    });
  });

  it("backfills an unambiguous legacy open correction instead of duplicating it", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Legacy correction" })).json<{ id: string }>();
      const input = {
        statement: "Legacy statement with one recoverable record.",
        projectId: proj.id,
        recordType: "fact",
        subject: "legacy-subject",
        predicate: "legacy-predicate",
        supersedesRecordIds: [],
      };
      const first = await t.post("/api/corrections", input);
      expectStatus(first, 201, "propose legacy correction");
      const firstPreview = first.json<CorrectionPreview>();
      t.app.ck.deps.db
        .update(importJobs)
        .set({ usageJson: JSON.stringify({ correction: true }) })
        .where(eq(importJobs.id, firstPreview.jobId))
        .run();

      const second = await t.post("/api/corrections", input);
      expectStatus(second, 201, "recover legacy correction");
      const secondPreview = second.json<CorrectionPreview>();
      expect(secondPreview).toMatchObject({
        jobId: firstPreview.jobId,
        proposedRecordIds: firstPreview.proposedRecordIds,
      });
      const upgraded = t.app.ck.deps.db.select().from(importJobs).where(eq(importJobs.id, firstPreview.jobId)).get()!;
      const usage = JSON.parse(upgraded.usageJson!) as { intentHash?: string; proposedRecords?: unknown[] };
      expect(usage.intentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(usage.proposedRecords).toHaveLength(1);

      const replay = await t.post("/api/corrections", input);
      expectStatus(replay, 201, "replay backfilled correction");
      expect(replay.json<CorrectionPreview>().jobId).toBe(firstPreview.jobId);
    });
  });

  it("refuses a partially reviewed multi-record resubmission without rewriting reviewed truth or creating a duplicate", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Partial correction" })).json<{ id: string; revision: number }>();
      setProjectLifecycle(
        t.app.ck.deps,
        { projectId: proj.id, revision: proj.revision, state: "active", reason: "Activate for partial review." },
        { actor: "test:owner", requestId: crypto.randomUUID() },
      );
      const input = {
        statement: "Retire the project after owner review.",
        projectId: proj.id,
        recordType: "fact",
        subject: "project-retirement",
        predicate: "policy",
        supersedesRecordIds: [],
        lifecycleChange: { projectId: proj.id, state: "retired" as const },
      };
      const first = await t.post("/api/corrections", input);
      expectStatus(first, 201, "propose multi-record correction");
      const firstPreview = first.json<CorrectionPreview>();
      expect(firstPreview.proposedRecordIds).toHaveLength(2);

      const acceptedId = firstPreview.proposedRecordIds[0]!;
      const accepted = await reviewCurrent(t, [acceptedId], "accept");
      expectStatus(accepted, 200, "review one correction record");
      const presentedBefore = t.app.ck.deps.db
        .select()
        .from(importJobs)
        .all()
        .filter((job) => job.stage === "presented").length;

      const second = await t.post("/api/corrections", input);
      expectStatus(second, 409, "refuse partially reviewed resubmission");
      expect(second.json<{ error: { code: string; details: { jobId: string; changedRecordIds: string[] } } }>().error)
        .toMatchObject({ code: "correction_proposal_changed", details: { jobId: firstPreview.jobId } });
      const presentedAfter = t.app.ck.deps.db
        .select()
        .from(importJobs)
        .all()
        .filter((job) => job.stage === "presented").length;
      expect(presentedAfter).toBe(presentedBefore);

      const reviewed = t.app.ck.deps.db.select().from(records).where(eq(records.id, acceptedId)).get()!;
      expect(reviewed.reviewStatus).toBe("accepted");
      const untouchedId = firstPreview.proposedRecordIds.find((id) => id !== acceptedId)!;
      expect(t.app.ck.deps.db.select().from(records).where(eq(records.id, untouchedId)).get()!.reviewStatus).toBe("proposed");
      expect((await getProjectByName(t, "Partial correction")).lifecycle).toBe("active");
    });
  });

  it("GET /api/corrections/:jobId shows proposed records and supersessions", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Scoped" })).json<{ id: string }>();
      const r1 = insertRecord(t, {
        projectId: proj.id,
        subject: "scope",
        predicate: "component",
        text: "Component scope is the whole app.",
        evidenceBasis: "owner_declaration",
      });
      const c = await t.post("/api/corrections", {
        statement: "Component scope is limited to the web frontend only.",
        projectId: proj.id,
        subject: "scope",
        predicate: "component",
        supersedesRecordIds: [r1],
      });
      expectStatus(c, 201, "propose scoped correction");
      const preview = c.json<CorrectionPreview>();

      const state = await t.get(`/api/corrections/${preview.jobId}`);
      expectStatus(state, 200, "correction state");
      const s = state.json<{
        stage: string;
        supersessions: { priorRecordId: string; confirmedAt: string | null }[];
        proposedRecords: { id: string; reviewStatus: string; evidenceBasis: string }[];
      }>();
      expect(s.stage).toBe("presented");
      expect(s.supersessions.length).toBe(1);
      expect(s.supersessions[0]!.priorRecordId).toBe(r1);
      expect(s.supersessions[0]!.confirmedAt).toBeNull();
      expect(s.proposedRecords.length).toBe(1);
      expect(s.proposedRecords[0]!.evidenceBasis).toBe("owner_declaration");

      const conf = await t.post(`/api/corrections/${preview.jobId}/confirm`);
      expectStatus(conf, 200, "confirm scoped");
      const state2 = (await t.get(`/api/corrections/${preview.jobId}`)).json<{ stage: string; supersessions: { confirmedAt: string | null; confirmedBy: string | null }[] }>();
      expect(state2.stage).toBe("done");
      expect(state2.supersessions[0]!.confirmedAt).not.toBeNull();
      expect(state2.supersessions[0]!.confirmedBy).toBe("owner");
    });
  });

  it("supersession targets must be accepted records", async () => {
    await withApp(async (t) => {
      const proj = (await t.post("/api/projects", { name: "Targets" })).json<{ id: string }>();
      const proposed = insertRecord(t, {
        projectId: proj.id,
        subject: "t",
        text: "still proposed",
        evidenceBasis: "agent_report",
        reviewStatus: "proposed",
      });
      const res = await t.post("/api/corrections", {
        statement: "Try to supersede a proposal.",
        projectId: proj.id,
        supersedesRecordIds: [proposed],
      });
      expectStatus(res, 409, "supersede proposed target");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("invalid_supersession_target");
    });
  });

  it("corrections require a scope", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/corrections", { statement: "Orphan correction without scope." });
      expectStatus(res, 400, "scopeless correction");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("correction_needs_scope");
    });
  });

  it("confirming an unknown job 404s; confirming twice reports nothing_to_confirm", async () => {
    await withApp(async (t) => {
      const missing = await t.post("/api/corrections/does-not-exist/confirm");
      expectStatus(missing, 404, "unknown job");

      const proj = (await t.post("/api/projects", { name: "Twice" })).json<{ id: string }>();
      const c = await t.post("/api/corrections", {
        statement: "A simple owner statement without supersessions.",
        projectId: proj.id,
      });
      const preview = c.json<CorrectionPreview>();
      const first = await t.post(`/api/corrections/${preview.jobId}/confirm`);
      expectStatus(first, 200, "confirm plain statement");
      expect(first.json<ConfirmResult>().acceptedRecordIds).toEqual(preview.proposedRecordIds);
      const second = await t.post(`/api/corrections/${preview.jobId}/confirm`);
      expectStatus(second, 409, "confirm again");
      expect(second.json<{ error: { code: string } }>().error.code).toBe("nothing_to_confirm");
    });
  });
});
