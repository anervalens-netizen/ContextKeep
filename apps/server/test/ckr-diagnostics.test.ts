import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function setup(name: string) {
  const t = await makeTestApp({
    mcpToken: TOKEN,
    mcpDefaultClientId: "chatgpt",
    mcpDelegateWorkingMemory: true,
    adapters: "manual,faketest",
  });
  tracked.push(t);
  const project = (await t.post("/api/projects", { name })).json<{ id: string }>();
  return { t, projectId: project.id };
}

async function call(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError, JSON.stringify(body.result?.structuredContent)).not.toBe(true);
  return body.result.structuredContent as any;
}

async function capture(
  t: TestApp,
  projectId: string,
  outcome: string,
  subject: string,
  recordType: "fact" | "decision" | "action" | "constraint" | "question" = "fact",
) {
  return call(t, "capture_working_memory", {
    projectId,
    outcome,
    subject,
    recordType,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function acceptCapture(t: TestApp, captured: any) {
  const recordId = captured.outcome.recordId as string;
  const detail = await call(t, "get_record", {
    recordId,
    includeUnreviewed: true,
    evidenceOffset: 0,
    evidenceLimit: 3,
  });
  await call(t, "review_records", {
    items: [{ recordId, revision: detail.revision }],
    action: "accept",
    ownerAction: true,
    idempotencyKey: crypto.randomUUID(),
  });
  return recordId;
}

describe("CKR-17 deterministic opt-in work-context diagnostics", () => {
  it("is absent by default and reports no_data without provider/network access", async () => {
    const { t, projectId } = await setup("CKR17 no data");
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network blocked by CKR-17");
    }) as typeof fetch;
    try {
      const base = await call(t, "get_work_context", { projectId, task: "missing context" });
      const diagnostic = await call(t, "get_work_context", {
        projectId,
        task: "missing context",
        diagnostics: true,
      });
      expect(base.diagnostics).toBeUndefined();
      expect(diagnostic.diagnostics.reasons).toContain("no_data");
      expect(diagnostic.diagnostics.taskSelection.matchReason).toBe("deterministic_lexical_fts");
      expect(diagnostic.diagnostics.taskSelection.canonicalRecordIds).toEqual([]);
      expect(diagnostic.diagnostics.taskSelection.workingRecordIds).toEqual([]);
      expect(diagnostic.diagnostics.sections.facts).toMatchObject({
        eligibleTotal: 0,
        selectedBeforeBudget: 0,
        returnedAfterBudget: 0,
        omittedAfterBudget: 0,
        omissionReason: "no_data",
      });
      const baseBytes = JSON.stringify(base).length;
      const diagnosticBytes = JSON.stringify(diagnostic).length;
      expect(diagnosticBytes).toBeGreaterThan(baseBytes);
      console.log("CKR17_BYTES " + JSON.stringify({ baseBytes, diagnosticBytes, deltaBytes: diagnosticBytes - baseBytes }));
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("distinguishes no_relevant_match from unreviewed_only with exact record references", async () => {
    const unrelated = await setup("CKR17 no relevant");
    const acceptedCapture = await capture(
      unrelated.t,
      unrelated.projectId,
      "orchard banana baseline 445566",
      "unrelated-canonical",
    );
    await acceptCapture(unrelated.t, acceptedCapture);
    const noRelevant = await call(unrelated.t, "get_work_context", {
      projectId: unrelated.projectId,
      task: "zephyr quartz 918273",
      diagnostics: true,
    });
    expect(noRelevant.diagnostics.reasons).toContain("no_relevant_match");
    expect(noRelevant.diagnostics.reasons).not.toContain("unreviewed_only");
    expect(noRelevant.diagnostics.taskSelection.canonicalRecordIds).toEqual([]);
    expect(noRelevant.diagnostics.taskSelection.workingRecordIds).toEqual([]);

    const working = await setup("CKR17 unreviewed only");
    const workingCapture = await capture(
      working.t,
      working.projectId,
      "unreviewedneedle42 context candidate",
      "unreviewed-only",
    );
    const workingId = workingCapture.outcome.recordId as string;
    const unreviewedOnly = await call(working.t, "get_work_context", {
      projectId: working.projectId,
      task: "unreviewedneedle42",
      diagnostics: true,
    });
    expect(unreviewedOnly.diagnostics.reasons).toContain("unreviewed_only");
    expect(unreviewedOnly.diagnostics.reasons).not.toContain("no_relevant_match");
    expect(unreviewedOnly.diagnostics.taskSelection.canonicalRecordIds).toEqual([]);
    expect(unreviewedOnly.diagnostics.taskSelection.workingRecordIds).toContain(workingId);
    expect(unreviewedOnly.workingMemory.items.some((item: any) => item.recordId === workingId)).toBe(true);
  });

  it("reports stale with the exact stale canonical record id", async () => {
    const { t, projectId } = await setup("CKR17 stale");
    const captured = await capture(t, projectId, "production version stale-marker-77", "production-state");
    const recordId = await acceptCapture(t, captured);
    t.app.ck.deps.sqlite.prepare(
      "UPDATE records SET volatile=1, review_due_at='2000-01-01T00:00:00.000Z' WHERE id=?",
    ).run(recordId);

    const diagnostic = await call(t, "get_work_context", {
      projectId,
      task: "production version stale-marker-77",
      diagnostics: true,
    });
    expect(diagnostic.diagnostics.reasons).toContain("stale");
    expect(diagnostic.diagnostics.taskSelection.canonicalRecordIds).toContain(recordId);
    expect(diagnostic.diagnostics.taskSelection.staleRecordIds).toContain(recordId);
    expect(diagnostic.diagnostics.taskSelection.freshnessReason).toBe("stale");
    expect(diagnostic.facts.items.find((item: any) => item.recordId === recordId)?.stale).toBe(true);
  });

  it("reports budget_omission from actual post-budget trimming while preserving identity and cursors", async () => {
    const { t, projectId } = await setup("CKR17 budget omission");
    for (let i = 0; i < 8; i += 1) {
      const captured = await capture(
        t,
        projectId,
        `constraint-${i} ${"x".repeat(850)}`,
        `budget-constraint-${i}`,
        "constraint",
      );
      await acceptCapture(t, captured);
    }

    const diagnostic = await call(t, "get_work_context", {
      projectId,
      limitPerSection: 10,
      totalContextBudgetChars: 2000,
      diagnostics: true,
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized.length).toBeLessThanOrEqual(2000);
    expect(diagnostic.project.id).toBe(projectId);
    expect(diagnostic.freshness.canonical.cursor).toEqual(expect.any(Number));
    expect(diagnostic.freshness.working.cursor).toEqual(expect.any(Number));
    expect(diagnostic.diagnostics.reasons).toContain("budget_omission");
    expect(diagnostic.diagnostics.sections.constraints.selectedBeforeBudget).toBe(8);
    expect(diagnostic.diagnostics.sections.constraints.returnedAfterBudget).toBeLessThan(8);
    expect(diagnostic.diagnostics.sections.constraints.omissionReason).toBe("budget_omission");
    expect(diagnostic.diagnostics.sections.constraints.omittedAfterBudget)
      .toBe(8 - diagnostic.diagnostics.sections.constraints.returnedAfterBudget);
  });

  it("publishes a real MCP SDK contract that accepts diagnostics both off and on", async () => {
    const { t, projectId } = await setup("CKR17 SDK contract");
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const client = new Client({ name: "ckr17-contract", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );
      const catalog = await client.listTools();
      const tool = catalog.tools.find((item) => item.name === "get_work_context");
      expect((tool?.inputSchema as any)?.properties?.diagnostics?.type).toBe("boolean");

      const off = await client.callTool({
        name: "get_work_context",
        arguments: { projectId },
      });
      const on = await client.callTool({
        name: "get_work_context",
        arguments: { projectId, diagnostics: true, totalContextBudgetChars: 2000 },
      });
      expect(off.isError).not.toBe(true);
      expect(on.isError).not.toBe(true);
      expect((off.structuredContent as any).diagnostics).toBeUndefined();
      expect((on.structuredContent as any).diagnostics).toBeTruthy();
      expect(JSON.stringify(on.structuredContent).length).toBeLessThanOrEqual(2000);
    } finally {
      await client.close();
    }
  });
});
