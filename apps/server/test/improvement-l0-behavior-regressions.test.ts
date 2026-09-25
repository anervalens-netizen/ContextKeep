import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => { for (const app of tracked.splice(0)) await app.cleanup(); });

async function setup() {
  const t = await makeTestApp({ mcpToken: TOKEN });
  tracked.push(t);
  const response = await t.post("/api/projects", { name: "L0 behavior regression" });
  expect(response.statusCode).toBe(200);
  return { t, projectId: response.json<{ id: string }>().id };
}

async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST", url: "/mcp", headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}

async function note(t: TestApp, projectId: string, statement: string, recordType = "fact", subject = "l0-regression") {
  return call(t, "add_owner_note", { projectId, statement, recordType, subject, idempotencyKey: crypto.randomUUID() });
}

describe("L0.1 behavior-probe regressions", () => {
  it("F01: a 2k handoff preserves critical action and constraint before background facts", async () => {
    const { t, projectId } = await setup();
    await note(t, projectId, "alpha middle zeta: reproducible search control.");
    for (let i = 0; i < 14; i++) await note(t, projectId, `FACT_${String(i).padStart(2, "0")} ${"Background description. ".repeat(22)}`, "fact", `fact-${i}`);
    await note(t, projectId, "CRITICAL_NEXT_ACTION: finish the active task, do not repeat completed work.", "action");
    await note(t, projectId, "CRITICAL_CONSTRAINT: preserve the selected production branch.", "constraint");

    const handoff = await call(t, "create_handoff", { projectId, objective: "Finish the active task", contextBudgetChars: 2000, idempotencyKey: crypto.randomUUID() });
    expect(handoff.markdown).toContain("CRITICAL_NEXT_ACTION");
    expect(handoff.markdown).toContain("CRITICAL_CONSTRAINT");
  });

  it("F02: normal multi-term canonical search matches non-adjacent terms while phrase mode stays exact", async () => {
    const { t, projectId } = await setup();
    const created = await note(t, projectId, "alpha middle zeta: reproducible search control.");
    const terms = await call(t, "search_context", { projectId, q: "alpha zeta" });
    expect(terms.match).toBe("terms");
    expect(terms.records.map((record: any) => record.recordId)).toContain(created.acceptedRecordIds[0]);

    const nonAdjacentPhrase = await call(t, "search_context", { projectId, q: "alpha zeta", match: "phrase" });
    expect(nonAdjacentPhrase.records.map((record: any) => record.recordId)).not.toContain(created.acceptedRecordIds[0]);

    const exactPhrase = await call(t, "search_context", { projectId, q: "alpha middle zeta", match: "phrase" });
    expect(exactPhrase.match).toBe("phrase");
    expect(exactPhrase.records.map((record: any) => record.recordId)).toContain(created.acceptedRecordIds[0]);
  });

  it("F04: first brief page prioritizes newest/current facts instead of oldest facts", async () => {
    const { t, projectId } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const created = await note(t, projectId, `FACT_${String(i).padStart(2, "0")} deterministic pagination fixture.`, "fact", `fact-${i}`);
      ids.push(created.acceptedRecordIds[0]);
    }
    const update = t.app.ck.handle.sqlite.prepare("UPDATE records SET recorded_at=?, updated_at=? WHERE id=?");
    ids.forEach((id, i) => {
      const ts = `2026-09-17T08:${String(i).padStart(2, "0")}:00.000Z`;
      update.run(ts, ts, id);
    });
    const brief = await call(t, "get_project_brief", { projectId, limit: 10 });
    expect(brief.sections.facts.items.map((record: any) => record.recordId)).toContain(ids.at(-1));
  });

  it("F06 non-bug assertion: metadata revision does not change when accepted content changes", async () => {
    const { t, projectId } = await setup();
    const before = (await call(t, "get_project", { projectId })).project.revision;
    await note(t, projectId, "REVISION_CHANGE_PROBE");
    const after = (await call(t, "get_project", { projectId })).project.revision;
    expect(before).toBe(1);
    expect(after).toBe(before);
  });

  it("F07 non-bug assertion: accepted statements coexist until an explicit supersession is confirmed", async () => {
    const { t, projectId } = await setup();
    await note(t, projectId, "ContextKeep MCP exposes 10 tools.", "fact", "mcp-capabilities");
    await note(t, projectId, "ContextKeep MCP exposes 27 tools.", "fact", "mcp-capabilities");
    const brief = await call(t, "get_project_brief", { projectId, limit: 10 });
    const texts = brief.sections.facts.items.map((record: any) => record.text);
    expect(texts).toContain("ContextKeep MCP exposes 10 tools.");
    expect(texts).toContain("ContextKeep MCP exposes 27 tools.");
  });
});
