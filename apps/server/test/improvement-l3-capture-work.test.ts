import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function invoke(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST", url: "/mcp", headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().result as { isError?: boolean; structuredContent: any };
}

async function ok(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const result = await invoke(t, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}
describe("L3.2 atomic capture_work", () => {
  it("links every excerpt from a duplicate capture, including a new single-chunk source", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await ok(t, "create_project", { name: "Duplicate evidence", idempotencyKey: crypto.randomUUID() });
    const first = await ok(t, "capture_work", {
      projectId: project.id,
      outcome: "Build verified.",
      evidenceText: "First run evidence.",
      subject: "work-capture",
      progressUpdates: [],
      clientId: "chatgpt",
      sessionId: "duplicate-evidence",
      idempotencyKey: crypto.randomUUID(),
    });
    const second = await ok(t, "capture_work", {
      projectId: project.id,
      outcome: "Build verified.",
      evidenceText: "Second run additional evidence.",
      subject: "work-capture",
      progressUpdates: [],
      clientId: "chatgpt",
      sessionId: "duplicate-evidence",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(second.outcome.recordId).toBe(first.outcome.recordId);
    expect(second.outcome.duplicate).toBe(true);
    const record = await ok(t, "get_record", { recordId: first.outcome.recordId, includeUnreviewed: true });
    expect(record.evidence.some((item: any) => item.sourceId === second.source.id)).toBe(true);
  });

  it("commits evidence, proposed outcome and explicit progress atomically and replays idempotently", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Capture work",
      description: "Atomic agent session capture",
      idempotencyKey: crypto.randomUUID(),
    });
    await ok(t, "add_owner_note", {
      projectId: project.id,
      statement: "Implement the capture workflow.",
      recordType: "action",
      idempotencyKey: crypto.randomUUID(),
    });
    const start = await ok(t, "get_work_context", { projectId: project.id });
    const action = start.actions.items[0];
    expect(action.revision).toBeGreaterThan(0);

    const args = {
      projectId: project.id,
      outcome: "Implemented capture_work with atomic persistence.",
      evidenceText: "Verification evidence: targeted tests passed and source/progress writes share one transaction.",
      progressUpdates: [{ recordId: action.recordId, revision: action.revision, taskStatus: "done" }],
      clientId: "chatgpt", sessionId: "capture-test-session",
      idempotencyKey: crypto.randomUUID(),
    };
    const beforeSources = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n;
    const beforeRecords = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n;
    const first = await ok(t, "capture_work", args);
    expect(first.outcome.reviewStatus).toBe("proposed");
    expect(first.outcome.evidenceBasis).toBe("agent_report");
    expect(first.progressUpdates[0].taskStatus).toBe("done");
    expect(first.source.excerptIds.length).toBeGreaterThan(0);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n).toBe(beforeSources + 1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n).toBe(beforeRecords + 1);

    const replay = await ok(t, "capture_work", args);
    expect(replay).toEqual(first);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n).toBe(beforeSources + 1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n).toBe(beforeRecords + 1);

    const outcome = await ok(t, "get_record", { recordId: first.outcome.recordId, includeUnreviewed: true });
    expect(outcome.reviewStatus).toBe("proposed");
    expect(outcome.evidence.length).toBeGreaterThan(0);
    const finishedAction = await ok(t, "get_record", { recordId: action.recordId });
    expect(finishedAction.taskStatus).toBe("done");
  });
  it("rolls back the entire capture when any progress update is stale", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await ok(t, "create_project", {
      name: "Capture rollback",
      idempotencyKey: crypto.randomUUID(),
    });
    for (const statement of ["First tracked action.", "Second tracked action."]) {
      await ok(t, "add_owner_note", {
        projectId: project.id,
        statement,
        recordType: "action",
        idempotencyKey: crypto.randomUUID(),
      });
    }
    const context = await ok(t, "get_work_context", { projectId: project.id, limitPerSection: 10 });
    const [firstAction, secondAction] = context.actions.items;
    expect(firstAction).toBeTruthy();
    expect(secondAction).toBeTruthy();
    const beforeSources = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n;
    const beforeRecords = (t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n;
    const failed = await invoke(t, "capture_work", {
      projectId: project.id,
      outcome: "This capture must roll back.",
      evidenceText: "ROLLBACK_CAPTURE_EVIDENCE",
      progressUpdates: [
        { recordId: firstAction.recordId, revision: firstAction.revision, taskStatus: "in_progress" },
        { recordId: secondAction.recordId, revision: secondAction.revision + 99, taskStatus: "done" },
      ],
      clientId: "chatgpt", sessionId: "capture-rollback-session",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent.error.code).toBe("stale_revision");
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM sources").get() as { n: number }).n).toBe(beforeSources);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) n FROM records").get() as { n: number }).n).toBe(beforeRecords);

    const unchanged = await ok(t, "get_record", { recordId: firstAction.recordId });
    expect(unchanged.revision).toBe(firstAction.revision);
    expect(unchanged.taskStatus).toBeNull();
    expect(JSON.stringify(await ok(t, "get_work_context", { projectId: project.id }))).not.toContain("ROLLBACK_CAPTURE_EVIDENCE");
  });

  it("keeps delegated capture proposal-only when its outcome collides with accepted memory", async () => {
    const t = await makeTestApp({
      mcpToken: TOKEN,
      mcpDefaultClientId: "chatgpt",
      mcpDelegateWorkingMemory: true,
    });
    tracked.push(t);
    const project = await ok(t, "create_project", { name: "Accepted collision", idempotencyKey: crypto.randomUUID() });
    const first = await ok(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Build verified.",
      evidenceText: "Initial verification evidence.",
      subject: "work-capture",
      idempotencyKey: crypto.randomUUID(),
    });
    await ok(t, "review_records", {
      items: [{ recordId: first.outcome.recordId, revision: 1 }],
      action: "accept",
      idempotencyKey: crypto.randomUUID(),
    });
    const before = await ok(t, "get_record", { recordId: first.outcome.recordId });
    const beforeProject = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };

    const second = await ok(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Build verified.",
      evidenceText: "New evidence paragraph. ".repeat(400),
      subject: "work-capture",
      idempotencyKey: crypto.randomUUID(),
    });
    const after = await ok(t, "get_record", { recordId: first.outcome.recordId });
    const working = await ok(t, "get_record", { recordId: second.outcome.recordId, includeUnreviewed: true });
    const afterProject = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
    expect(second.outcome.reviewStatus).toBe("proposed");
    expect(second.outcome.recordId).not.toBe(first.outcome.recordId);
    expect(second.outcome.canonicalDuplicateRecordId).toBe(first.outcome.recordId);
    expect(working.evidence.some((item: any) => item.sourceId === second.source.id)).toBe(true);
    expect(after.evidence.length).toBe(before.evidence.length);
    expect(after.revision).toBe(before.revision);
    expect(afterProject).toEqual(beforeProject);
  });
});
