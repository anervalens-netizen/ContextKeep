import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registry } from "../src/lib/telemetry.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const BUILD_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

beforeEach(() => registry.resetMetrics());
afterEach(async () => {
  while (tracked.length) await tracked.pop()!.cleanup();
});

async function setup(seed = false) {
  const t = await makeTestApp({
    seed,
    mcpToken: TOKEN,
    mcpDefaultClientId: "chatgpt",
    mcpDelegateWorkingMemory: true,
    buildSha: BUILD_SHA,
  });
  tracked.push(t);
  return t;
}

async function rpc(t: TestApp, name: string, args: Record<string, unknown> = {}) {
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
  return body.result as { isError?: boolean; structuredContent: any };
}

describe("CK-A13 common runtime metadata and bounded MCP diagnostics", () => {
  it("reports the exact same runtime identity through REST meta and MCP capabilities", async () => {
    const t = await setup();
    const meta = (await t.get("/api/meta")).json<any>();
    const caps = (await rpc(t, "get_capabilities")).structuredContent;

    expect(meta.runtime).toEqual(caps.runtime);
    expect(meta.runtime).toEqual({
      buildSha: BUILD_SHA,
      applicationVersion: "0.1.0",
      mcpVersion: "2.10.1",
      mcpContractVersion: "mcp-first-v1",
      schemaVersion: 16,
      protocols: {
        latest: "2026-07-28",
        supported: expect.arrayContaining(["2025-11-25", "2025-06-18", "2025-03-26"]),
      },
    });
    expect(caps.version).toBe(meta.runtime.mcpVersion);
    expect(caps.applicationVersion).toBe(meta.runtime.applicationVersion);
    expect(caps.schemaVersion).toBe(meta.runtime.schemaVersion);
  });

  it("exports finite tool/outcome/error metrics without project, session, request or memory labels", async () => {
    const t = await setup(true);
    const list = await rpc(t, "list_projects");
    expect(list.isError).not.toBe(true);
    const projectId = list.structuredContent.projects[0].id as string;

    const missing = await rpc(t, "get_project", { projectId: crypto.randomUUID() });
    expect(missing.isError).toBe(true);

    const bounded = await rpc(t, "get_work_context", {
      projectId,
      task: "x".repeat(2_000),
      totalContextBudgetChars: 2_000,
      diagnostics: true,
    });
    expect(bounded.isError).not.toBe(true);

    const metrics = (await t.get("/api/metrics")).payload;
    expect(metrics).toContain('ck_mcp_tool_calls_total{tool="list_projects",outcome="success",error_class="none"}');
    expect(metrics).toContain('ck_mcp_tool_calls_total{tool="get_project",outcome="error",error_class="not_found"}');
    expect(metrics).toContain('ck_mcp_tool_result_bytes_count{tool="list_projects",outcome="success"}');
    expect(metrics).toContain('ck_mcp_tool_duration_seconds_count{tool="get_project",outcome="error"}');
    if (bounded.structuredContent.truncated === true) {
      expect(metrics).toContain('ck_mcp_tool_budget_omissions_total{tool="get_work_context"}');
    }

    expect(metrics).not.toContain(projectId);
    expect(metrics).not.toContain("xxxxxxxxxxxxxxxx");
    expect(metrics).not.toMatch(/projectId=|sessionId=|requestId=/);
  });
});

describe("CK-A13 SDK compatibility probe", () => {
  it("covers initialize/list/call/error/reconnect and negotiated supported revisions on SDK v1.30.0", async () => {
    const t = await setup();
    const project = (await t.post("/api/projects", { name: "A13 SDK probe" })).json<{ id: string }>();
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);

    for (let pass = 0; pass < 2; pass += 1) {
      const client = new Client({ name: `ContextKeep A13 probe ${pass}`, version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }));
        expect((await client.listTools()).tools).toHaveLength(35);
        const ok = await client.callTool({ name: "get_project", arguments: { projectId: project.id } });
        expect(ok.isError).not.toBe(true);
        const bad = await client.callTool({ name: "get_project", arguments: { projectId: crypto.randomUUID() } });
        expect(bad.isError).toBe(true);
        expect((bad.structuredContent as any).error.code).toBe("project_not_found");
      } finally {
        await client.close();
      }
    }

    for (const protocolVersion of ["2025-11-25", "2025-06-18"]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/mcp",
        headers: AUTH,
        payload: {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "ContextKeep A13 negotiation probe", version: "1" },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<any>().result.protocolVersion).toBe(protocolVersion);
    }
  });
});
