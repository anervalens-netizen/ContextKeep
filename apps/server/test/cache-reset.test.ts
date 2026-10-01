import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client.js";
import { readWithDatabaseGeneration } from "../src/db/cache-generation.js";
import { projects, records } from "../src/db/schema.js";
import { readBrief } from "../src/mcp/reads.js";
import { buildBriefPayload } from "../src/services/brief.js";
import { applyDump } from "../src/services/dump-import.js";
import { buildJsonDump } from "../src/services/export.js";
import { loadRecordFreshnessContext, toRecordDto } from "../src/services/mappers.js";
import { ContextKeepMemoryService } from "../src/services/memory-context.js";
import { applyPortableDump } from "../src/services/portable-dump.js";
import type { ServiceDeps } from "../src/services/import.js";
import { expectStatus, makeTestApp, reviewCurrent, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const token = randomUUID();
const before = "2026-01-01T00:00:00.000Z";
const after = "2026-02-01T00:00:00.000Z";
const actor = { actor: "test:synthetic-reset" };
type Row = typeof records.$inferSelect;

afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});

async function fixture() {
  const t = await makeTestApp({ mcpToken: token });
  apps.push(t);
  const deps = t.app.ck.deps;
  const projectResponse = await t.post("/api/projects", { name: "Synthetic gateway" });
  expectStatus(projectResponse, 200);
  const projectId = projectResponse.json<{ id: string }>().id;
  expectStatus(await t.post("/api/imports/text", {
    projectId,
    adapterId: "faketest",
    text: "fact: gateway current state is documented\ndecision: gateway uses oldcanonical policy",
  }), 201);
  const candidates = deps.db.select().from(records).all();
  expect(candidates).toHaveLength(2);
  expectStatus(await reviewCurrent(t, candidates.map((row) => row.id), "accept"), 200);
  deps.db.update(records).set({ subject: "example-gateway", sourceEventAt: before }).run();
  const canonical = deps.db.select().from(records).all().find((row) => row.type === "fact")!;
  deps.db.update(records).set({ predicate: "status" }).where(eq(records.id, canonical.id)).run();
  canonical.predicate = "status";
  const oldReportId = randomUUID();
  const newReportId = randomUUID();
  const oldRelationId = randomUUID();
  const newRelationId = randomUUID();
  deps.db.insert(records).values([
    {
      ...canonical, id: oldReportId, reviewStatus: "proposed", evidenceBasis: "agent_report",
      sourceEventAt: after, recordedAt: after, reviewedAt: null,
      recordDedupHash: "synthetic-old-report", text: "gateway oldreport observation",
    },
    {
      ...canonical, id: oldRelationId, reviewStatus: "proposed", evidenceBasis: "agent_report",
      sourceEventAt: after, recordedAt: after, reviewedAt: null,
      predicate: "depends_on", valueJson: JSON.stringify({ object: "oldnode" }),
      recordDedupHash: "synthetic-old-relation", text: "gateway depends on oldnode",
    },
  ]).run();
  // Authentic exporter shape: arrays contain rows, whose JSON columns are strings.
  const original = buildJsonDump(deps, actor);
  const replacement = structuredClone(original);
  replacement.records = (replacement.records as Row[]).map((row) => {
    if (row.id === oldReportId) return { ...row, id: newReportId, text: "gateway newreport observation" };
    if (row.id === oldRelationId) return {
      ...row, id: newRelationId, text: "gateway depends on newnode", valueJson: JSON.stringify({ object: "newnode" }),
    };
    if (row.type === "decision") return { ...row, text: "gateway uses newcanonical policy" };
    return row;
  });
  // Retain source/evidence coherence while changing the synthetic decision text.
  replacement.sources = (replacement.sources as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    rawText: String(row.rawText).replace("oldcanonical", "newcanonical"),
    normalizedText: String(row.normalizedText).replace("oldcanonical", "newcanonical"),
  }));
  replacement.sourceExcerpts = (replacement.sourceExcerpts as Array<Record<string, unknown>>).map((row) => ({
    ...row, exactText: String(row.exactText).replace("oldcanonical", "newcanonical"),
  }));
  expect(replacement.projects).toEqual(original.projects);
  const context = { scope: "project" as const, projectId };
  const input = { projectId, task: "gateway", limitPerSection: 5, totalContextBudgetChars: 60000 };

  function check(deps: ServiceDeps, state: "old" | "new") {
    const reportId = state === "old" ? oldReportId : newReportId;
    const relationId = state === "old" ? oldRelationId : newRelationId;
    const absentId = state === "old" ? newReportId : oldReportId;
    const absentRelation = state === "old" ? newRelationId : oldRelationId;
    const payload = buildBriefPayload(deps, projectId).toString();
    expect(payload).toContain(`${state}canonical`);
    expect(payload).not.toContain(state === "old" ? "newcanonical" : "oldcanonical");
    expect(payload).not.toContain(reportId); // Working reports stay proposal-only.
    const brief = readBrief(deps, { projectId, offset: 0, limit: 10 });
    expect(brief.sections.facts!.items[0]!.freshness).toMatchObject({
      currentness: "needs_verification", authority: "canonical", supportRecordIds: [reportId],
    });
    // A different projection exercises the retained observation index as well
    // as the exact canonical signal warmed above.
    const projection = { ...canonical, text: `gateway projection ${state}` };
    expect(toRecordDto(projection, [], loadRecordFreshnessContext(deps.db, [projection])).freshness)
      .toMatchObject({ supportRecordIds: [reportId] });
    const work = new ContextKeepMemoryService(deps).getWorkContext(context, input);
    expect(work.facts).toMatchObject({ items: [expect.objectContaining({
      status: "accepted", provenance: canonical.evidenceBasis,
      freshness: expect.objectContaining({ supportRecordIds: [reportId] }),
    })] });
    expect(work.relations).toMatchObject({ working: [expect.objectContaining({ recordId: relationId })] });
    const text = JSON.stringify(work);
    expect(text).toContain(`${state}canonical`);
    expect(text).toContain(`${state}report`);
    expect(text).toContain(`${state}node`);
    expect(text).not.toContain(absentId);
    expect(text).not.toContain(absentRelation);
    expect(deps.db.select().from(projects).all()).toEqual(original.projects);
  }

  async function checkMcp(state: "old" | "new") {
    for (const [name, args] of [
      ["get_project_brief", { projectId }],
      ["search_context", { projectId, q: "gateway", scope: "all" }],
      ["get_work_context", input],
    ] as const) {
      const response = await t.app.inject({
        method: "POST", url: "/mcp",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
        payload: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.isError).not.toBe(true);
      const text = JSON.stringify(body.result.structuredContent);
      expect(text).toContain(state === "old" ? oldReportId : newReportId);
      expect(text).not.toContain(state === "old" ? newReportId : oldReportId);
      expect(text).toContain(`${state}canonical`);
    }
  }
  return { t, deps, projectId, original, replacement, check, checkMcp };
}

