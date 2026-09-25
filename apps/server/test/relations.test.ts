import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import heldout from "../src/evals/ai-memory-heldout.json" with { type: "json" };
import { AI_MEMORY_FIXTURE_RELATIONS, AI_MEMORY_PROJECT_ID, seedAiMemoryFixture } from "../src/evals/ai-memory-fixture.js";
import { searchRelations } from "../src/services/relations.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => { for (const t of tracked.splice(0)) await t.cleanup(); });

async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}

async function project(t: TestApp, name: string) {
  return call(t, "create_project", { name, idempotencyKey: crypto.randomUUID() });
}

async function excerpt(t: TestApp, projectId: string, text: string) {
  const imported = await call(t, "add_source", {
    projectId,
    text,
    authorLabel: "relation verification",
    idempotencyKey: crypto.randomUUID(),
  });
  const source = await call(t, "get_source", { sourceId: imported.source.id });
  return source.excerpts[0].id as string;
}

describe("A5.4 evidence-backed relation primitive", () => {
  it("keeps relation writes proposed, evidence-linked and project scoped until normal review accepts them", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const p = await project(t, "Relations primary");
    const other = await project(t, "Relations other");
    const sourceExcerptId = await excerpt(t, p.id, "Deployment depends on contextkeep.service and the schema migration.");
    const created = await call(t, "create_relation", {
      projectId: p.id,
      sourceExcerptId,
      subject: "deployment",
      relation: "depends_on",
      object: "contextkeep.service",
      evidenceBasis: "observed_technical",
      idempotencyKey: crypto.randomUUID(),
    });

    expect(created.relation).toMatchObject({
      projectId: p.id,
      relation: "depends_on",
      subject: "deployment",
      object: "contextkeep.service",
      reviewStatus: "proposed",
      evidenceCount: 1,
    });
    expect(created.record.evidenceBasis).toBe("observed_technical");

    const working = await call(t, "search_relations", {
      projectId: p.id,
      scope: "working",
      q: "contextkeep.service",
      direction: "incoming",
    });
    expect(working.canonicalRelations).toEqual([]);
    expect(working.workingRelations.map((x: any) => x.recordId)).toContain(created.record.id);

    const otherScope = await call(t, "search_relations", { projectId: other.id, scope: "all" });
    expect(otherScope.relations).toEqual([]);

    await call(t, "review_records", {
      items: [{ recordId: created.record.id, revision: created.record.revision }],
      action: "accept",
      idempotencyKey: crypto.randomUUID(),
    });
    const canonical = await call(t, "search_relations", {
      projectId: p.id,
      relation: "depends_on",
      scope: "canonical",
      q: "deployment",
      direction: "outgoing",
    });
    expect(canonical.workingRelations).toEqual([]);
    expect(canonical.canonicalRelations.map((x: any) => x.recordId)).toContain(created.record.id);
    expect(canonical.canonicalRelations[0].evidenceCount).toBeGreaterThan(0);
  });

  it("supports multiple objects for one accepted subject/relation and exposes task-relevant relations separately", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const p = await project(t, "Relations multi");
    const sourceExcerptId = await excerpt(t, p.id, "Deployment depends on contextkeep.service and schema migration.");
    const ids: string[] = [];
    for (const object of ["contextkeep.service", "schema migration"]) {
      const created = await call(t, "create_relation", {
        projectId: p.id,
        sourceExcerptId,
        subject: "deployment",
        relation: "depends_on",
        object,
        evidenceBasis: "document",
        idempotencyKey: crypto.randomUUID(),
      });
      ids.push(created.record.id);
      await call(t, "review_records", {
        items: [{ recordId: created.record.id, revision: created.record.revision }],
        action: "accept",
        idempotencyKey: crypto.randomUUID(),
      });
    }

    const relations = await call(t, "search_relations", {
      projectId: p.id,
      relation: "depends_on",
      subject: "deployment",
      scope: "canonical",
      limit: 10,
    });
    expect(new Set(relations.canonicalRelations.map((x: any) => x.object))).toEqual(new Set(["contextkeep.service", "schema migration"]));

    const context = await call(t, "get_work_context", {
      projectId: p.id,
      task: "Verify deployment dependency contextkeep.service before schema migration",
      totalContextBudgetChars: 12000,
    });
    expect(context.relations.canonical.map((x: any) => x.recordId)).toEqual(expect.arrayContaining(ids));
    expect(context.relations.working).toEqual([]);
  });

  it("does not accept owner_declaration provenance through create_relation", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const p = await project(t, "Relations provenance");
    const sourceExcerptId = await excerpt(t, p.id, "A service runs on a host.");
    const response = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: AUTH,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: "create_relation", arguments: {
          projectId: p.id,
          sourceExcerptId,
          subject: "service",
          relation: "runs_on",
          object: "host",
          evidenceBasis: "owner_declaration",
          idempotencyKey: crypto.randomUUID(),
        } },
      },
    });
    const body = response.json();
    expect(body.result?.isError ?? Boolean(body.error)).toBe(true);
  });

  it("meets the held-out dependency gate with generic relation intent and evidence", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    seedAiMemoryFixture(t.app.ck.deps, { includeRelations: true });
    const sourceByRelation = new Map(AI_MEMORY_FIXTURE_RELATIONS.map((relation) => [relation.id, relation.sourceRecordId]));
    const cases = heldout.filter(
      (item) => item.categories.includes("dependency") && !item.categories.includes("ckr_independent"),
    );
    let recallAt10 = 0;
    let evidenceEligible = 0;
    let evidenceHit = 0;
    for (const testCase of cases) {
      const scope = testCase.categories.includes("working_memory") ? "working" : "canonical";
      const result = searchRelations(t.app.ck.deps, {
        projectId: AI_MEMORY_PROJECT_ID,
        q: testCase.query,
        scope,
        limit: 10,
      });
      const relations = scope === "working" ? result.workingRelations : result.canonicalRelations;
      const sourceIds = relations.map((relation) => sourceByRelation.get(relation.recordId)).filter((id): id is string => Boolean(id));
      if (testCase.targetRecordIds.every((id) => sourceIds.slice(0, 10).includes(id))) recallAt10 += 1;
      if (testCase.requiresEvidence) {
        evidenceEligible += 1;
        if (relations.some((relation) => testCase.targetRecordIds.includes(sourceByRelation.get(relation.recordId) ?? "") && relation.evidenceCount > 0)) {
          evidenceHit += 1;
        }
      }
    }
    expect(cases).toHaveLength(11);
    expect(recallAt10 / cases.length).toBeGreaterThanOrEqual(0.95);
    expect(evidenceHit / evidenceEligible).toBeGreaterThanOrEqual(0.95);
  });

});
