import { randomUUID, randomBytes, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import {
  WorkflowEvents,
  enqueueExecutionEvent,
} from "../src/services/workflow-events.js";
import { reserveRun } from "../src/services/workflow.js";
import { workflowHealth } from "../src/services/workflow-health.js";
const tracked: TestApp[] = [];
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});
async function setup() {
  const token = randomUUID(),
    t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  async function call(name: string, args: Record<string, unknown>) {
    const res = await t.app.inject({
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
    const result = res.json().result;
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent;
  }
  const p = await call("create_project", {
    name: "Synthetic drain fixture",
    idempotencyKey: randomUUID(),
  });
  const a = await call("capture_work", {
    projectId: p.id,
    outcome: "Synthetic task",
    recordType: "action",
    clientId: "test",
    sessionId: "drain",
    idempotencyKey: randomUUID(),
  });
  const deps = t.app.ck.deps,
    scope = { projectId: p.id, taskId: a.outcome.recordId };
  const run = reserveRun(deps, {
    ...scope,
    operationKey: randomUUID(),
    inputHash: "b".repeat(64),
    device: "fixture",
    identity: "owner",
    criteria: ["Synthetic callback receipt"],
  }).run;
  const enqueue = () =>
    enqueueExecutionEvent(
      deps,
      {
        ...scope,
        runId: run.id,
        revision: 4,
        status: "completed",
        verification: "pending",
      },
      new Date().toISOString(),
      randomUUID(),
    );
  const input = {
    name: "execution.finished",
    arguments: scope,
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/synthetic",
      secret: "whsec_" + randomBytes(32).toString("base64"),
    },
  };
  return {
    t,
    deps,
    scope,
    enqueue,
    input,
    principal: createHash("sha256").update(token).digest("hex"),
  };
}
describe("bounded delivery shutdown and recovery", () => {
  it("cancels a non-cooperating transport without exhausting retries or accepting its late response", async () => {
    const f = await setup();
    let release: (r: { status: number; body: string }) => void = () => {};
    const deferred = new Promise<{ status: number; body: string }>((r) => {
      release = r;
    });
    const events = new WorkflowEvents(
      f.deps,
      f.principal,
      f.t.config.sessionSecret,
      async (_url, _headers, body) => {
        const payload = JSON.parse(body);
        return payload.type === "verification"
          ? {
              status: 200,
              body: JSON.stringify({ challenge: payload.challenge }),
            }
          : deferred;
      },
    );
    await events.subscribe(f.input);
    f.enqueue();
    f.deps.sqlite.prepare("UPDATE workflow_deliveries SET attempts=7").run();
    const pumping = events.pump(1);
    const before = Date.now();
    await events.stopAndDrain(15);
    await pumping;
    expect(Date.now() - before).toBeLessThan(1000);
    const read = () =>
      f.deps.sqlite
        .prepare(
          "SELECT status,attempts,http_status,lease_token FROM workflow_deliveries",
        )
        .get();
    expect(read()).toMatchObject({
      status: "pending",
      attempts: 7,
      http_status: null,
      lease_token: null,
    });
    release({ status: 204, body: "" });
    await Promise.resolve();
    await Promise.resolve();
    expect(read()).toMatchObject({
      status: "pending",
      attempts: 7,
      http_status: null,
    });
    expect(await events.pump()).toEqual({ processed: 0 });
    expect(f.deps.sqlite.open).toBe(true);
  });
  it("counts an ordinary in-flight transport failure during shutdown", async () => {
    const f = await setup();
    let fail: (error: Error) => void = () => {};
    const deferred = new Promise<{ status: number; body: string }>(
      (_resolve, reject) => {
        fail = reject;
      },
    );
    const events = new WorkflowEvents(
      f.deps,
      f.principal,
      f.t.config.sessionSecret,
      async (_u, _h, body) => {
        const p = JSON.parse(body);
        return p.type === "verification"
          ? { status: 200, body: JSON.stringify({ challenge: p.challenge }) }
          : deferred;
      },
    );
    await events.subscribe(f.input);
    f.enqueue();
    f.deps.sqlite.prepare("UPDATE workflow_deliveries SET attempts=7").run();
    const pumping = events.pump(1),
      draining = events.stopAndDrain(1000);
    fail(new Error("Synthetic connection failure before cancellation"));
    await pumping;
    await draining;
    expect(
      f.deps.sqlite
        .prepare("SELECT status,attempts,http_status FROM workflow_deliveries")
        .get(),
    ).toEqual({ status: "failed", attempts: 8, http_status: 0 });
    expect(workflowHealth(f.deps, f.scope.taskId).failedDeliveries).toBe(1);
  });
  it("does not revoke the subscription after a replacement pump owns the lease", async () => {
    const f = await setup();
    let release: (v: { status: number; body: string }) => void = () => {},
      calls = 0;
    const deferred = new Promise<{ status: number; body: string }>(
      (resolve) => {
        release = resolve;
      },
    );
    const events = new WorkflowEvents(
      f.deps,
      f.principal,
      f.t.config.sessionSecret,
      async (_u, _h, body) => {
        const p = JSON.parse(body);
        if (p.type === "verification")
          return {
            status: 200,
            body: JSON.stringify({ challenge: p.challenge }),
          };
        return ++calls === 1 ? deferred : { status: 204, body: "" };
      },
    );
    await events.subscribe(f.input);
    f.enqueue();
    const stale = events.pump(1);
    f.deps.sqlite
      .prepare(
        "UPDATE workflow_deliveries SET lease_until='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await events.pump(1);
    release({ status: 410, body: "" });
    await stale;
    expect(
      f.deps.sqlite.prepare("SELECT active FROM workflow_subscriptions").get(),
    ).toEqual({ active: 1 });
    expect(
      f.deps.sqlite
        .prepare("SELECT status,http_status,attempts FROM workflow_deliveries")
        .get(),
    ).toEqual({ status: "delivered", http_status: 204, attempts: 2 });
  });

  it("retries the same event with renewed credentials after the old response fails", async () => {
    const f = await setup();
    let release: (r: { status: number; body: string }) => void = () => {};
    const deferred = new Promise<{ status: number; body: string }>((r) => {
      release = r;
    });
    let calls = 0;
    const ids: string[] = [];
    const events = new WorkflowEvents(
      f.deps,
      f.principal,
      f.t.config.sessionSecret,
      async (_url, headers, body) => {
        const payload = JSON.parse(body);
        if (payload.type === "verification")
          return {
            status: 200,
            body: JSON.stringify({ challenge: payload.challenge }),
          };
        ids.push(headers["webhook-id"]!);
        calls++;
        return calls === 1 ? deferred : { status: 204, body: "" };
      },
    );
    await events.subscribe(f.input);
    f.enqueue();
    const pumping = events.pump(1);
    await events.subscribe(f.input);
    release({ status: 410, body: "" });
    await pumping;
    expect(workflowHealth(f.deps, f.scope.taskId).pendingDeliveries).toBe(1);
    f.deps.sqlite
      .prepare(
        "UPDATE workflow_deliveries SET next_at='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await events.pump(1);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    const health = workflowHealth(f.deps, f.scope.taskId);
    expect(health).toMatchObject({
      pendingDeliveries: 0,
      failedDeliveries: 0,
      lastDelivery: { status: "delivered", httpStatus: 204 },
    });
    expect(JSON.stringify(health)).not.toContain("receiver.example.com");
    expect(JSON.stringify(health)).not.toContain("whsec_");
  });
});
