import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}
describe("L3.1 compact agent work context", () => {
  it("returns bounded current goals, active actions, constraints and evidence refs in one call", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await call(t, "create_project", {
      name: "Work context",
      description: "Finish the improvement milestone with minimal agent setup.",
      idempotencyKey: crypto.randomUUID(),
    });

    const note = (recordType: string, statement: string) => call(t, "add_owner_note", {
      projectId: project.id,
      recordType,
      statement,
      idempotencyKey: crypto.randomUUID(),
    });
    await note("decision", "Prioritize autonomous agent startup.");
    await note("decision", "Keep the context payload compact.");
    await note("action", "Implement the next eligible tracker task.");
    await note("constraint", "Do not load historical audits by default.");
    await note("question", "Which evidence needs deeper inspection?");
    await call(t, "add_source", {
      projectId: project.id,
      text: "UNREVIEWED_SOURCE_BODY_MUST_NOT_LEAK",
      authorLabel: "agent report",
      idempotencyKey: crypto.randomUUID(),
    });
    const captured = await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Agent completed a useful but still unreviewed implementation checkpoint.",
      evidenceText: "Tests for the checkpoint passed in the agent workspace.",
      title: "Recent work evidence",
      recordType: "fact",
      subject: "recent-agent-work",
      progressUpdates: [],
      clientId: "work-context-test",
      sessionId: "recent-work",
      idempotencyKey: crypto.randomUUID(),
    });
    const handoff = await call(t, "create_handoff", {
      projectId: project.id,
      objective: "Continue from the latest verified checkpoint.",
      contextBudgetChars: 4000,
      clientId: "work-context-test",
      sessionId: "recent-work",
      idempotencyKey: crypto.randomUUID(),
    });

    const context = await call(t, "get_work_context", { projectId: project.id, limitPerSection: 1 });
    expect(context.objective).toContain("minimal agent setup");
    expect(context.goalSemantics).toContain("decision records");
    expect(context.goals.total).toBe(2);
    expect(context.goals.items).toHaveLength(1);
    expect(context.actions.items[0].text).toContain("next eligible tracker task");
    expect(context.constraints.items[0].text).toContain("historical audits");
    expect(context.openQuestions.items[0].text).toContain("deeper inspection");
    expect(context.goals.items[0].evidenceRefs.length).toBeGreaterThan(0);
    expect(context.goals.items[0].evidenceRefs[0].excerptId).toBeTruthy();
    expect(context.goals.items[0].evidenceRefs[0].text).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("UNREVIEWED_SOURCE_BODY_MUST_NOT_LEAK");
    expect(context.recentWorkSemantics).toMatch(/unreviewed agent_report proposals/i);
    expect(context.recentWork.total).toBe(1);
    expect(context.recentWork.items).toHaveLength(1);
    expect(context.recentWork.items[0]).toMatchObject({
      recordId: captured.outcome.recordId,
      reviewStatus: "proposed",
      subject: "recent-agent-work",
    });
    expect(context.recentWork.items[0].text).toContain("unreviewed implementation checkpoint");
    expect(context.recentWork.items[0].evidenceRefs[0].text).toBeUndefined();
    expect(context.recentHandoffs.total).toBe(1);
    expect(context.recentHandoffs.items[0]).toMatchObject({
      handoffId: handoff.id,
      objective: "Continue from the latest verified checkpoint.",
    });
    expect(context.limits).toEqual({ perSection: 1, evidenceRefsPerRecord: 3, textCharsPerRecord: 1000 });
  });
});
