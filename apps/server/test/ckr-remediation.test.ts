import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRecord } from "../src/services/memory-management.js";
import { decideReview } from "../src/services/review.js";
import { runMemoryHousekeeping } from "../src/services/housekeeping.js";
import { synthesize } from "../src/services/synthesis.js";
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
  const res = await t.post("/api/projects", { name });
  expect(res.statusCode).toBe(200);
  return { t, projectId: res.json<{ id: string }>().id };
}

async function rpc(t: TestApp, method: string, params: unknown = {}) {
  return t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
  });
}

async function call(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await rpc(t, "tools/call", { name, arguments: args });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result.structuredContent as any;
}

async function seedExcerpt(t: TestApp, projectId: string) {
  const seeded = await call(t, "capture_working_memory", {
    projectId,
    outcome: "Fixture evidence.",
    subject: `fixture-${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
  });
  return seeded.source.excerptIds[0] as string;
}

function acceptedRecord(
  t: TestApp,
  args: {
    projectId: string;
    sourceExcerptId: string;
    type?: "fact" | "decision" | "action" | "constraint" | "question";
    subject: string;
    text: string;
    predicate?: string | null;
    valueJson?: string | null;
    volatile?: boolean;
    sourceEventAt?: string | null;
    taskStatus?: "open" | "in_progress" | "blocked" | "done" | "cancelled" | null;
  },
) {
  const created = createRecord(
    t.app.ck.deps,
    {
      projectId: args.projectId,
      sourceExcerptId: args.sourceExcerptId,
      recordType: args.type ?? "fact",
      subject: args.subject,
      text: args.text,
      predicate: args.predicate ?? null,
      valueJson: args.valueJson ?? null,
      volatile: args.volatile ?? false,
      sourceEventAt: args.sourceEventAt ?? null,
      taskStatus: args.taskStatus ?? null,
      evidenceBasis: "document",
    },
    { actor: "test:ckr", requestId: null },
  );
  const result = decideReview(
    t.app.ck.deps,
    { items: [{ recordId: created.record.id, revision: created.record.revision }], action: "accept", edits: {}, ownerAction: true },
    { actor: "test:ckr", requestId: null },
  );
  expect(result.accepted).toEqual([created.record.id]);
  return created.record.id;
}

describe("CKR 2026-09-21 remediation regressions", () => {
  it("persists a distinct checkpoint event when semantic metadata changes", async () => {
    const { t, projectId } = await setup("CKR capture identity");
    const first = await call(t, "capture_working_memory", {
      projectId,
      outcome: "Audit finished.",
      subject: "same subject",
      checkpoint: { summary: "Audit finished.", nextAction: "Inspect database" },
      idempotencyKey: crypto.randomUUID(),
    });
    const second = await call(t, "capture_working_memory", {
      projectId,
      outcome: "Audit finished.",
      subject: "same subject",
      checkpoint: { summary: "Audit finished.", nextAction: "Prepare rollout" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(second.outcome.recordId).not.toBe(first.outcome.recordId);
    expect(second.workingMemoryVersion).toBeGreaterThan(first.workingMemoryVersion);
    const read = await call(t, "get_record", { recordId: second.outcome.recordId, includeUnreviewed: true });
    expect(read.evidenceBasis).toBe("agent_report");
    expect(read.valueJson).toMatchObject({ kind: "working_checkpoint", nextAction: "Prepare rollout" });
  });

  it("never reuses a non-agent proposal as delegated working memory", async () => {
    const { t, projectId } = await setup("CKR provenance identity");
    const excerpt = await seedExcerpt(t, projectId);
    const document = createRecord(
      t.app.ck.deps,
      {
        projectId,
        sourceExcerptId: excerpt,
        recordType: "fact",
        subject: "shared semantic identity",
        text: "Same text.",
        evidenceBasis: "document",
        sourceEventAt: null,
        taskStatus: null,
        volatile: false,
      },
      { actor: "test:ckr", requestId: null },
    );
    const captured = await call(t, "capture_working_memory", {
      projectId,
      outcome: "Same text.",
      subject: "shared semantic identity",
      checkpoint: { summary: "Working copy", nextAction: "Continue" },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(captured.outcome.recordId).not.toBe(document.record.id);
    const read = await call(t, "get_record", { recordId: captured.outcome.recordId, includeUnreviewed: true });
    expect(read.evidenceBasis).toBe("agent_report");
    expect(read.valueJson).toMatchObject({ kind: "working_checkpoint", nextAction: "Continue" });
    const search = await call(t, "search_context", { projectId, q: "Same text", scope: "working" });
    expect(search.workingRecords.some((r: any) => r.recordId === captured.outcome.recordId)).toBe(true);
  });

  it("publishes get_work_context output that a real MCP SDK accepts with and without budgets", async () => {
    const { t, projectId } = await setup("CKR output schema");
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const client = new Client({ name: "ckr-contract", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );
      await client.listTools();
      for (const args of [
        { projectId },
        { projectId, totalContextBudgetChars: 2000 },
        { projectId, totalContextBudgetChars: 60000 },
      ]) {
        const result = await client.callTool({ name: "get_work_context", arguments: args });
        expect(result.isError).not.toBe(true);
        const value = result.structuredContent as any;
        expect(value.truncated).toEqual(expect.any(Boolean));
        expect(value.project.id).toBe(projectId);
      }
    } finally {
      await client.close();
    }
  });

  it("never truncates structural identifiers while fitting get_work_context", async () => {
    const { t, projectId } = await setup("CKR context budget");
    await call(t, "capture_working_memory", {
      projectId,
      outcome: "Dense checkpoint",
      subject: "checkpoint",
      checkpoint: {
        summary: "S".repeat(5000),
        blockers: Array.from({ length: 20 }, (_, i) => `blocker-${i}-${"B".repeat(800)}`),
        artifactRefs: ["/repo/" + "a".repeat(900)],
      },
      idempotencyKey: crypto.randomUUID(),
    });
    const value = await call(t, "get_work_context", { projectId, totalContextBudgetChars: 2000, limitPerSection: 10 });
    expect(value.project?.id ?? value.projectId).toBe(projectId);
    expect(value.freshness.working.status).toBe("unreviewed_working_memory");
    if (value.latestCheckpoint) expect(value.latestCheckpoint.recordId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(2000);
  });

  it("preserves checkpoint metadata through working search", async () => {
    const { t, projectId } = await setup("CKR checkpoint DTO");
    const captured = await call(t, "capture_working_memory", {
      projectId,
      outcome: "checkpoint persimmon implementation",
      subject: "checkpoint",
      checkpoint: { summary: "Persimmon", nextAction: "Continue persimmon", artifactRefs: ["PR-9981"] },
      idempotencyKey: crypto.randomUUID(),
    });
    const search = await call(t, "search_context", { projectId, q: "persimmon", scope: "working" });
    const match = search.workingRecords.find((r: any) => r.recordId === captured.outcome.recordId);
    expect(match?.checkpoint).toMatchObject({ summary: "Persimmon", nextAction: "Continue persimmon" });
  });

  it("keeps latest checkpoint independent from the recent generic work window", async () => {
    const { t, projectId } = await setup("CKR checkpoint window");
    const checkpoint = await call(t, "capture_working_memory", {
      projectId,
      outcome: "Saved resumption point.",
      subject: "checkpoint",
      checkpoint: { summary: "Saved resumption point." },
      idempotencyKey: crypto.randomUUID(),
    });
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET recorded_at='2020-01-01T00:00:00.000Z',created_at='2020-01-01T00:00:00.000Z' WHERE id=?")
      .run(checkpoint.outcome.recordId);
    for (let i = 0; i < 6; i++) {
      await call(t, "capture_working_memory", {
        projectId,
        outcome: `Later ordinary note ${i}`,
        subject: `ordinary-${i}`,
        idempotencyKey: crypto.randomUUID(),
      });
    }
    const context = await call(t, "get_work_context", { projectId, totalContextBudgetChars: 20000 });
    expect(context.latestCheckpoint?.recordId).toBe(checkpoint.outcome.recordId);
  });

  it("uses entity-aware freshness and exposes overdue accepted records consistently", async () => {
    const { t, projectId } = await setup("CKR freshness");
    const excerpt = await seedExcerpt(t, projectId);
    const backend = acceptedRecord(t, {
      projectId,
      sourceExcerptId: excerpt,
      subject: "backend engine",
      predicate: "version",
      text: "Backend engine version alpha.",
      sourceEventAt: "2025-01-01T00:00:00.000Z",
    });
    createRecord(
      t.app.ck.deps,
      {
        projectId,
        sourceExcerptId: excerpt,
        recordType: "fact",
        subject: "mobile interface",
        predicate: "version",
        text: "Mobile interface version beta.",
        evidenceBasis: "agent_report",
        sourceEventAt: "2026-01-01T00:00:00.000Z",
        taskStatus: null,
        volatile: false,
      },
      { actor: "test:ckr", requestId: null },
    );
    const overdue = acceptedRecord(t, {
      projectId,
      sourceExcerptId: excerpt,
      subject: "certificate availability",
      text: "Certificate is current.",
      volatile: true,
    });
    t.app.ck.handle.sqlite.prepare("UPDATE records SET review_due_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(overdue);
    const context = await call(t, "get_work_context", { projectId, totalContextBudgetChars: 30000, limitPerSection: 10 });
    expect(context.facts.items.find((r: any) => r.recordId === backend)?.stale).toBe(false);
    expect(context.facts.items.find((r: any) => r.recordId === overdue)?.stale).toBe(true);
  });

  it("searches semantic checkpoint metadata and preserves checkpoint projection", async () => {
    const { t, projectId } = await setup("CKR checkpoint metadata search");
    const captured = await call(t, "capture_working_memory", {
      projectId,
      outcome: "Recorded implementation checkpoint.",
      subject: "checkpoint",
      checkpoint: { summary: "Done", nextAction: "Continue", artifactRefs: ["uniqueartifactmarigold"] },
      idempotencyKey: crypto.randomUUID(),
    });
    const search = await call(t, "search_context", { projectId, q: "uniqueartifactmarigold", scope: "working" });
    const match = search.workingRecords.find((r: any) => r.recordId === captured.outcome.recordId);
    expect(match?.checkpoint?.artifactRefs).toContain("uniqueartifactmarigold");
  });

  it("does not treat an ordinary year as sufficient evidence and keeps AI searchable as a domain term", async () => {
    const { t, projectId } = await setup("CKR ranking");
    const excerpt = await seedExcerpt(t, projectId);
    acceptedRecord(t, {
      projectId,
      sourceExcerptId: excerpt,
      subject: "office refreshments",
      text: "Coffee budget recorded in 2026.",
    });
    acceptedRecord(t, {
      projectId,
      sourceExcerptId: excerpt,
      subject: "AI assistant",
      text: "AI assistant strategy is evidence backed.",
    });
    const year = synthesize(t.app.ck.deps, { question: "quasar mass 2026", projectId, includeHistorical: false, limit: 10 });
    expect(year.status).toBe("unknown");
    const ai = await call(t, "search_context", { projectId, q: "AI", scope: "canonical" });
    expect(ai.records.some((r: any) => r.subject === "AI assistant")).toBe(true);
  });

  it("selects relevant old constraints before applying the task context window", async () => {
    const { t, projectId } = await setup("CKR old constraints");
    const excerpt = await seedExcerpt(t, projectId);
    const old = acceptedRecord(t, {
      projectId,
      sourceExcerptId: excerpt,
      type: "constraint",
      subject: "needlemetallurgy",
      text: "needlemetallurgy invariants must always be retained.",
    });
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET recorded_at='2020-01-01T00:00:00.000Z',reviewed_at='2020-01-01T00:00:00.000Z' WHERE id=?")
      .run(old);
    for (let i = 0; i < 60; i++) {
      acceptedRecord(t, {
        projectId,
        sourceExcerptId: excerpt,
        type: "constraint",
        subject: `recent-${i}`,
        text: `Unrelated recent constraint ${i}.`,
      });
    }
    const context = await call(t, "get_work_context", {
      projectId,
      task: "needlemetallurgy",
      limitPerSection: 10,
      totalContextBudgetChars: 30000,
    });
    expect(context.constraints.items.some((r: any) => r.recordId === old)).toBe(true);
  });

  it("skips non-archivable lifecycle proposals without aborting housekeeping", async () => {
    const { t, projectId } = await setup("CKR housekeeping lifecycle");
    const excerpt = await seedExcerpt(t, projectId);
    const lifecycle = createRecord(
      t.app.ck.deps,
      {
        projectId,
        sourceExcerptId: excerpt,
        recordType: "fact",
        subject: "lifecycle proposal",
        predicate: "lifecycle",
        valueJson: JSON.stringify("active"),
        text: "Project lifecycle active.",
        evidenceBasis: "agent_report",
        sourceEventAt: null,
        taskStatus: null,
        volatile: false,
      },
      { actor: "test:ckr", requestId: null },
    );
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET created_at='2020-01-01T00:00:00.000Z',updated_at='2020-01-01T00:00:00.000Z' WHERE id=?")
      .run(lifecycle.record.id);
    expect(() =>
      runMemoryHousekeeping(
        t.app.ck.deps,
        { housekeepingProposalRetentionDays: 30 },
        undefined,
        Date.parse("2026-09-21T00:00:00.000Z"),
      ),
    ).not.toThrow();
    const row = t.app.ck.handle.sqlite.prepare("SELECT review_status FROM records WHERE id=?").get(lifecycle.record.id) as any;
    expect(row.review_status).toBe("proposed");
  });

  it("applies the same project cycle policy through REST and MCP", async () => {
    const { t } = await setup("CKR cycle root");
    const a = await call(t, "create_project", { name: "cycle A", idempotencyKey: crypto.randomUUID() });
    const b = await call(t, "create_project", { name: "cycle B", idempotencyKey: crypto.randomUUID() });
    const aUpdated = await call(t, "update_project", {
      projectId: a.id,
      revision: a.revision,
      parentId: b.id,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(aUpdated.parentId).toBe(b.id);
    const before = (await t.get(`/api/projects/${b.id}`)).json<any>();
    const rest = await t.patch(`/api/projects/${b.id}`, { revision: before.revision, parentId: a.id });
    expect(rest.statusCode).toBe(409);
    expect(rest.json<any>().error.code).toBe("project_cycle");
    const after = (await t.get(`/api/projects/${b.id}`)).json<any>();
    expect(after.parentId).toBeNull();
    expect(after.revision).toBe(before.revision);
  });
});
