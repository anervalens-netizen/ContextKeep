import { afterEach, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
const apps: TestApp[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.cleanup(); });
it("RC05 filters audit action before the requested window", async () => {
  const t = await makeTestApp(); apps.push(t);
  const rows = (await t.get("/api/audit?action=auth.setup&limit=1")).json<Array<{action: string}>>();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.action).toBe("auth.setup");
});
it("RC03 reports completeness even for an empty filtered search", async () => {
  const t = await makeTestApp(); apps.push(t);
  const result = (await t.get("/api/search?q=unmatched&limit=1")).json<any>();
  expect(result.completeness.records).toEqual({ returned: 0, limit: 1, mayHaveMore: false, candidateLimitReached: false });
});
it("RC04 currentState declares its upstream selected-facts subset", async () => {
  const t = await makeTestApp({seed: true}); apps.push(t);
  const projects = (await t.get("/api/projects")).json<any>();
  const project = (Array.isArray(projects) ? projects : projects.items)[0];
  const result = (await t.get(`/api/projects/${project.id}/work-context`)).json<any>();
  expect(result.currentState.scope).toBe("selected_facts_subset");
  expect(result.currentState.selectedCount).toBe(result.currentState.total);
  expect(result.currentState.upstreamOmitted).toBeGreaterThanOrEqual(0);
});

it("RC03 reports a saturated candidate window even when all candidates are filtered out", async () => {
  const t = await makeTestApp({seed: true}); apps.push(t);
  const db = t.app.ck.deps.sqlite;
  const row = db.prepare("SELECT * FROM records WHERE review_status='accepted' LIMIT 1").get() as Record<string, unknown>;
  const names = Object.keys(row);
  const insert = db.prepare(`INSERT INTO records (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`);
  for (let i = 0; i < 45; i++) insert.run(...names.map((name) => name === 'id' || name === 'record_dedup_hash' ? crypto.randomUUID() : name === 'text' ? 'project' : name === 'subject' ? 'project' : name === 'type' ? 'fact' : name === 'predicate' ? null : name === 'value_json' ? null : row[name]));
  // Only the broad concept project overlaps: candidates exist but no result qualifies.
  const result = (await t.get("/api/search?q=project%20nonexistentrareterm&limit=1&mode=canonical")).json<any>();
  expect(result.records).toHaveLength(0);
  expect(result.completeness.records).toEqual({returned: 0, limit: 1, mayHaveMore: true, candidateLimitReached: true});
});

it("RC11 opt-in core only prioritizes accepted constraints in this project and explains omissions", async () => {
  const t = await makeTestApp({seed: true}); apps.push(t);
  const { ContextKeepMemoryService } = await import('../src/services/memory-context.js');
  const service = new ContextKeepMemoryService(t.app.ck.deps);
  const row = t.app.ck.deps.sqlite.prepare("SELECT id,project_id FROM records WHERE type='constraint' AND review_status='accepted' LIMIT 1").get() as {id: string; project_id: string};
  expect(row).toBeTruthy();
  const ctx = {scope: 'all' as const, projectId: row.project_id};
  const ordinary = service.getWorkContext(ctx, {projectId: row.project_id}) as any;
  expect(ordinary.constraints.permanentCore).toBeUndefined();
  // Give this project an upstream fact that cannot match the task.
  t.app.ck.deps.sqlite.prepare("UPDATE records SET project_id=? WHERE id=(SELECT id FROM records WHERE type='fact' AND predicate != 'lifecycle' AND review_status='accepted' LIMIT 1)").run(row.project_id);
  const foreign = t.app.ck.deps.sqlite.prepare("SELECT id FROM records WHERE project_id != ? AND predicate != 'lifecycle' LIMIT 1").get(row.project_id) as {id:string};
  t.app.ck.deps.sqlite.prepare("UPDATE records SET type='constraint' WHERE id=?").run(foreign.id);
  const proposal = t.app.ck.deps.sqlite.prepare("SELECT id FROM records WHERE review_status='proposed' LIMIT 1").get() as {id:string};
  t.app.ck.deps.sqlite.prepare("UPDATE records SET type='constraint',project_id=? WHERE id=?").run(row.project_id, proposal.id);
  const absent = crypto.randomUUID();
  const result = service.getWorkContext(ctx, {projectId: row.project_id, task: 'unrelatedtask', permanentConstraintIds: [row.id, absent, foreign.id, proposal.id], limitPerSection: 1, totalContextBudgetChars: 6000}) as any;
  expect(result.constraints.items[0].recordId).toBe(row.id);
  expect(result.constraints.permanentCore).toMatchObject({selectedCount: 1, omittedCount: 3, eligibleRecordIds: [row.id]});
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  expect(result.currentState).toMatchObject({scope: 'selected_facts_subset', selectedCount: 0});
  expect(result.currentState.upstreamOmitted).toBeGreaterThan(0);
  expect(t.app.ck.deps.sqlite.prepare("SELECT review_status FROM records WHERE id=?").get(proposal.id)).toEqual({review_status:"proposed"});
});
