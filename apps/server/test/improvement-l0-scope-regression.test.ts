import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => { for (const app of tracked.splice(0)) await app.cleanup(); });

async function call(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST", url: "/mcp", headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as { isError?: boolean; structuredContent: any };
}

describe("L0.2 workspace-associated evidence scope regression", () => {
  it("F03: REST, MCP list/get and create_record use the same workspace-associated membership rule", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = (await t.post("/api/projects", { name: "Workspace evidence fixture" })).json<{ id: string }>();
    const imported = await t.post("/api/imports/text", {
      text: "Source archived before its workspace was linked to the project.",
      adapterId: "manual",
    });
    expect(imported.statusCode).toBe(201);
    const sourceId = imported.json<{ source: { id: string } }>().source.id;

    const workspaceId = crypto.randomUUID();
    const now = "2026-09-17T09:04:00.000Z";
    t.app.ck.handle.sqlite.prepare(
      "INSERT INTO workspace_bindings(id,canonical_key,canonical_path,display_name,project_id,first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(workspaceId, "fixture:workspace", "/tmp/ck-l0-scope-fixture", "L0 workspace", project.id, now, now, now, now);
    t.app.ck.handle.sqlite.prepare(
      "INSERT INTO source_origins(id,source_id,connector,external_id,workspace_binding_id,created_at) VALUES(?,?,?,?,?,?)",
    ).run(crypto.randomUUID(), sourceId, "codex", "l0-session", workspaceId, now);

    const restSources = (await t.get(`/api/sources?projectId=${project.id}`)).json<Array<{ id: string }>>();
    const mcpSources = (await call(t, "list_sources", { projectId: project.id })).structuredContent;
    const detail = (await call(t, "get_source", { sourceId })).structuredContent;
    expect(detail.projectIds).toContain(project.id);
    const restDetail = (await t.get(`/api/sources/${sourceId}`)).json<{ projectIds: string[] }>();
    expect(restDetail.projectIds).toContain(project.id);
    const proposal = await call(t, "create_record", {
      projectId: project.id,
      sourceExcerptId: detail.excerpts[0].id,
      recordType: "fact",
      subject: "linked evidence",
      text: "The linked source contains a verification result.",
      evidenceBasis: "observed_technical",
      idempotencyKey: crypto.randomUUID(),
    });

    const mismatches: string[] = [];
    if (restSources.length !== mcpSources.total) mismatches.push(`REST=${restSources.length}, MCP=${mcpSources.total}`);
    if (proposal.isError) mismatches.push(`create_record=${proposal.structuredContent.error?.code ?? "unknown_error"}`);
    expect(mismatches).toEqual([]);
  });
});