describe("reset-safe database cache generations", () => {
  it.each([1, 2])("invalidates all warm reads after HTTP v%i reset preserving exact project identity", async (version) => {
    const f = await fixture();
    f.check(f.deps, "old");
    f.check(f.deps, "old");
    await f.checkMcp("old");
    const response = await f.t.post("/api/admin/import-dump", { mode: "reset", dump: { ...f.replacement, version } });
    expectStatus(response, 200);
    expect(response.json()).toMatchObject({ blocked: 0 });
    f.check(f.deps, "new");
    f.check(f.deps, "new");
    await f.checkMcp("new");
  });

  it("retains committed cache truth after a failed reset and an outer reset rollback", async () => {
    const f = await fixture();
    f.check(f.deps, "old");
    const generation = readWithDatabaseGeneration(f.deps.db, (value) => value);
    expect(() => applyDump(f.deps, {
      mode: "reset", source: "synthetic-invalid", dump: { ...f.replacement, recordEvidence: [] },
    }, actor)).toThrow(/accepted but has no evidence/);
    expect(readWithDatabaseGeneration(f.deps.db, (value) => value)).toBe(generation);
    f.check(f.deps, "old");
    expect(() => f.deps.sqlite.transaction(() => {
      applyPortableDump(f.deps, { mode: "reset", source: "synthetic-rollback", dump: { ...f.replacement, version: 2 } }, actor);
      f.check(f.deps, "new");
      throw new Error("synthetic outer rollback");
    })()).toThrow("synthetic outer rollback");
    f.check(f.deps, "old");
    applyDump(f.deps, { mode: "reset", source: "synthetic-cli-engine", dump: f.replacement }, actor);
    f.check(f.deps, "new");
  });

  it.each(["managed", "caller-owned"])("observes external resets after a %s read snapshot ends", async (kind) => {
    const f = await fixture();
    f.check(f.deps, "old");
    const writer = openDatabase(f.t.config.dbPath);
    try {
      const duringRead = () => {
        f.check(f.deps, "old");
        applyPortableDump({ ...f.deps, ...writer }, {
          mode: "reset", source: "synthetic-other-connection", dump: { ...f.replacement, version: 2 },
        }, actor);
        f.check(f.deps, "old");
      };
      if (kind === "managed") readWithDatabaseGeneration(f.deps.db, duringRead);
      else f.deps.sqlite.transaction(duringRead)();
      f.check(f.deps, "new");
      f.check(f.deps, "new");
      await f.checkMcp("new");
    } finally {
      writer.sqlite.close();
    }
  });

  it("partitions full briefs across stores with identical project IDs and versions", async () => {
    const f = await fixture();
    const other = await makeTestApp();
    apps.push(other);
    applyDump(other.app.ck.deps, { mode: "reset", source: "synthetic-second-store", dump: f.replacement }, actor);
    // Align reset epochs too: the DB partition, not a lucky version mismatch,
    // must isolate the two different payloads.
    applyDump(f.deps, { mode: "reset", source: "synthetic-first-store", dump: f.original }, actor);
    expect(readWithDatabaseGeneration(f.deps.db, (value) => value))
      .toBe(readWithDatabaseGeneration(other.app.ck.deps.db, (value) => value));
    f.check(f.deps, "old");
    f.check(other.app.ck.deps, "new");
    f.check(f.deps, "old");
  });

  it("keeps warm caches across same-connection writes to another project and audit rows", async () => {
    const f = await fixture();
    f.check(f.deps, "old");
    const payload = buildBriefPayload(f.deps, f.projectId);
    const generation = readWithDatabaseGeneration(f.deps.db, (value) => value);
    expectStatus(await f.t.post("/api/projects", { name: "Synthetic unrelated project" }), 200);
    buildJsonDump(f.deps, actor); // Own audit writes must not invalidate the cache.
    expect(readWithDatabaseGeneration(f.deps.db, (value) => value)).toBe(generation);
    expect(buildBriefPayload(f.deps, f.projectId)).toBe(payload);
    const prepare = vi.spyOn(f.deps.sqlite, "prepare");
    new ContextKeepMemoryService(f.deps).getWorkContext(
      { scope: "project", projectId: f.projectId }, { task: "gateway", limitPerSection: 5, totalContextBudgetChars: 60000 },
    );
    expect(prepare.mock.calls.some(([query]) => /records_fts|SELECT id, project_id AS projectId/.test(query))).toBe(false);
  });
});
