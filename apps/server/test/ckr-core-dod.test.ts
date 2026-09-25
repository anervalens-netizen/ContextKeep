import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildSearchProfile } from "../src/services/search.js";
import { parseWorkingCheckpoint } from "../src/services/checkpoint.js";
import { reviewOverdue } from "../src/services/memory-freshness.js";
import { createRecord } from "../src/services/memory-management.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];
afterEach(async () => { for (const t of tracked.splice(0)) await t.cleanup(); });

async function setup(name: string) {
  const t = await makeTestApp({
    mcpToken: TOKEN,
    mcpDefaultClientId: "chatgpt",
    mcpDelegateWorkingMemory: true,
    adapters: "manual,faketest",
  });
  tracked.push(t);
  const p = await t.post("/api/projects", { name });
  expect(p.statusCode).toBe(200);
  return { t, projectId: p.json<{ id: string }>().id };
}

async function invoke(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  return body.result as { isError?: boolean; structuredContent: any };
}
async function ok(t: TestApp, name: string, args: Record<string, unknown>) {
  const r = await invoke(t, name, args);
  expect(r.isError, JSON.stringify(r.structuredContent)).not.toBe(true);
  return r.structuredContent;
}

describe("CKR core Definition of Done edge cases", () => {
  it("keeps structural fields exact for every declared work-context budget", async () => {
    const { t, projectId } = await setup("CKR budget matrix");
    const capture = await ok(t, "capture_working_memory", {
      projectId,
      outcome: "Unicode payload țară 日本語 with enough prose " + "x".repeat(3000),
      subject: "budget-checkpoint",
      checkpoint: {
        summary: "Rezumat țară 日本語 " + "s".repeat(3000),
        blockers: Array.from({ length: 20 }, (_, i) => `blocaj-${i}-` + "b".repeat(500)),
        artifactRefs: ["/opt/contextkeep/releases/1234567890abcdef"],
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const checkpointId = capture.outcome.recordId as string;
    for (const budget of [2000, 2500, 3000, 4000, 6000, 8000, 12000, 14000, 30000, 60000]) {
      const value = await ok(t, "get_work_context", { projectId, limitPerSection: 10, totalContextBudgetChars: budget });
      expect(JSON.stringify(value).length).toBeLessThanOrEqual(budget);
      expect(value.project.id).toBe(projectId);
      expect(value.freshness.working.status).toBe("unreviewed_working_memory");
      if (value.latestCheckpoint !== null) expect(value.latestCheckpoint.recordId).toBe(checkpointId);
      for (const section of ["goals", "actions", "workingMemory"]) {
        expect(value[section].returned).toBe(value[section].items.length);
        expect(value[section].omitted).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("searches each semantic checkpoint field and safely rejects non-checkpoint values", async () => {
    const { t, projectId } = await setup("CKR checkpoint field search");
    const captured = await ok(t, "capture_working_memory", {
      projectId,
      outcome: "ordinary body without metadata needles",
      subject: "metadata-checkpoint",
      checkpoint: {
        summary: "sumneedleorchid",
        outcome: "outneedlecobalt",
        nextAction: "nextneedleamber",
        blockers: ["blockneedleviolet"],
        artifactRefs: ["PR-7619-artifactneedlemint"],
      },
      idempotencyKey: crypto.randomUUID(),
    });
    for (const q of ["sumneedleorchid", "outneedlecobalt", "nextneedleamber", "blockneedleviolet", "artifactneedlemint"]) {
      const result = await ok(t, "search_context", { projectId, q, scope: "working" });
      const match = result.workingRecords.find((row: any) => row.recordId === captured.outcome.recordId);
      expect(match?.checkpoint?.summary).toBe("sumneedleorchid");
    }
    expect(parseWorkingCheckpoint(null)).toBeNull();
    expect(parseWorkingCheckpoint("{bad")).toBeNull();
    expect(parseWorkingCheckpoint(JSON.stringify({ kind: "ordinary", nextAction: "x" }))).toBeNull();
    expect(parseWorkingCheckpoint({ kind: "working_checkpoint", blockers: [1, "real"], artifactRefs: [false, "ref"] }))
      .toMatchObject({ blockers: ["real"], artifactRefs: ["ref"] });
  });

  it("keeps latest checkpoint beyond 50 ordinary notes and uses a deterministic tie-break", async () => {
    const { t, projectId } = await setup("CKR sparse checkpoint");
    const seed = await ok(t, "capture_working_memory", {
      projectId, outcome: "evidence seed", subject: "seed", idempotencyKey: crypto.randomUUID(),
    });
    const excerptId = seed.source.excerptIds[0] as string;
    const first = await ok(t, "capture_working_memory", {
      projectId,
      outcome: "first checkpoint",
      subject: "cp-first",
      checkpoint: { summary: "first checkpoint" },
      idempotencyKey: crypto.randomUUID(),
    });
    for (let i = 0; i < 55; i++) {
      createRecord(t.app.ck.deps, {
        projectId, sourceExcerptId: excerptId, recordType: "fact",
        subject: `plain-${i}`, text: `plain note ${i}`,
        evidenceBasis: "agent_report", sourceEventAt: null, taskStatus: null, volatile: false,
      }, { actor: "test:ckr", requestId: null });
    }
    const second = await ok(t, "capture_working_memory", {
      projectId,
      outcome: "second checkpoint",
      subject: "cp-second",
      checkpoint: { summary: "second checkpoint" },
      idempotencyKey: crypto.randomUUID(),
    });
    const tied = "2030-01-01T00:00:00.000Z";
    t.app.ck.handle.sqlite.prepare("UPDATE records SET recorded_at=? WHERE id IN (?,?)")
      .run(tied, first.outcome.recordId, second.outcome.recordId);
    const expected = [first.outcome.recordId, second.outcome.recordId].sort().reverse()[0];
    const context = await ok(t, "get_work_context", { projectId, task: "unrelated task wording", totalContextBudgetChars: 20000 });
    expect(context.latestCheckpoint.recordId).toBe(expected);
  });

  it("uses precise freshness boundaries and preserves Romanian AI as domain only when intended", () => {
    expect(reviewOverdue({ volatile: 1, reviewDueAt: "2026-09-21T10:00:00.000Z" }, "2026-09-21T10:00:00.000Z")).toBe(true);
    expect(reviewOverdue({ volatile: 1, reviewDueAt: "2026-09-21T10:00:00.001Z" }, "2026-09-21T10:00:00.000Z")).toBe(false);
    expect(reviewOverdue({ volatile: 0, reviewDueAt: "2020-01-01T00:00:00.000Z" }, "2026-09-21T10:00:00.000Z")).toBe(false);
    expect(buildSearchProfile("AI").tokens).toContain("ai");
    expect(buildSearchProfile("Ai terminat verificarea?").tokens).not.toContain("ai");
    expect(buildSearchProfile("folosesc AI pentru context").tokens).toContain("ai");
  });

  it("rejects self and three-node parent cycles through REST without partial revisions", async () => {
    const { t } = await setup("CKR cycle matrix root");
    const a = await ok(t, "create_project", { name: "cycle-matrix-a", idempotencyKey: crypto.randomUUID() });
    const b = await ok(t, "create_project", { name: "cycle-matrix-b", idempotencyKey: crypto.randomUUID() });
    const c = await ok(t, "create_project", { name: "cycle-matrix-c", idempotencyKey: crypto.randomUUID() });

    const self = await t.patch(`/api/projects/${a.id}`, { revision: a.revision, parentId: a.id });
    expect(self.statusCode).toBe(409);
    expect(self.json<any>().error.code).toBe("project_cycle");

    const ab = await t.patch(`/api/projects/${a.id}`, { revision: a.revision, parentId: b.id });
    expect(ab.statusCode).toBe(200);
    const bc = await t.patch(`/api/projects/${b.id}`, { revision: b.revision, parentId: c.id });
    expect(bc.statusCode).toBe(200);
    const beforeC = (await t.get(`/api/projects/${c.id}`)).json<any>();
    const ca = await t.patch(`/api/projects/${c.id}`, { revision: beforeC.revision, parentId: a.id });
    expect(ca.statusCode).toBe(409);
    expect(ca.json<any>().error.code).toBe("project_cycle");
    const afterC = (await t.get(`/api/projects/${c.id}`)).json<any>();
    expect(afterC.parentId).toBeNull();
    expect(afterC.revision).toBe(beforeC.revision);

    const detach = await t.patch(`/api/projects/${a.id}`, { revision: ab.json<any>().revision, parentId: null });
    expect(detach.statusCode).toBe(200);
    expect(detach.json<any>().parentId).toBeNull();
  });

  it("corrects one multi-valued relation without conflicting with a different object", async () => {
    const { t, projectId } = await setup("CKR relation correction parity");
    const source = await ok(t, "capture_working_memory", {
      projectId, outcome: "relation evidence", subject: "rel-evidence", idempotencyKey: crypto.randomUUID(),
    });
    const excerpt = source.source.excerptIds[0];
    const one = await ok(t, "create_relation", {
      projectId, sourceExcerptId: excerpt, subject: "runtime", relation: "depends_on", object: "sqlite",
      evidenceBasis: "document", idempotencyKey: crypto.randomUUID(),
    });
    const two = await ok(t, "create_relation", {
      projectId, sourceExcerptId: excerpt, subject: "runtime", relation: "depends_on", object: "tailscale",
      evidenceBasis: "document", idempotencyKey: crypto.randomUUID(),
    });
    await ok(t, "review_records", {
      items: [{ recordId: one.record.id, revision: one.record.revision }, { recordId: two.record.id, revision: two.record.revision }],
      action: "accept", ownerAction: true, idempotencyKey: crypto.randomUUID(),
    });
    const proposal = await ok(t, "propose_correction", {
      projectId,
      statement: "runtime depends on sqlite-v2.",
      recordType: "fact",
      subject: "runtime",
      predicate: "depends_on",
      relationObject: "sqlite-v2",
      supersedesRecordIds: [one.record.id],
      idempotencyKey: crypto.randomUUID(),
    });
    await ok(t, "confirm_correction", { jobId: proposal.jobId, idempotencyKey: crypto.randomUUID() });
    const relations = await ok(t, "search_relations", { projectId, subject: "runtime", relation: "depends_on", scope: "canonical", limit: 10 });
    expect(relations.canonicalRelations.map((r: any) => r.object).sort()).toEqual(["sqlite-v2", "tailscale"]);
  });
});
