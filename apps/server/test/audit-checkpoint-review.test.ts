import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpWorkContextResult,
  projectResumeContext,
  renderResumeText,
} from "@contextkeep/shared";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});
async function fixture() {
  const token = randomBytes(32).toString("hex");
  const t = await makeTestApp({
    mcpToken: token,
    mcpDefaultClientId: "audit",
    mcpDelegateWorkingMemory: true,
    adapters: "manual,faketest",
  });
  apps.push(t);
  const projectId = (
    await t.post("/api/projects", { name: "Audit checkpoint review" })
  ).json<{ id: string }>().id;
  async function call<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const r = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      error?: unknown;
      result: { isError?: boolean; structuredContent: T };
    }>();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    return body.result.structuredContent;
  }
  async function capture(label: string, date: string) {
    const result = await call<{ outcome: { recordId: string } }>(
      "capture_working_memory",
      {
        projectId,
        outcome: `${label} verified outcome`,
        subject: label,
        checkpoint: {
          summary: `${label} checkpoint`,
          nextAction: `${label} next action`,
        },
        idempotencyKey: randomUUID(),
      },
    );
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET recorded_at=? WHERE id=?")
      .run(date, result.outcome.recordId);
    return result.outcome.recordId;
  }
  async function review(ids: string[], action: "accept" | "reject") {
    const items = await Promise.all(
      ids.map(async (recordId) => ({
        recordId,
        revision: (
          await call<{ revision: number }>("get_record", {
            recordId,
            includeUnreviewed: true,
          })
        ).revision,
      })),
    );
    return call("review_records", {
      items,
      action,
      ownerAction: true,
      idempotencyKey: randomUUID(),
    });
  }
  const context = async (budget = 60000, task?: string) =>
    McpWorkContextResult.parse(
      await call("get_work_context", {
        projectId,
        totalContextBudgetChars: budget,
        ...(task ? { task } : {}),
      }),
    );
  return { t, call, projectId, capture, review, context };
}

describe("A01 checkpoint review does not rewind agent resume", () => {
  it("keeps the newest accepted checkpoint while the working index remains proposed-only", async () => {
    const f = await fixture();
    const old = await f.capture("Earlier", "2026-09-23T01:00:00.000Z");
    const latest = await f.capture("Latest", "2026-09-24T01:00:00.000Z");
    expect((await f.context()).latestCheckpoint?.recordId).toBe(latest);
    await f.review([latest], "accept");
    const context = await f.context();
    expect(context.latestCheckpoint).toMatchObject({
      recordId: latest,
      status: "accepted",
      provenance: "agent_report",
    });
    expect(context.latestNextAction).toBe("Latest next action");
    expect(context.workingMemory.items.map((r) => r.recordId)).toContain(old);
    expect(context.workingMemory.items.map((r) => r.recordId)).not.toContain(
      latest,
    );
    const resume = projectResumeContext(context);
    expect(resume.proposedCheckpoint).toBe(false);
    expect(renderResumeText(resume)).toContain("status: accepted");
    const rest = await f.t.get(`/api/projects/${f.projectId}/work-context`);
    expect(rest.statusCode).toBe(200);
    expect(
      rest.json<{ latestCheckpoint: { recordId: string; status: string } }>()
        .latestCheckpoint,
    ).toMatchObject({ recordId: latest, status: "accepted" });
  });
  it("preserves resume after bulk acceptance and through task ranking and compact budgets", async () => {
    const f = await fixture();
    const first = await f.capture("Earlier", "2026-09-23T01:00:00.000Z");
    const last = await f.capture("Latest", "2026-09-24T01:00:00.000Z");
    await f.review([first, last], "accept");
    for (const budget of [60000, 6000, 3500]) {
      const ctx = await f.context(budget, "Earlier next action");
      expect(ctx.latestCheckpoint?.recordId).toBe(last);
      expect(ctx.latestCheckpoint?.status).toBe("accepted");
      expect(ctx.workingMemory.total).toBe(0);
      expect(projectResumeContext(ctx).nextAction).toBe("Latest next action");
      expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(budget);
    }
  });
  it("excludes rejected/superseded checkpoints and does not turn ordinary records into checkpoints", async () => {
    const f = await fixture();
    const earlier = await f.capture("Earlier", "2026-09-23T01:00:00.000Z");
    const latest = await f.capture("Latest", "2026-09-24T01:00:00.000Z");
    await f.review([earlier], "accept");
    await f.review([latest], "reject");
    expect((await f.context()).latestCheckpoint?.recordId).toBe(earlier);
    f.t.app.ck.handle.sqlite
      .prepare("UPDATE records SET review_status='superseded' WHERE id=?")
      .run(earlier);
    expect((await f.context()).latestCheckpoint).toBeNull();
  });
  it("uses a stable chronological tie-break independent of review status", async () => {
    const f = await fixture();
    const first = await f.capture("First", "2026-09-24T01:00:00.000Z");
    const second = await f.capture("Second", "2026-09-24T01:00:00.000Z");
    const latest = [first, second].sort().at(-1)!;
    await f.review([latest], "accept");
    expect((await f.context()).latestCheckpoint?.recordId).toBe(latest);
  });
  it("returns a newer proposal without promoting it over or blending it into canonical records", async () => {
    const f = await fixture();
    const accepted = await f.capture(
      "Accepted earlier",
      "2026-09-23T01:00:00.000Z",
    );
    await f.review([accepted], "accept");
    const proposed = await f.capture(
      "New proposal",
      "2026-09-24T01:00:00.000Z",
    );
    const ctx = await f.context();
    expect(ctx.latestCheckpoint).toMatchObject({
      recordId: proposed,
      status: "proposed",
    });
    expect(projectResumeContext(ctx).proposedCheckpoint).toBe(true);
    expect(ctx.facts?.items.some((r) => r.recordId === proposed)).not.toBe(
      true,
    );
  });
});
