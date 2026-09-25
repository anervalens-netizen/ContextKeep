import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
describe("L3.3 stable MCP agent identity", () => {
  it("attributes cross-agent writes and uses idempotencyKey as stable event identity", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Identity project",
      idempotencyKey: crypto.randomUUID(),
    });

    const eventId = crypto.randomUUID();
    const firstArgs = {
      projectId: project.id,
      outcome: "ChatGPT captured this work event.",
      evidenceText: "Identity evidence from ChatGPT session.",
      clientId: "chatgpt",
      sessionId: "chatgpt-session-20260917",
      idempotencyKey: eventId,
    };
    const first = await ok(t, "capture_work", firstArgs);
    expect(first.outcome.reviewStatus).toBe("proposed");

    const replay = await ok(t, "capture_work", firstArgs);
    expect(replay).toEqual(first);
    const firstAudit = t.app.ck.handle.sqlite.prepare(
      "SELECT actor,request_id AS requestId,count(*) AS n FROM audit_events WHERE action='work.captured' AND target_id=? GROUP BY actor,request_id",
    ).all(project.id) as Array<{ actor: string; requestId: string; n: number }>;
    expect(firstAudit).toContainEqual({
      actor: "owner:mcp:chatgpt:chatgpt-session-20260917",
      requestId: eventId,
      n: 1,
    });

    const changedIdentity = await invoke(t, "capture_work", {
      ...firstArgs,
      sessionId: "different-session",
    });
    expect(changedIdentity.isError).toBe(true);
    expect(changedIdentity.structuredContent.error.code).toBe("idempotency_key_reused");

    const codexEventId = crypto.randomUUID();
    await ok(t, "capture_work", {
      projectId: project.id,
      outcome: "Codex captured an independent work event.",
      evidenceText: "Identity evidence from Codex session.",
      clientId: "codex-desktop",
      sessionId: "codex-session-20260917",
      idempotencyKey: codexEventId,
    });
    const audits = t.app.ck.handle.sqlite.prepare(
      "SELECT actor,request_id AS requestId FROM audit_events WHERE action='work.captured' AND target_id=? ORDER BY timestamp,id",
    ).all(project.id) as Array<{ actor: string; requestId: string }>;
    expect(audits).toEqual(expect.arrayContaining([
      { actor: "owner:mcp:chatgpt:chatgpt-session-20260917", requestId: eventId },
      { actor: "owner:mcp:codex-desktop:codex-session-20260917", requestId: codexEventId },
    ]));
    expect(audits).toHaveLength(2);
  });

  it("keeps legacy write attribution compatible while event identity remains stable", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const eventId = crypto.randomUUID();
    const project = await ok(t, "create_project", {
      name: "Legacy identity",
      idempotencyKey: eventId,
    });
    const event = t.app.ck.handle.sqlite.prepare(
      "SELECT actor,request_id AS requestId FROM audit_events WHERE target_type='project' AND target_id=? ORDER BY timestamp DESC,id DESC LIMIT 1",
    ).get(project.id) as { actor: string; requestId: string };
    expect(event).toEqual({ actor: "owner:mcp", requestId: eventId });
  });
});
