// Independent adversarial probes. Synthetic temporary apps only; no production data or HTTP destinations.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { makeTestApp } from "./helpers.js";
import {
  WorkflowEvents,
  enqueueExecutionEvent,
} from "../src/services/workflow-events.js";
import { reserveRun } from "../src/services/workflow.js";
import Sqlite from "better-sqlite3";
import { describe, it, expect } from "vitest";
const results: any[] = [];
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function record(id: string, category: string, details: any) {
  const r = { id, category, ...details };
  results.push(r);
  expect(category, JSON.stringify(r)).toBe("control_pass");
}
async function fixture() {
  const token = randomUUID(),
    t = await makeTestApp({ mcpToken: token });
  async function rpc(method: string, params: any) {
    const r = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
    });
    const v = r.json();
    if (v.error) throw new Error(JSON.stringify(v.error));
    return v.result;
  }
  async function call(name: string, args: any) {
    const v = await rpc("tools/call", { name, arguments: args });
    if (v.isError) throw new Error(JSON.stringify(v));
    return v.structuredContent;
  }
  const p = await call("create_project", {
    name: "Independent synthetic review",
    idempotencyKey: randomUUID(),
  });
  const a = await call("capture_work", {
    projectId: p.id,
    subject: "Synthetic review task",
    recordType: "action",
    outcome: "Evaluate a synthetic result.",
    clientId: "adversarial",
    sessionId: "temporary",
    idempotencyKey: randomUUID(),
  });
  return {
    t,
    call,
    rpc,
    projectId: p.id,
    taskId: a.outcome.recordId,
    token,
    principal: createHash("sha256").update(token).digest("hex"),
  };
}
async function nextCase(
  label: string,
  status: string | null,
  value: string | null,
  cpAfter = false,
) {
  const f = await fixture();
  try {
    const checkpoint = () =>
      f.call("capture_work", {
        projectId: f.projectId,
        taskId: f.taskId,
        outcome: "Synthetic checkpoint",
        checkpoint: { nextAction: cpAfter ? null : "OLD ACTION" },
        clientId: "adversarial",
        sessionId: "temporary",
        idempotencyKey: randomUUID(),
      });
    if (!cpAfter) await checkpoint();
    await pause(5);
    if (status)
      await f.call("report_task_progress", {
        projectId: f.projectId,
        taskId: f.taskId,
        taskRevision: 1,
        expectedProgressRecordId: null,
        status,
        summary: "Independent explicit progress",
        nextAction: value,
        ownerAction: null,
        evidenceText: "Synthetic evidence only.",
        clientId: "adversarial",
        sessionId: "temporary",
        idempotencyKey: randomUUID(),
      });
    if (cpAfter) {
      await pause(5);
      await checkpoint();
    }
    const r = await f.call("resume_task", {
      projectId: f.projectId,
      taskId: f.taskId,
    });
    const expected = status ? value : "OLD ACTION";
    const actual = r.dossier.nextAction;
    record(label, expected === actual ? "control_pass" : "defect_reproduced", {
      state: r.dossier.state,
      expectedNextAction: expected,
      actualNextAction: actual,
      oldStepInResume: r.resumeText.includes("OLD ACTION"),
      reportedStatus: r.dossier.progress?.status,
      taskReviewStatus: r.dossier.taskReviewStatus,
    });
  } finally {
    await f.t.cleanup();
  }
}
async function eventCase(
  label: string,
  status: number,
  change: "none" | "refresh" | "rotate" | "unsubscribe",
) {
  const f = await fixture();
  try {
    const deps = f.t.app.ck.deps;
    const run = reserveRun(deps, {
      projectId: f.projectId,
      taskId: f.taskId,
      operationKey: "probe",
      inputHash: "b".repeat(64),
      device: "synthetic",
      identity: "owner",
      criteria: ["Synthetic proof"],
    }).run;
    let release: (v: { status: number; body: string }) => void = () => {};
    const response = new Promise<{ status: number; body: string }>(
      (r) => (release = r),
    );
    let started = false;
    const post = async (_u: string, _h: any, body: string) => {
      const b = JSON.parse(body);
      if (b.type === "verification")
        return {
          status: 200,
          body: JSON.stringify({ challenge: b.challenge }),
        };
      started = true;
      return response;
    };
    const e = new WorkflowEvents(
      deps,
      f.principal,
      f.t.config.sessionSecret,
      post,
    );
    const input = {
      name: "execution.finished",
      arguments: { projectId: f.projectId, taskId: f.taskId },
      delivery: {
        mode: "webhook",
        url: "https://receiver.example.com/synthetic",
        secret: "whsec_" + randomBytes(32).toString("base64"),
      },
    };
    await e.subscribe(input);
    enqueueExecutionEvent(
      deps,
      {
        projectId: f.projectId,
        taskId: f.taskId,
        runId: run.id,
        revision: 4,
        status: "completed",
        verification: "pending",
      },
      new Date().toISOString(),
      randomUUID(),
    );
    const pumping = e.pump(1);
    if (!started) throw new Error("Expected real pump HTTP wait");
    if (change === "refresh") await e.subscribe(input);
    if (change === "rotate")
      await e.subscribe({
        ...input,
        delivery: {
          ...input.delivery,
          secret: "whsec_" + randomBytes(32).toString("base64"),
        },
      });
    if (change === "unsubscribe")
      e.unsubscribe({
        ...input,
        delivery: { mode: "webhook", url: input.delivery.url },
      });
    const before = deps.sqlite
      .prepare("SELECT active,generation FROM workflow_subscriptions")
      .get();
    release({ status, body: "" });
    await pumping;
    const after = deps.sqlite
      .prepare("SELECT active,generation FROM workflow_subscriptions")
      .get() as any;
    const delivery = deps.sqlite
      .prepare("SELECT status,http_status FROM workflow_deliveries")
      .get() as any;
    const expectedActive =
      change === "unsubscribe" || (change === "none" && status === 410) ? 0 : 1;
    record(
      label,
      after.active === expectedActive ? "control_pass" : "defect_reproduced",
      {
        responseStatus: status,
        change,
        before,
        after,
        delivery,
        expectedActive,
      },
    );
  } finally {
    await f.t.cleanup();
  }
}
async function realShutdown() {
  const f = await fixture();
  const originalSubscribe = WorkflowEvents.prototype.subscribe;
  let release: (v: { status: number; body: string }) => void = () => {},
    startedResolve: () => void = () => {};
  const pending = new Promise<{ status: number; body: string }>(
      (r) => (release = r),
    ),
    started = new Promise<void>((r) => (startedResolve = r));
  const post = async (_u: string, _h: any, body: string) => {
    const b = JSON.parse(body);
    if (b.type === "verification")
      return { status: 200, body: JSON.stringify({ challenge: b.challenge }) };
    startedResolve();
    return pending;
  };
  try {
    // Inject only HTTP transport at the real MCP subscribe call. pump() itself is never replaced.
    WorkflowEvents.prototype.subscribe = async function (raw: any) {
      (this as any).post = post;
      return originalSubscribe.call(this, raw);
    };
    const input = {
      name: "execution.finished",
      arguments: { projectId: f.projectId, taskId: f.taskId },
      delivery: {
        mode: "webhook",
        url: "https://receiver.example.com/synthetic",
        secret: "whsec_" + randomBytes(32).toString("base64"),
      },
    };
    await f.rpc("events/subscribe", input);
    WorkflowEvents.prototype.subscribe = originalSubscribe;
    const deps = f.t.app.ck.deps,
      dbFile = deps.sqlite.name;
    const run = reserveRun(deps, {
      projectId: f.projectId,
      taskId: f.taskId,
      operationKey: "shutdown",
      inputHash: "c".repeat(64),
      device: "synthetic",
      identity: "owner",
      criteria: ["Synthetic proof"],
    }).run;
    enqueueExecutionEvent(
      deps,
      {
        projectId: f.projectId,
        taskId: f.taskId,
        runId: run.id,
        revision: 4,
        status: "completed",
        verification: "pending",
      },
      new Date().toISOString(),
      randomUUID(),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Real timer did not begin HTTP delivery")),
            6000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    let errors = 0;
    (f.t.app.log as any).error = () => {
      errors++;
    };
    const closing = f.t.app.close();
    await pause(50);
    const openWhileHttpPending = deps.sqlite.open;
    release({ status: 204, body: "" });
    await closing;
    const db = new Sqlite(dbFile, { readonly: true, fileMustExist: true });
    const delivery = db
      .prepare("SELECT status,attempts,http_status FROM workflow_deliveries")
      .get();
    const integrity = db.pragma("quick_check");
    db.close();
    record(
      "S1_actual_pump_shutdown",
      openWhileHttpPending ? "control_pass" : "defect_reproduced",
      {
        pumpImplementationReplaced: false,
        httpOnlyInjected: true,
        openWhileHttpPending,
        applicationDeliveryErrors: errors,
        persistedDelivery: delivery,
        integrity,
      },
    );
  } finally {
    release({ status: 204, body: "" });
    WorkflowEvents.prototype.subscribe = originalSubscribe;
    await f.t.cleanup();
  }
}

describe("adversarial lifecycle regressions", () => {
  it("preserves an accepted task's explicit cleared action", async () => {
    const f = await fixture();
    try {
      await f.call("review_records", {
        items: [{ recordId: f.taskId, revision: 1 }],
        action: "accept",
        ownerAction: true,
        clientId: "test",
        sessionId: "accepted-null",
        idempotencyKey: randomUUID(),
      });
      const task = await f.call("get_task", {
        projectId: f.projectId,
        taskId: f.taskId,
      });
      await f.call("capture_work", {
        projectId: f.projectId,
        taskId: f.taskId,
        outcome: "Old checkpoint",
        checkpoint: { nextAction: "OLD ACCEPTED STEP" },
        clientId: "test",
        sessionId: "accepted-null",
        idempotencyKey: randomUUID(),
      });
      await pause(5);
      await f.call("report_task_progress", {
        projectId: f.projectId,
        taskId: f.taskId,
        taskRevision: task.task.revision,
        expectedProgressRecordId: null,
        status: "done",
        summary: "Synthetic work completed",
        nextAction: null,
        ownerAction: null,
        evidenceText: "Synthetic completion proof",
        clientId: "test",
        sessionId: "accepted-null",
        idempotencyKey: randomUUID(),
      });
      const resumed = await f.call("resume_task", {
        projectId: f.projectId,
        taskId: f.taskId,
      });
      expect(resumed.dossier.taskReviewStatus).toBe("accepted");
      expect(resumed.dossier.nextAction).toBeNull();
      expect(resumed.resumeText).not.toContain("OLD ACCEPTED STEP");
    } finally {
      await f.t.cleanup();
    }
  });
  it.each(["done", "cancelled", "in_progress"])(
    "preserves explicit null for %s",
    async (status) => {
      await nextCase(status, status, null);
    },
  );
  it("keeps an explicit new action", async () => {
    await nextCase("new", "in_progress", "NEW ACTION");
  });
  it("keeps a newer checkpoint null", async () => {
    await nextCase("cp-newer", "in_progress", null, true);
  });
  it("retains the checkpoint when no progress exists", async () => {
    await nextCase("cp-only", null, null);
  });
  it("revokes a permanent 410 with no renewal", async () => {
    await eventCase("real410", 410, "none");
  });
  it.each(["refresh", "rotate"] as const)(
    "fences a stale 410 after %s",
    async (change) => {
      await eventCase(change, 410, change);
    },
  );
  it("acknowledges a successful delivery after rotation", async () => {
    await eventCase("ack", 204, "rotate");
  });
  it("never revives an unsubscribed delivery", async () => {
    await eventCase("revoked", 204, "unsubscribe");
  });
  it("drains the real timed MCP pump before SQLite closes", async () => {
    await realShutdown();
  }, 10000);
});
