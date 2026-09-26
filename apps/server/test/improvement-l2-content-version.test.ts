import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => { for (const app of tracked.splice(0)) await app.cleanup(); });

async function call(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({ method: "POST", url: "/mcp", headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } } });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}
describe("L2.1 project content version", () => {
  it("increments accepted content independently from metadata revision", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const created = await call(t, "create_project", { name: "Content version", aliases: [], description: null,
      parentId: null, idempotencyKey: crypto.randomUUID() });
    expect(created.revision).toBe(1);
    expect(created.contentVersion).toBe(0);

    await call(t, "add_owner_note", { projectId: created.id, statement: "Canonical accepted content.",
      recordType: "fact", subject: "content-version", predicate: null, idempotencyKey: crypto.randomUUID() });
    const afterContent = (await call(t, "get_project", { projectId: created.id })).project;
    expect(afterContent.revision).toBe(1);
    expect(afterContent.contentVersion).toBe(1);

    const afterMetadata = await call(t, "update_project", { projectId: created.id, revision: 1,
      description: "Metadata only", idempotencyKey: crypto.randomUUID() });
    expect(afterMetadata.revision).toBe(2);
    expect(afterMetadata.contentVersion).toBe(1);
  });
});

describe("L2.2 bounded freshness cursor", () => {
  it("detects project content changes with a constant-size cursor response", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const created = await call(t, "create_project", { name: "Freshness cursor", aliases: [], description: null,
      parentId: null, idempotencyKey: crypto.randomUUID() });

    const initial = await t.get(`/api/projects/${created.id}/freshness?after=0`);
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ projectId: created.id, cursor: 0, changed: false, delta: 0, resetRequired: false });

    await call(t, "add_owner_note", { projectId: created.id, statement: "External canonical write.",
      recordType: "fact", subject: "freshness", predicate: null, idempotencyKey: crypto.randomUUID() });
    const changed = await t.get(`/api/projects/${created.id}/freshness?after=0`);
    expect(changed.json()).toMatchObject({ projectId: created.id, cursor: 1, changed: true, delta: 1, resetRequired: false });
    expect(changed.headers["cache-control"]).toBe("no-store");

    const current = await t.get(`/api/projects/${created.id}/freshness?after=1`);
    expect(current.json()).toMatchObject({ cursor: 1, changed: false, delta: 0, resetRequired: false });
  });

  it("reports metadata revision changes independently from canonical and working cursors", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN }); tracked.push(t);
    const created = (await t.post("/api/projects", {
      name: "Synthetic metadata freshness",
      aliases: [],
      description: null,
      parentId: null,
    })).json<{ id: string; revision: number; contentVersion: number; workingMemoryVersion: number }>();

    const initial = await t.get(`/api/projects/${created.id}/freshness?after=0&workingAfter=0&projectRevisionAfter=1`);
    expect(initial.json()).toMatchObject({
      projectId: created.id,
      projectRevision: 1,
      projectRevisionChanged: false,
      projectRevisionResetRequired: false,
      cursor: 0,
      workingCursor: 0,
    });

    const patched = await t.patch(`/api/projects/${created.id}`, { revision: 1, description: "Synthetic metadata change" });
    expect(patched.statusCode).toBe(200);
    const patchedProject = patched.json<{ revision: number; contentVersion: number }>();
    expect(patchedProject.revision).toBe(2);
    expect(patchedProject.contentVersion).toBe(0);

    const changed = await t.get(`/api/projects/${created.id}/freshness?after=0&workingAfter=0&projectRevisionAfter=1`);
    expect(changed.json()).toMatchObject({
      projectRevision: 2,
      projectRevisionChanged: true,
      projectRevisionResetRequired: false,
      changed: false,
      workingChanged: false,
    });

    const reset = await t.get(`/api/projects/${created.id}/freshness?after=0&workingAfter=0&projectRevisionAfter=3`);
    expect(reset.json()).toMatchObject({
      projectRevision: 2,
      projectRevisionChanged: true,
      projectRevisionResetRequired: true,
      cursor: 0,
      workingCursor: 0,
    });

    const invalid = await t.get(`/api/projects/${created.id}/freshness?projectRevisionAfter=-1`);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("invalid_project_revision_cursor");
  });
});
