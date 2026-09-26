import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpToolErrorResult, McpWorkContextResult } from "@contextkeep/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { atomicWrite, durableWrite, MCP_RESULT_BYTE_BUDGET, safeValue, toolError, toolResult } from "../src/mcp/safety.js";
import { ApiError } from "../src/lib/errors.js";
import { applyDump } from "../src/services/dump-import.js";
import { pruneTerminalIdempotencyClaims } from "../src/services/idempotency.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];
afterEach(async () => { for (const app of tracked.splice(0)) await app.cleanup(); });
async function setup() {
  const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
  const response = await t.post("/api/projects", { name: "MCP regression project", aliases: ["mcp-test"] });
  expect(response.statusCode).toBe(200);
  return { t, projectId: response.json<{ id: string }>().id };
}
async function rpc(t: TestApp, method: string, params: unknown = {}, headers = AUTHORIZE) {
  return t.app.inject({ method: "POST", url: "/mcp", headers,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params } });
}
async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(t, "tools/call", { name, arguments: args });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.error).toBeUndefined();
  return body.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent: any };
}
async function note(t: TestApp, projectId: string, statement = "Use a verified backup before deployment.") {
  const result = await call(t, "add_owner_note", { projectId, statement, recordType: "decision", idempotencyKey: crypto.randomUUID() });
  expect(result.isError).not.toBe(true);
  return result.structuredContent;
}
function count(t: TestApp, table: "records" | "handoffs" | "sources") {
  return (t.app.ck.handle.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("private ContextKeep MCP", () => {
  it("budgets the complete dual-content result using UTF-8 serialized bytes", () => {
    const safe = toolResult({ text: "é".repeat(100_000), escaped: '"\\\n' }, ["synthetic-secret"]);
    expect(Buffer.byteLength(JSON.stringify(safe), "utf8")).toBeLessThanOrEqual(MCP_RESULT_BYTE_BUDGET);
    expect(safe.content[0]?.text).toContain("\\\"");
    expect(() => toolResult({ text: "é".repeat(200_000) }, [])).toThrow(
      expect.objectContaining({ code: "result_too_large" }),
    );
  });

  it("is disabled without explicit configuration", async () => {
    const t = await makeTestApp(); tracked.push(t);
    const res = await rpc(t, "tools/list"); expect(res.statusCode).toBe(404);
  });
  it("rejects absent/wrong bearer, browser cookies, browser origins, and non-POST methods", async () => {
    const { t } = await setup();
    for (const headers of [{}, { authorization: "Bearer wrong" }, { cookie: t.cookie }]) {
      const res = await t.app.inject({ method: "POST", url: "/mcp", headers, payload: {} });
      expect(res.statusCode).toBe(401); expect(res.body).not.toContain(TOKEN);
    }
    const origin = await t.app.inject({ method: "POST", url: "/mcp", headers: { ...AUTHORIZE, origin: "https://evil.example" }, payload: {} });
    expect(origin.statusCode).toBe(403);
    for (const method of ["GET", "DELETE"] as const) {
      const res = await t.app.inject({ method, url: "/mcp", headers: AUTHORIZE });
      expect(res.statusCode).toBe(405);
    }
    expect((await t.raw("GET", "/api/projects")).statusCode).toBe(401);
    expect((await t.get("/api/projects")).statusCode).toBe(200);
  });
  it("advertises complete schemas and correct read/write annotations", async () => {
    const { t } = await setup();
    const init = await rpc(t, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.statusCode).toBe(200); expect(init.json().result.serverInfo.name).toBe("ContextKeep");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    const res = await rpc(t, "tools/list"); const tools = res.json().result.tools;
    expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      "list_projects", "get_project", "get_work_context", "get_project_brief", "get_project_timeline", "search_context",
      "get_record", "get_context_delta", "list_blockers", "resolve_blocker", "create_handoff", "add_owner_note", "add_source", "capture_working_memory", "capture_work", "propose_correction",
    ]));
    expect(tools).toHaveLength(35);
    expect(tools.filter((tool: any) => tool.annotations.readOnlyHint)).toHaveLength(18);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object"); expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeTruthy();
      expect(tool.outputSchema.type).toBe("object");
      if (!tool.annotations.readOnlyHint) expect(tool.inputSchema.required).toContain("idempotencyKey");
    }
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));
    const successSchema = (name: string) => byName.get(name).outputSchema.anyOf[0];
    expect(successSchema("get_work_context").properties.freshness.type).toBe("object");
    expect(successSchema("get_context_delta").properties.highWatermark.type).toBe("object");
    expect(successSchema("get_record").properties.evidence.type).toBe("array");
    expect(successSchema("capture_work").properties.outcome.type).toBe("object");
    expect(successSchema("list_blockers").properties.pagination.type).toBe("object");
    expect(successSchema("get_capabilities").properties.protocols.type).toBe("object");
    const catalogBytes = Buffer.byteLength(JSON.stringify(tools));
    console.log("MCF09_CATALOG_BYTES", catalogBytes);
    expect(catalogBytes).toBeLessThan(200_000);
  });
  it("keeps every registered tool on the shared success/error output envelope without duplicating a tool-name fixture", async () => {
    const { t } = await setup();
    const listed = await rpc(t, "tools/list");
    const tools = listed.json().result.tools as Array<{
      name: string;
      outputSchema: { anyOf?: unknown[]; type?: string };
    }>;
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.outputSchema?.anyOf, tool.name).toHaveLength(2);
      const result = await call(t, tool.name, {});
      if (result.isError) {
        expect(McpToolErrorResult.safeParse(result.structuredContent).success, tool.name).toBe(true);
      } else {
        expect(result.structuredContent, tool.name).toBeTruthy();
        expect(result.structuredContent.error, tool.name).toBeUndefined();
      }
    }
  });

  it("keeps a max-length task at the minimum context budget schema-valid with diagnostics on and off", async () => {
    const { t, projectId } = await setup();
    const task = "x".repeat(2_000);
    for (const diagnostics of [false, true]) {
      const result = await call(t, "get_work_context", {
        projectId,
        task,
        limitPerSection: 5,
        totalContextBudgetChars: 2_000,
        diagnostics,
      });
      if (result.isError) {
        expect(McpToolErrorResult.safeParse(result.structuredContent).success).toBe(true);
        expect(result.structuredContent.error.code).not.toBe("mcp_output_schema_mismatch");
      } else {
        expect(McpWorkContextResult.safeParse(result.structuredContent).success).toBe(true);
        expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(2_000);
        expect(typeof result.structuredContent.indicators.stale).toBe("boolean");
      }
    }
  });

  it("round-trips a real SDK Client over Streamable HTTP", async () => {
    const { t, projectId } = await setup();
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address(); if (!address || typeof address === "string") throw new Error("No TCP address");
    const client = new Client({ name: "ContextKeep acceptance", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
      expect((await client.listTools()).tools).toHaveLength(35);
      const result = await client.callTool({ name: "get_project", arguments: { projectId } });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as any).project.id).toBe(projectId);
      const errorResult = await client.callTool({ name: "get_project", arguments: { projectId: crypto.randomUUID() } });
      expect(errorResult.isError).toBe(true);
      expect(McpToolErrorResult.safeParse(errorResult.structuredContent).success).toBe(true);
      expect((errorResult.structuredContent as any).error).toMatchObject({
        code: "project_not_found",
        retryable: false,
        nextAction: "fix_input_or_state",
      });
      const capabilities = await client.callTool({ name: "get_capabilities", arguments: {} });
      expect(capabilities.isError).not.toBe(true);
      expect((capabilities.structuredContent as any).contractVersion).toBe("mcp-first-v1");
      expect((capabilities.structuredContent as any).protocols.latest).toBe("2026-07-28");
      expect((capabilities.structuredContent as any).protocols.supported).toEqual(expect.arrayContaining(["2026-07-28", "2025-11-25"]));
    } finally { await client.close(); }
  });
  it("persists owner declarations with evidence and actor audit, readable through all read tools", async () => {
    const { t, projectId } = await setup();
    await note(t, projectId);
    const list = (await call(t, "list_projects")).structuredContent;
    expect(list.projects.some((project: any) => project.id === projectId)).toBe(true);
    const brief = (await call(t, "get_project_brief", { projectId })).structuredContent;
    expect(brief.sections.decisions.total).toBe(1);
    const recordId = brief.sections.decisions.items[0].recordId;
    const record = (await call(t, "get_record", { recordId })).structuredContent;
    expect(record.reviewStatus).toBe("accepted"); expect(record.evidenceBasis).toBe("owner_declaration");
    expect(record.evidence.length).toBeGreaterThan(0);
    const events = t.app.ck.handle.sqlite.prepare("SELECT actor FROM audit_events WHERE actor = 'owner:mcp'").all();
    expect(events.length).toBeGreaterThan(0);
    const timeline = (await call(t, "get_project_timeline", { projectId })).structuredContent;
    expect(timeline.entries[0].record.recordId).toBe(recordId);
    const search = (await call(t, "search_context", { q: "verified backup", projectId })).structuredContent;
    expect(search.records.some((item: any) => item.recordId === recordId)).toBe(true);
    const globalSearch = (await call(t, "search_context", { q: "verified backup" })).structuredContent;
    expect(globalSearch.records.some((item: any) => item.recordId === recordId)).toBe(true);
    const handoff = (await call(t, "create_handoff", { projectId, idempotencyKey: crypto.randomUUID() })).structuredContent;
    expect(handoff.markdown).toContain("verified backup"); expect(handoff.includedRecordIds).toContain(recordId);
  });
  it("replays each write without duplication and rejects changed requests using the same key", async () => {
    const { t, projectId } = await setup();
    const args = { projectId, statement: "A deterministic owner note.", idempotencyKey: crypto.randomUUID() };
    const first = await call(t, "add_owner_note", args); const before = count(t, "records");
    const second = await call(t, "add_owner_note", args);
    expect(second).toEqual(first); expect(count(t, "records")).toBe(before);
    const changed = await call(t, "add_owner_note", { ...args, statement: "Another statement." });
    expect(changed.isError).toBe(true); expect(changed.structuredContent.error.code).toBe("idempotency_key_reused");
    const handoffArgs = { projectId, idempotencyKey: crypto.randomUUID() };
    const h1 = await call(t, "create_handoff", handoffArgs); const h2 = await call(t, "create_handoff", handoffArgs);
    expect(h1.structuredContent.id).toBeTruthy(); expect(h2).toEqual(h1);
    const sourceArgs = { projectId, text: "Proposed unreviewed raw source for a project.", idempotencyKey: crypto.randomUUID() };
    const s1 = await call(t, "add_source", sourceArgs); const sources = count(t, "sources");
    expect(s1.isError).not.toBe(true); expect(await call(t, "add_source", sourceArgs)).toEqual(s1);
    expect(count(t, "sources")).toBe(sources);
  });

  it("compacted create_handoff receipts expire without creating a second handoff", async () => {
    const { t, projectId } = await setup();
    const idempotencyKey = crypto.randomUUID();
    const args = { projectId, idempotencyKey };
    const first = await call(t, "create_handoff", args);
    expect(first.isError).not.toBe(true);
    expect(count(t, "handoffs")).toBe(1);

    t.app.ck.handle.sqlite.prepare("UPDATE idempotency_requests SET updated_at=? WHERE key=?")
      .run("2026-08-01T00:00:00.000Z", `mcp:${idempotencyKey}`);
    expect(pruneTerminalIdempotencyClaims(t.app.ck.deps.sqlite, 30, Date.parse("2026-09-20T00:00:00.000Z"))).toBe(1);

    const expired = await call(t, "create_handoff", args);
    expect(expired.isError).toBe(true);
    expect(expired.structuredContent.error.code).toBe("idempotency_result_expired");
    expect(expired.structuredContent.error.message).toMatch(/completed|expired/i);
    expect(count(t, "handoffs")).toBe(1);

    const changed = await call(t, "create_handoff", { ...args, objective: "changed payload" });
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent.error.code).toBe("idempotency_key_reused");
    expect(count(t, "handoffs")).toBe(1);
  });
  it("releases atomic MCP claims after rolled-back internal failures but caches deterministic 4xx errors", async () => {
    const { t } = await setup();

    const retryKey = crypto.randomUUID();
    let retryAttempts = 0;
    const first = atomicWrite(
      t.app.ck.deps,
      "test_atomic_retry",
      { idempotencyKey: retryKey },
      () => {
        retryAttempts += 1;
        throw new Error("transient internal failure");
      },
      [],
    );
    expect(first.isError).toBe(true);
    expect(retryAttempts).toBe(1);
    expect(
      t.app.ck.handle.sqlite.prepare("SELECT state FROM idempotency_requests WHERE key=?").get(`mcp:${retryKey}`),
    ).toBeUndefined();

    const second = atomicWrite(
      t.app.ck.deps,
      "test_atomic_retry",
      { idempotencyKey: retryKey },
      () => {
        retryAttempts += 1;
        return { ok: true };
      },
      [],
    );
    expect(second.isError).not.toBe(true);
    expect(retryAttempts).toBe(2);
    expect(
      (t.app.ck.handle.sqlite.prepare("SELECT state FROM idempotency_requests WHERE key=?").get(`mcp:${retryKey}`) as { state: string }).state,
    ).toBe("completed");

    const deterministicKey = crypto.randomUUID();
    let deterministicAttempts = 0;
    const invalid = () => atomicWrite(
      t.app.ck.deps,
      "test_atomic_validation",
      { idempotencyKey: deterministicKey },
      () => {
        deterministicAttempts += 1;
        throw new ApiError(409, "deterministic_test_error", "This error is stable.");
      },
      [],
    );
    const invalidFirst = invalid();
    const invalidReplay = invalid();
    expect(invalidFirst).toEqual(invalidReplay);
    expect(invalidReplay.isError).toBe(true);
    expect(deterministicAttempts).toBe(1);
  });

  it("classifies deterministic MCP failures as non-retryable and only explicit transient availability as same-request retry", async () => {
    const contract = toolError(
      new ApiError(500, "mcp_output_schema_mismatch", "Declared output contract mismatch."),
      [],
    );
    expect(contract.isError).toBe(true);
    expect((contract.structuredContent as any).error).toMatchObject({
      code: "mcp_output_schema_mismatch",
      retryable: false,
      nextAction: "report_contract_error",
    });

    const internal = toolError(new Error("deterministic internal bug"), []);
    expect((internal.structuredContent as any).error).toMatchObject({
      code: "internal_error",
      retryable: false,
      nextAction: "report_internal_error",
    });

    const transient = toolError(
      new ApiError(503, "service_unavailable", "Temporary dependency outage."),
      [],
    );
    expect((transient.structuredContent as any).error).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      nextAction: "retry_same_request",
    });

    const expired = toolError(
      new ApiError(409, "context_delta_page_expired", "The old page token expired."),
      [],
    );
    expect((expired.structuredContent as any).error).toMatchObject({
      code: "context_delta_page_expired",
      retryable: false,
      nextAction: "restart_from_committed_cursors",
    });
  });

  it("reports an async write timeout as unknown outcome and preserves the stable event key", async () => {
    const { t } = await setup();
    const idempotencyKey = crypto.randomUUID();
    const first = await durableWrite(
      t.app.ck.deps,
      "test_async_timeout",
      { idempotencyKey },
      async () => {
        throw new Error("simulated transport timeout after dispatch");
      },
      [],
    );
    expect(first.isError).toBe(true);
    expect((first.structuredContent as any).error).toMatchObject({
      code: "idempotency_outcome_unknown",
      retryable: false,
      nextAction: "reconcile_state_before_retry",
    });
    const row = t.app.ck.handle.sqlite
      .prepare("SELECT key,state FROM idempotency_requests WHERE key=?")
      .get(`mcp:${idempotencyKey}`) as { key: string; state: string };
    expect(row).toEqual({ key: `mcp:${idempotencyKey}`, state: "indeterminate" });

    await expect(
      durableWrite(
        t.app.ck.deps,
        "test_async_timeout",
        { idempotencyKey },
        async () => ({ shouldNotRun: true }),
        [],
      ),
    ).rejects.toMatchObject({ code: "idempotency_outcome_unknown" });
  });

  it("does not promote source imports or proposed corrections into accepted truth", async () => {
    const { t, projectId } = await setup(); await note(t, projectId, "Keep the original confirmed decision.");
    let brief = (await call(t, "get_project_brief", { projectId })).structuredContent;
    const recordId = brief.sections.decisions.items[0].recordId;
    const proposal = await call(t, "propose_correction", { projectId, statement: "Replace with a different proposed decision.", recordType: "decision", supersedesRecordIds: [recordId], idempotencyKey: crypto.randomUUID() });
    expect(proposal.isError).not.toBe(true);
    await call(t, "add_source", { projectId, text: "Unreviewed source content must not become accepted facts.", idempotencyKey: crypto.randomUUID() });
    brief = (await call(t, "get_project_brief", { projectId })).structuredContent;
    expect(brief.sections.decisions.items.map((record: any) => record.recordId)).toEqual([recordId]);
    expect((await call(t, "get_record", { recordId: proposal.structuredContent.proposedRecordIds[0] })).isError).toBe(true);
  });
  it("keeps superseded history labeled and paginates without losing records", async () => {
    const { t, projectId } = await setup();
    await note(t, projectId, "Historical backup method alpha.");
    const old = (await call(t, "get_project_brief", { projectId })).structuredContent.sections.decisions.items[0].recordId;
    const proposal = (await call(t, "propose_correction", { projectId, statement: "Current backup method beta.", recordType: "decision", supersedesRecordIds: [old], idempotencyKey: crypto.randomUUID() })).structuredContent;
    expect((await t.post(`/api/corrections/${proposal.jobId}/confirm`)).statusCode).toBe(200);
    const timeline = (await call(t, "get_project_timeline", { projectId, limit: 1 })).structuredContent;
    expect(timeline.total).toBe(2); expect(timeline.nextOffset).toBe(1);
    const second = (await call(t, "get_project_timeline", { projectId, offset: 1, limit: 1 })).structuredContent;
    expect(second.entries[0].record.reviewStatus).toBe("superseded"); expect(second.entries[0].supersededBy).not.toBeNull();
    const current = (await call(t, "search_context", { q: "alpha", projectId })).structuredContent;
    expect(current.records).toHaveLength(0);
    const history = (await call(t, "search_context", { q: "alpha", projectId, includeHistorical: true })).structuredContent;
    expect(history.records[0].reviewStatus).toBe("superseded");
  });
  it("returns bounded safe errors for bad inputs, missing projects, unknown tools and disallowed properties", async () => {
    const { t, projectId } = await setup();
    for (const [name, args, code] of [
      ["get_project", { projectId: "not-a-uuid" }, "invalid_input"],
      ["get_project", { projectId: crypto.randomUUID() }, "project_not_found"],
      ["search_context", { q: "backup", projectId: crypto.randomUUID() }, "project_not_found"],
      ["get_project", { projectId, sql: "SELECT * FROM sessions" }, "invalid_input"],
      ["add_owner_note", { projectId, statement: "Unkeyed note" }, "invalid_input"],
      ["arbitrary_sql", {}, "tool_not_found"],
      ["search_context", { q: " " }, "invalid_input"],
    ] as const) {
      const result = await call(t, name, args); expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe(code);
    }
    const missingWrite = await call(t, "add_owner_note", { projectId: crypto.randomUUID(), statement: "Do not create me.", idempotencyKey: crypto.randomUUID() });
    expect(missingWrite.structuredContent.error.code).toBe("project_not_found");
  });
  it("rejects credential input and redacts known secrets at every response boundary", async () => {
    const { t, projectId } = await setup(); const before = count(t, "records");
    for (const statement of [TOKEN, `Bearer ${"A".repeat(40)}`, `SERVICE_PASSWORD=${"x".repeat(30)}`]) {
      const result = await call(t, "add_owner_note", { projectId, statement, idempotencyKey: crypto.randomUUID() });
      expect(result.isError).toBe(true); expect(result.structuredContent.error.code).toBe("credential_detected");
      expect(JSON.stringify(result)).not.toContain(statement);
    }
    expect(count(t, "records")).toBe(before);
    expect(JSON.stringify(safeValue({ evidence: { text: TOKEN }, list: [`Bearer ${"q".repeat(40)}`] }, [TOKEN]))).not.toContain(TOKEN);
    await t.patch(`/api/projects/${projectId}`, { revision: 1, description: `Legacy credential ${TOKEN}` });
    expect(JSON.stringify(await call(t, "get_project", { projectId }))).not.toContain(TOKEN);
  });
  it("refuses malformed/oversized messages without echoing their contents", async () => {
    const { t } = await setup();
    const invalid = await t.app.inject({ method: "POST", url: "/mcp", headers: { ...AUTHORIZE, "content-type": "application/json" }, payload: `{"secret":"${TOKEN}` });
    expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain(TOKEN);
    const huge = await rpc(t, "tools/call", { name: "search_context", arguments: { q: "x".repeat(140000) } });
    expect(huge.statusCode).toBe(413); expect(huge.body.length).toBeLessThan(200);
  });
  it("rate-limits unauthorized requests before the authentication hook returns", async () => {
    const { t } = await setup();
    let status = 0;
    for (let i = 0; i < 125 && status !== 429; i++) {
      const response = await t.app.inject({ method: "POST", url: "/mcp", payload: {} });
      status = response.statusCode;
      expect([401, 429]).toContain(status);
    }
    expect(status).toBe(429);
  });
  it("returns JSON 404 rather than the web SPA during tunnel OAuth discovery", async () => {
    const { t } = await setup();
    for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
      "/mcp/.well-known/oauth-protected-resource", "/mcp/unknown"]) {
      const response = await t.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain("<!doctype html>");
    }
  });
  it("marks authenticated MCP output non-cacheable and refuses token-in-URL authentication", async () => {
    const { t } = await setup();
    expect((await rpc(t, "tools/list")).headers["cache-control"]).toBe("no-store");
    const response = await t.app.inject({ method: "POST", url: `/mcp?token=${TOKEN}`, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(TOKEN);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("enforces the per-route rate limit", async () => {
    const { t } = await setup(); let limited = false;
    for (let i = 0; i < 122; i++) {
      const response = await rpc(t, "tools/list");
      if (response.statusCode === 429) { limited = true; break; }
      expect(response.statusCode).toBe(200);
    }
    expect(limited).toBe(true);
  });
  it("rolls back owner note evidence/proposals when canonical confirmation fails", async () => {
    const { t, projectId } = await setup(); const before = count(t, "sources");
    t.app.ck.handle.sqlite.exec("CREATE TRIGGER test_mcp_fail_accept BEFORE UPDATE OF review_status ON records WHEN NEW.review_status = 'accepted' BEGIN SELECT RAISE(ABORT, 'test injected confirmation failure'); END");
    const result = await call(t, "add_owner_note", { projectId, statement: "This whole write must roll back.", idempotencyKey: crypto.randomUUID() });
    expect(result.isError).toBe(true); expect(count(t, "sources")).toBe(before); expect(count(t, "records")).toBe(0);
    t.app.ck.handle.sqlite.exec("DROP TRIGGER test_mcp_fail_accept");
  });
  it("durably replays a completed mutation after restarting ContextKeep", async () => {
    const { t, projectId } = await setup();
    const args = { projectId, statement: "This note survives a server restart.", idempotencyKey: crypto.randomUUID() };
    const first = await call(t, "add_owner_note", args);
    await t.app.close();
    t.app = await buildApp({ config: t.config, logger: false });
    try {
      const second = await call(t, "add_owner_note", args);
      expect(second).toEqual(first); expect((await call(t, "list_projects")).structuredContent.projects).toHaveLength(1);
      expect(count(t, "records")).toBe(1);
    } finally { await t.app.close(); }
  });
});

describe("MCP complete memory workflow", () => {
  const key = () => crypto.randomUUID();
  async function ok(t: TestApp, name: string, args: Record<string, unknown>) {
    const r=await call(t,name,args); expect(r.isError,JSON.stringify(r.structuredContent)).not.toBe(true); return r.structuredContent;
  }
  async function proposed(t: TestApp, projectId: string, text="Observed verification result", recordType="fact") {
    const imported=await ok(t,"add_source",{projectId,text:text+" source "+key(),authorLabel:"verification agent",idempotencyKey:key()});
    const source=await ok(t,"get_source",{sourceId:imported.source.id});
    return (await ok(t,"create_record",{projectId,sourceExcerptId:source.excerpts[0].id,recordType,subject:"verification",text,evidenceBasis:"observed_technical",idempotencyKey:key()})).record;
  }
  it("creates, edits and retires projects without cycles or stale overwrites",async()=>{
    const {t,projectId}=await setup();
    const args={name:"Created via MCP",parentId:projectId,idempotencyKey:key()};
    const made=await ok(t,"create_project",args);expect(await ok(t,"create_project",args)).toEqual(made);
    expect((await call(t,"update_project",{projectId,revision:1,parentId:made.id,idempotencyKey:key()})).structuredContent.error.code).toBe("project_cycle");
    const changed=await ok(t,"update_project",{projectId:made.id,revision:1,description:"Updated metadata",idempotencyKey:key()});
    expect(changed.revision).toBe(2);
    expect((await call(t,"update_project",{projectId:made.id,revision:1,name:"stale",idempotencyKey:key()})).structuredContent.error.code).toBe("stale_revision");
    await ok(t,"set_project_lifecycle",{projectId:made.id,revision:2,state:"retired",reason:"Owner archives the test project.",idempotencyKey:key()});
    const retired=await ok(t,"get_project",{projectId:made.id});expect(retired.project.lifecycle).toBe("retired");
    await ok(t,"set_project_lifecycle",{projectId:made.id,revision:retired.project.revision,state:"active",reason:"Owner reactivates test project.",idempotencyKey:key()});
    expect((await ok(t,"get_project",{projectId:made.id})).project.lifecycle).toBe("active");
    const page=await ok(t,"list_projects",{limit:1});expect(page.total).toBe(2);expect(page.nextOffset).toBe(1);
    expect((await ok(t,"list_projects",{limit:1,offset:1})).projects[0].id).not.toBe(page.projects[0].id);
  });
  it("allows repeated lifecycle transitions with the same reason text", async () => {
    const { t, projectId } = await setup();
    await ok(t, "set_project_lifecycle", { projectId, revision: 1, state: "active", reason: "Owner requested status change.", idempotencyKey: key() });
    const active = await ok(t, "get_project", { projectId });
    const paused = await ok(t, "set_project_lifecycle", {
      projectId,
      revision: active.project.revision,
      state: "paused",
      reason: "Owner requested status change.",
      idempotencyKey: key(),
    });
    expect(paused.acceptedRecordIds.length).toBeGreaterThan(0);
    expect((await ok(t, "get_project", { projectId })).project.lifecycle).toBe("paused");
  });

  it("blocks review_records from accepting an evidence-free imported proposal", async () => {
    const { t, projectId } = await setup();
    const recordId = crypto.randomUUID();
    const now = new Date().toISOString();
    applyDump(
      t.app.ck.deps,
      {
        dump: {
          format: "contextkeep.json_dump",
          version: 1,
          projects: [],
          sources: [],
          sourceExcerpts: [],
          records: [{
            id: recordId,
            projectId,
            type: "fact",
            subject: "evidence-free",
            predicate: null,
            valueJson: null,
            text: "Imported proposal without supporting evidence.",
            reviewStatus: "proposed",
            evidenceBasis: "document",
            taskStatus: null,
            recordDedupHash: crypto.randomUUID(),
            recordedAt: now,
            sourceEventAt: now,
            effectiveFrom: null,
            effectiveTo: null,
            reviewedAt: null,
            reviewDueAt: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          }],
          recordEvidence: [],
          supersessions: [],
        },
        mode: "merge",
        source: "review-evidence-regression",
      },
      { actor: "test:import", requestId: crypto.randomUUID() },
    );
    const result = await call(t, "review_records", {
      items: [{ recordId, revision: 1 }],
      action: "accept",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.structuredContent.accepted).toEqual([]);
    expect(result.structuredContent.blocked[0]).toMatchObject({ recordId, code: "evidence_required" });
  });
  it("does not accept a proposal backed only by contradicting evidence", async () => {
    const { t, projectId } = await setup();
    const source = await ok(t, "add_source", {
      projectId,
      text: "Contradicting-only evidence for review acceptance.",
      authorLabel: "agent report",
      idempotencyKey: key(),
    });
    const loadedSource = await ok(t, "get_source", { sourceId: source.source.id });
    const record = await ok(t, "create_record", {
      projectId,
      sourceExcerptId: loadedSource.excerpts[0].id,
      recordType: "fact",
      subject: "contradicts-only",
      text: "This assertion must not become canonical.",
      evidenceBasis: "agent_report",
      idempotencyKey: key(),
    });
    t.app.ck.handle.sqlite.prepare("UPDATE record_evidence SET relation='contradicts' WHERE record_id=?").run(record.record.id);
    const result = await call(t, "review_records", {
      items: [{ recordId: record.record.id, revision: record.record.revision }],
      action: "accept",
      idempotencyKey: key(),
    });
    expect(result.structuredContent.accepted).toEqual([]);
    expect(result.structuredContent.blocked[0]).toMatchObject({ recordId: record.record.id, code: "evidence_required" });
  });

  it("supports evidence, inbox, edits, review, task completion, recoverable deletion and restoration",async()=>{
    const {t,projectId}=await setup();
    const record=await proposed(t,projectId,"Measure the MCP response","action");
    expect((await ok(t,"get_project_brief",{projectId})).sections.actions.total).toBe(0);
    expect((await ok(t,"list_records",{projectId,reviewStatus:"proposed"})).total).toBe(1);
    const edited=await ok(t,"edit_record",{recordId:record.id,revision:1,text:"Measure and record MCP response",taskStatus:"in_progress",idempotencyKey:key()});
    expect(edited.revision).toBe(2);
    await ok(t,"review_records",{items:[{recordId:record.id,revision:2}],action:"accept",idempotencyKey:key()});
    const accepted=await ok(t,"get_record",{recordId:record.id});
    expect(accepted.evidenceBasis).toBe("observed_technical");expect(accepted.evidence.length).toBe(1);
    expect((await call(t,"edit_record",{recordId:record.id,revision:accepted.revision,text:"Forbidden silent rewrite",idempotencyKey:key()})).structuredContent.error.code).toBe("semantic_edit_requires_correction");
    const done=await ok(t,"edit_record",{recordId:record.id,revision:accepted.revision,taskStatus:"done",idempotencyKey:key()});
    expect((await ok(t,"get_project_brief",{projectId})).sections.actions.total).toBe(0);
    const delArgs={recordId:record.id,revision:done.revision,reason:"Recoverable deletion test",idempotencyKey:key()};
    const deleted=await ok(t,"delete_record",delArgs);expect(await ok(t,"delete_record",delArgs)).toEqual(deleted);
    expect((await ok(t,"search_context",{projectId,q:"Measure"})).records).toHaveLength(0);
    expect((await ok(t,"get_project_timeline",{projectId})).total).toBe(0);
    const hidden=await ok(t,"get_record",{recordId:record.id,includeUnreviewed:true});expect(hidden.deletionId).toBe(deleted.deletionId);
    expect((await call(t,"edit_record",{recordId:record.id,revision:hidden.revision,taskStatus:"open",idempotencyKey:key()})).structuredContent.error.code).toBe("record_deleted");
    const restoreArgs={recordId:record.id,revision:deleted.revision,deletionId:deleted.deletionId,idempotencyKey:key()};
    const restored=await ok(t,"restore_record",restoreArgs);expect(restored.record.reviewStatus).toBe("accepted");expect(restored.record.taskStatus).toBe("done");
    expect(await ok(t,"restore_record",restoreArgs)).toEqual(restored);
    expect((await ok(t,"get_record",{recordId:record.id})).evidence.length).toBe(1);
    expect((await ok(t,"get_audit",{targetType:"record",targetId:record.id})).items.some((x:any)=>x.detail?.includes("record.restore"))).toBe(true);
  });
  it("confirms corrections through MCP and only publishes confirmed history links",async()=>{
    const {t,projectId}=await setup();
    const original=await note(t,projectId,"Original alpha method");const old=original.acceptedRecordIds[0];
    const proposal=await ok(t,"propose_correction",{projectId,statement:"Replacement beta method",recordType:"decision",supersedesRecordIds:[old],idempotencyKey:key()});
    expect((await ok(t,"get_project_timeline",{projectId})).entries[0].supersededBy).toBeNull();
    const preview=await ok(t,"get_correction",{jobId:proposal.jobId});expect(preview.stage).toBe("presented");
    const args={jobId:proposal.jobId,idempotencyKey:key()};await ok(t,"confirm_correction",args);await ok(t,"confirm_correction",args);
    expect((await ok(t,"get_record",{recordId:old})).reviewStatus).toBe("superseded");
    const handoff=await ok(t,"create_handoff",{projectId,idempotencyKey:key()});
    expect((await ok(t,"list_handoffs",{projectId})).items[0].id).toBe(handoff.id);
    const saved=await ok(t,"get_handoff",{handoffId:handoff.id,maxChars:20});expect(saved.markdown.length).toBe(20);expect(saved.nextOffset).toBe(20);
    expect((await ok(t,"get_handoff",{handoffId:handoff.id,offset:20})).markdown).toBe(handoff.markdown.slice(20));
  });
  it("rejects cross-project evidence, stale batch review and restoration conflicts",async()=>{
    const {t,projectId}=await setup();const a=await proposed(t,projectId,"Duplicate restoration test");
    const other=await ok(t,"create_project",{name:"Other scope",idempotencyKey:key()});
    const detail=await ok(t,"get_record",{recordId:a.id,includeUnreviewed:true});
    expect((await call(t,"create_record",{projectId:other.id,sourceExcerptId:detail.evidence[0].excerptId,recordType:"fact",subject:"bad",text:"Bad scope",idempotencyKey:key()})).structuredContent.error.code).toBe("evidence_project_mismatch");
    const b=await proposed(t,projectId,"Second proposed observation");
    const changed=await ok(t,"edit_record",{recordId:b.id,revision:1,text:"Changed observation",idempotencyKey:key()});
    const stale=await call(t,"review_records",{items:[{recordId:a.id,revision:1},{recordId:b.id,revision:1}],action:"accept",idempotencyKey:key()});
    expect(stale.structuredContent.error.code).toBe("stale_revision");
    expect(stale.structuredContent.error.retryable).toBe(false);
    expect(stale.structuredContent.error.nextAction).toBe("read_current_revision");
    expect(stale.structuredContent.error.currentRevision).toBe(2);
    expect((await ok(t,"get_record",{recordId:a.id,includeUnreviewed:true})).reviewStatus).toBe("proposed");
    const deleted=await ok(t,"delete_record",{recordId:a.id,revision:1,reason:"Delete proposal",idempotencyKey:key()});
    await ok(t,"create_record",{projectId,sourceExcerptId:detail.evidence[0].excerptId,recordType:"fact",subject:a.subject,text:a.text,idempotencyKey:key()});
    expect((await call(t,"restore_record",{recordId:a.id,revision:deleted.revision,deletionId:deleted.deletionId,idempotencyKey:key()})).structuredContent.error.code).toBe("restore_conflict");
    expect((await ok(t,"get_record",{recordId:a.id,includeUnreviewed:true})).deletionId).toBe(deleted.deletionId);
    expect(changed.revision).toBe(2);
  });
  it("review_records shares REST revision preflight errors for duplicate and missing targets", async () => {
    const { t, projectId } = await setup();
    const record = await proposed(t, projectId, "Revision parity proposal");

    const duplicate = await call(t, "review_records", {
      items: [
        { recordId: record.id, revision: record.revision },
        { recordId: record.id, revision: record.revision + 1 },
      ],
      action: "accept",
      idempotencyKey: key(),
    });
    expect(duplicate.structuredContent.error.code).toBe("review_revision_conflict");
    expect((await ok(t, "get_record", { recordId: record.id, includeUnreviewed: true })).reviewStatus).toBe("proposed");

    const missing = await call(t, "review_records", {
      items: [{ recordId: "00000000-0000-4000-8000-000000000099", revision: 1 }],
      action: "reject",
      idempotencyKey: key(),
    });
    expect(missing.structuredContent.error.code).toBe("record_not_found");
    expect((await ok(t, "get_record", { recordId: record.id, includeUnreviewed: true })).reviewStatus).toBe("proposed");
  });

  it("rolls back mutation and retry receipt together if receipt finalization fails",async()=>{
    const {t,projectId}=await setup();const db=t.app.ck.handle.sqlite;
    db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON idempotency_requests WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
    const args={projectId,statement:"Atomic receipt regression",idempotencyKey:key()};
    const first=await call(t,"add_owner_note",args);expect(first.isError).toBe(true);expect(count(t,"records")).toBe(0);
    db.exec("DROP TRIGGER fail_receipt");
    expect((await ok(t,"add_owner_note",args)).acceptedRecordIds).toHaveLength(1);
  });
  it("returns actionable numeric limits and complete capability metadata",async()=>{
    const {t,projectId}=await setup();
    const result=await call(t,"search_context",{projectId,q:"test",limit:20});
    expect(result.structuredContent.error.issues[0].path).toBe("limit");
    expect(result.structuredContent.error.issues[0].message).toContain("15");
    const cap=await ok(t,"get_capabilities",{});
    expect(cap.tools).toHaveLength(35);
    expect(cap.version).toBe("2.10.1");
    expect(cap.applicationVersion).toBe("0.1.0");
    expect(cap.schemaVersion).toBe(16);
    expect(cap.contractVersion).toBe("mcp-first-v1");
    expect(cap.protocols.latest).toBe("2026-07-28");
    expect(cap.protocols.supported).toEqual(expect.arrayContaining(["2026-07-28","2025-11-25","2025-06-18","2025-03-26"]));
    expect(cap.limits.resultBytes).toBe(750000);
    expect(cap.recommendedWorkflow).toContain("get_work_context");
    expect(cap.tools.some((x:any)=>x.name==="delete_record" && !x.readOnly)).toBe(true);
  });
});
