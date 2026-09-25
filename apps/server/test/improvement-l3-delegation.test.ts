import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function invoke(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST", url: "/mcp", headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as { isError?: boolean; structuredContent: any };
}

async function ok(t: TestApp, name: string, args: Record<string, unknown>) {
  const result = await invoke(t, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}
describe("L3.4 configured working-memory delegation", () => {
  it("captures proposal-only working memory in one call using configured client identity", async () => {
    const t = await makeTestApp({
      mcpToken: TOKEN,
      mcpDefaultClientId: "chatgpt",
      mcpDelegateWorkingMemory: true,
    });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Delegated memory",
      idempotencyKey: crypto.randomUUID(),
    });
    const beforeSources = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n;
    const beforeRecords = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n;
    const beforeProject = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number; workingMemoryVersion: number };

    const eventId = crypto.randomUUID();
    const captured = await ok(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Agent noticed a useful implementation detail worth preserving.",
      evidenceText: "Observed during implementation: delegated memory stays proposal-only.",
      idempotencyKey: eventId,
    });
    expect(captured.outcome.reviewStatus).toBe("proposed");
    expect(captured.outcome.evidenceBasis).toBe("agent_report");
    expect(captured.progressUpdates).toEqual([]);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n).toBe(beforeSources + 1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n).toBe(beforeRecords + 1);
    const afterProject = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number; workingMemoryVersion: number };
    expect(afterProject.contentVersion).toBe(beforeProject.contentVersion);
    expect(afterProject.workingMemoryVersion).toBe(beforeProject.workingMemoryVersion + 1);

    const audit = t.app.ck.handle.sqlite.prepare(
      "SELECT actor,request_id AS requestId FROM audit_events WHERE action='work.captured' AND target_id=? ORDER BY timestamp DESC,id DESC LIMIT 1",
    ).get(project.id) as { actor: string; requestId: string };
    expect(audit).toEqual({ actor: "owner:mcp:chatgpt:delegated-working-memory", requestId: eventId });

    const brief = await ok(t, "get_project_brief", { projectId: project.id, offset: 0, limit: 10 });
    expect(JSON.stringify(brief)).not.toContain("useful implementation detail");
    const pending = await ok(t, "list_records", { projectId: project.id, reviewStatus: "proposed", offset: 0, limit: 20 });
    expect(JSON.stringify(pending)).toContain("useful implementation detail");

    const cap = await ok(t, "get_capabilities", {});
    expect(cap.workingMemoryDelegation).toEqual({
      enabled: true,
      clientId: "chatgpt",
      attribution: "explicit clientId overrides configured default; omit clientId to use the default",
      semantics: "proposal-only agent_report; no canonical task-progress mutation",
    });
  });
  it("attributes shared-endpoint delegated captures to explicit ChatGPT/Codex/ExampleAssistant client identities", async () => {
    const t = await makeTestApp({
      mcpToken: TOKEN,
      mcpDefaultClientId: "chatgpt",
      mcpDelegateWorkingMemory: true,
    });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Shared delegated identity",
      idempotencyKey: crypto.randomUUID(),
    });
    const before = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
    for (const clientId of ["chatgpt", "codex", "dsh"] as const) {
      const captured = await ok(t, "capture_working_memory", {
        projectId: project.id,
        outcome: `${clientId} preserved proposal-only working memory.`,
        evidenceText: `Observed by ${clientId} on the shared MCP endpoint.`,
        clientId,
        sessionId: `${clientId}-delegation-test`,
        idempotencyKey: crypto.randomUUID(),
      });
      expect(captured.outcome.reviewStatus).toBe("proposed");
      expect(captured.outcome.evidenceBasis).toBe("agent_report");
      expect(captured.progressUpdates).toEqual([]);
    }
    const after = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
    expect(after.contentVersion).toBe(before.contentVersion);
    const actors = t.app.ck.handle.sqlite.prepare(
      "SELECT actor FROM audit_events WHERE action='work.captured' AND target_id=? ORDER BY timestamp,id",
    ).all(project.id) as Array<{ actor: string }>;
    expect(actors.map((row) => row.actor)).toEqual([
      "owner:mcp:chatgpt:chatgpt-delegation-test",
      "owner:mcp:codex:codex-delegation-test",
      "owner:mcp:dsh:dsh-delegation-test",
    ]);
  });
  it("refuses delegated capture when not configured and requires attribution when enabling it", async () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      CK_DATA_DIR: "/tmp/ck-l34-config",
      CK_SESSION_SECRET: "delegation-test-secret",
      CK_MCP_DELEGATE_WORKING_MEMORY: "true",
    }, {})).toThrow(/CK_MCP_DEFAULT_CLIENT_ID/);

    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Delegation disabled",
      idempotencyKey: crypto.randomUUID(),
    });
    const beforeSources = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n;
    const beforeRecords = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n;

    const refused = await invoke(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "This must not persist.",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error.code).toBe("working_memory_delegation_disabled");
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n).toBe(beforeSources);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n).toBe(beforeRecords);
  });
});
