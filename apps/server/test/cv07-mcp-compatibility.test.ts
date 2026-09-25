import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZATION = `Bearer ${TOKEN}`;

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function setup() {
  const app = await makeTestApp({
    mcpToken: TOKEN,
    mcpDefaultClientId: "cv07",
    mcpDelegateWorkingMemory: true,
  });
  tracked.push(app);
  const project = await app.post("/api/projects", { name: "CV07 compatibility", aliases: ["cv07"] });
  expect(project.statusCode).toBe(200);
  await app.app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.app.server.address();
  if (!address || typeof address === "string") throw new Error("CV07 test server did not listen");
  return { app, projectId: project.json<{ id: string }>().id, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

function transport(url: URL, fetch?: typeof globalThis.fetch): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: AUTHORIZATION } },
    ...(fetch ? { fetch } : {}),
  });
}

async function callTool(client: Client, name: string, arguments_: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.structuredContent).toBeTruthy();
  return result as { isError?: boolean; structuredContent: Record<string, any> };
}

describe("CV07 stable v2 MCP compatibility", () => {
  it("serves the same catalog, output contracts, reads and separated canonical/working data to modern clients", async () => {
    const { projectId, url } = await setup();
    const client = new Client(
      { name: "CV07 modern fixture", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(transport(url));
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

      const catalog = await client.listTools();
      expect(catalog.tools).toHaveLength(35);
      expect(catalog.tools.map((tool) => tool.name)).toContain("get_record");
      for (const tool of catalog.tools) {
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.outputSchema?.type, tool.name).toBe("object");
        expect(tool.outputSchema?.anyOf, tool.name).toHaveLength(2);
      }

      const canonical = await callTool(client, "add_owner_note", {
        projectId,
        statement: "CV07 canonical read fixture.",
        recordType: "decision",
        idempotencyKey: crypto.randomUUID(),
      });
      expect(canonical.isError).not.toBe(true);
      const canonicalRecordId = canonical.structuredContent.acceptedRecordIds[0] as string;
      const record = await callTool(client, "get_record", { recordId: canonicalRecordId });
      expect(record.isError).not.toBe(true);
      expect(record.structuredContent.reviewStatus).toBe("accepted");
      expect(record.structuredContent.evidenceBasis).toBe("owner_declaration");

      const working = await callTool(client, "capture_working_memory", {
        projectId,
        outcome: "CV07 working proposal fixture.",
        evidenceText: "working evidence",
        clientId: "modern-client",
        idempotencyKey: crypto.randomUUID(),
      });
      expect(working.isError).not.toBe(true);
      expect(working.structuredContent.outcome.reviewStatus).toBe("proposed");
      expect(working.structuredContent.outcome.evidenceBasis).toBe("agent_report");

      const all = await callTool(client, "search_context", {
        projectId,
        q: "CV07",
        scope: "all",
      });
      expect(all.isError).not.toBe(true);
      expect(all.structuredContent.records.some((item: any) => item.recordId === canonicalRecordId)).toBe(true);
      expect(all.structuredContent.workingRecords.some((item: any) => item.reviewStatus === "proposed")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("keeps legacy v2 clients on the 2025 handshake and replays a write after a temporary response failure", async () => {
    const { app, projectId, url } = await setup();
    const originalFetch = globalThis.fetch;
    let temporaryResponseReturned = false;
    const fixtureFetch: typeof globalThis.fetch = async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      const response = await originalFetch(input, init);
      if (!temporaryResponseReturned && body.includes('"tools/call"') && body.includes('"add_owner_note"')) {
        temporaryResponseReturned = true;
        return new Response("temporary fixture outage", { status: 503, headers: { "content-type": "text/plain" } });
      }
      return response;
    };
    const client = new Client({ name: "CV07 legacy fixture", version: "1" });
    try {
      await client.connect(transport(url, fixtureFetch));
      expect(client.getProtocolEra()).toBe("legacy");
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect((await client.listTools()).tools).toHaveLength(35);

      const idempotencyKey = crypto.randomUUID();
      const arguments_ = {
        projectId,
        statement: "CV07 legacy replay fixture.",
        idempotencyKey,
      };
      let firstError: unknown;
      try {
        await client.callTool({ name: "add_owner_note", arguments: arguments_ });
      } catch (error) {
        firstError = error;
      }
      expect(firstError).toBeTruthy();
      expect(temporaryResponseReturned).toBe(true);

      const replay = await callTool(client, "add_owner_note", arguments_);
      expect(replay.isError).not.toBe(true);
      expect(replay.structuredContent.acceptedRecordIds).toHaveLength(1);
      const recordCount = app.app.ck.handle.sqlite.prepare(
        "SELECT count(*) AS n FROM records WHERE text=?",
      ).get("CV07 legacy replay fixture.") as { n: number };
      expect(recordCount.n).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("returns bounded responses for unknown methods and malformed legacy/modern requests", async () => {
    const { app } = await setup();
    const headers = {
      authorization: AUTHORIZATION,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const unknown = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: { jsonrpc: "2.0", id: "unknown", method: "contextkeep/unknown", params: {} },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().error).toMatchObject({ code: -32601 });

    const malformedJson = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: "{malformed",
    });
    expect(malformedJson.statusCode).toBe(400);
    expect(malformedJson.json()).toEqual({ error: "Invalid or failed MCP request." });

    const malformedModernEnvelope = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: {
        jsonrpc: "2.0",
        id: "modern-malformed",
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      },
    });
    expect(malformedModernEnvelope.statusCode).toBe(400);
    expect(malformedModernEnvelope.json().error).toMatchObject({ code: -32602 });
    expect(JSON.stringify(malformedModernEnvelope.json())).not.toContain(TOKEN);
  });
});
