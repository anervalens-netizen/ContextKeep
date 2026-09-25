import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runMemoryHousekeeping } from "../src/services/housekeeping.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function setup(...names: string[]) {
  const t = await makeTestApp({
    mcpToken: TOKEN,
    mcpDefaultClientId: "chatgpt",
    mcpDelegateWorkingMemory: true,
    adapters: "manual,faketest",
  });
  tracked.push(t);
  const projects: string[] = [];
  for (const name of names) {
    projects.push((await t.post("/api/projects", { name })).json<{ id: string }>().id);
  }
  return { t, projects };
}

async function callApp(app: TestApp["app"], name: string, args: Record<string, unknown>, expectError = false) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  if (!expectError) expect(body.result?.isError, JSON.stringify(body.result?.structuredContent)).not.toBe(true);
  return body.result as { isError?: boolean; structuredContent: any };
}

async function call(t: TestApp, name: string, args: Record<string, unknown>) {
  return (await callApp(t.app, name, args)).structuredContent;
}

async function errorCall(t: TestApp, name: string, args: Record<string, unknown>) {
  const result = await callApp(t.app, name, args, true);
  expect(result.isError).toBe(true);
  return result.structuredContent.error as { code: string; message: string; details?: unknown };
}

async function checkpoint(t: TestApp, projectId: string, blockers: string[], subject = "blocker-checkpoint") {
  return call(t, "capture_working_memory", {
    projectId,
    outcome: `checkpoint ${subject}`,
    subject,
    checkpoint: { summary: `summary ${subject}`, blockers },
    idempotencyKey: crypto.randomUUID(),
  });
}

async function acceptWorkingRecord(t: TestApp, projectId: string, outcome: string, recordType: "action" | "fact" = "action") {
  const captured = await call(t, "capture_working_memory", {
    projectId,
    outcome,
    subject: `accepted-${recordType}-${crypto.randomUUID()}`,
    recordType,
    idempotencyKey: crypto.randomUUID(),
  });
  const recordId = captured.outcome.recordId as string;
  const detail = await call(t, "get_record", { recordId, includeUnreviewed: true, evidenceOffset: 0, evidenceLimit: 3 });
  await call(t, "review_records", {
    items: [{ recordId, revision: detail.revision }],
    action: "accept",
    ownerAction: true,
    idempotencyKey: crypto.randomUUID(),
  });
  return recordId;
}

describe("CKR-18 explicit blocker identity and resolution", () => {
  it("keeps same-text blockers isolated by project and blockers=[] never resolves the earlier blocker", async () => {
    const { t, projects: [a, b] } = await setup("CKR18 blocker A", "CKR18 blocker B");
    await checkpoint(t, a!, ["same blocker text"], "a-blocked");
    await checkpoint(t, b!, ["same blocker text"], "b-blocked");
    await checkpoint(t, a!, [], "a-later-empty");

    const aBefore = await call(t, "list_blockers", { projectId: a });
    const bBefore = await call(t, "list_blockers", { projectId: b });
    expect(aBefore.active).toHaveLength(1);
    expect(bBefore.active).toHaveLength(1);
    expect(aBefore.active[0].text).toBe("same blocker text");
    expect(bBefore.active[0].text).toBe("same blocker text");
    expect(aBefore.active[0].blockerId).not.toBe(bBefore.active[0].blockerId);

    await call(t, "resolve_blocker", {
      projectId: a,
      blockerId: aBefore.active[0].blockerId,
      checkpointRevision: aBefore.active[0].checkpointRevision,
      resolution: "A only was fixed.",
      disposition: "resolved",
      idempotencyKey: crypto.randomUUID(),
    });

    const aAfter = await call(t, "list_blockers", { projectId: a });
    const bAfter = await call(t, "list_blockers", { projectId: b });
    expect(aAfter.active).toHaveLength(0);
    expect(aAfter.resolved).toHaveLength(1);
    expect(bAfter.active).toHaveLength(1);
    const work = await call(t, "get_work_context", { projectId: a });
    expect(work.latestBlockers).toEqual([]);
    expect(work.blockerState.activeCount).toBe(0);
    expect(work.blockerState.resolvedCount).toBe(1);
  });

  it("keeps agent resolution working, preserves canonical cursor and never marks the linked action done", async () => {
    const { t, projects: [projectId] } = await setup("CKR18 action separation");
    const cp = await checkpoint(t, projectId!, ["waiting for dependency"], "action-blocker");
    expect(cp.outcome.reviewStatus).toBe("proposed");
    const blockers = await call(t, "list_blockers", { projectId });
    const actionId = await acceptWorkingRecord(t, projectId!, "Follow up dependency", "action");
    const beforeAction = await call(t, "get_record", { recordId: actionId, evidenceOffset: 0, evidenceLimit: 3 });
    const beforeContext = await call(t, "get_work_context", { projectId });

    const resolution = await call(t, "resolve_blocker", {
      projectId,
      blockerId: blockers.active[0].blockerId,
      checkpointRevision: blockers.active[0].checkpointRevision,
      resolution: "Dependency reported available by agent.",
      evidenceText: "Observed dependency endpoint became available.",
      actionRecordId: actionId,
      clientId: "codex",
      sessionId: "ckr18",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(resolution.reviewStatus).toBe("proposed");
    expect(resolution.evidenceBasis).toBe("agent_report");
    expect(resolution.actionUpdated).toBe(false);
    expect(resolution.actor).toContain("codex");

    const afterAction = await call(t, "get_record", { recordId: actionId, evidenceOffset: 0, evidenceLimit: 3 });
    const afterContext = await call(t, "get_work_context", { projectId });
    expect(afterAction.taskStatus).toBe(beforeAction.taskStatus);
    expect(afterAction.revision).toBe(beforeAction.revision);
    expect(afterContext.freshness.canonical.cursor).toBe(beforeContext.freshness.canonical.cursor);
    expect(afterContext.freshness.working.cursor).toBeGreaterThan(beforeContext.freshness.working.cursor);
  });

  it("replays same-key retry, rejects stale duplicate and cross-project blocker references", async () => {
    const { t, projects: [a, b] } = await setup("CKR18 retry A", "CKR18 retry B");
    await checkpoint(t, a!, ["retry blocker"], "retry-blocker");
    const state = await call(t, "list_blockers", { projectId: a });
    const blockerId = state.active[0].blockerId as string;
    const key = crypto.randomUUID();
    const args = {
      projectId: a,
      blockerId,
      checkpointRevision: state.active[0].checkpointRevision,
      resolution: "Fixed exactly once.",
      disposition: "resolved",
      idempotencyKey: key,
    };
    const first = await call(t, "resolve_blocker", args);
    const replay = await call(t, "resolve_blocker", args);
    expect(replay.resolutionRecordId).toBe(first.resolutionRecordId);

    const staleDuplicate = await errorCall(t, "resolve_blocker", { ...args, idempotencyKey: crypto.randomUUID() });
    expect(staleDuplicate.code).toBe("blocker_already_resolved");

    const cross = await errorCall(t, "resolve_blocker", {
      projectId: b,
      blockerId,
      checkpointRevision: state.active[0].checkpointRevision,
      resolution: "Wrong project must fail.",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(cross.code).toBe("blocker_project_mismatch");

    await checkpoint(t, a!, ["revision changes blocker identity"], "stale-blocker");
    const staleState = await call(t, "list_blockers", { projectId: a });
    const stale = staleState.active.find((item: any) => item.text === "revision changes blocker identity");
    t.app.ck.deps.sqlite.prepare("UPDATE records SET revision=revision+1 WHERE id=?").run(stale.checkpointRecordId);
    const staleError = await errorCall(t, "resolve_blocker", {
      projectId: a,
      blockerId: stale.blockerId,
      checkpointRevision: stale.checkpointRevision,
      resolution: "Stale ref.",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(staleError.code).toBe("blocker_stale_reference");
  });

  it("survives application restart and remains resolved without purging history", async () => {
    const { t, projects: [projectId] } = await setup("CKR18 restart");
    await checkpoint(t, projectId!, ["restart blocker"], "restart-blocker");
    const before = await call(t, "list_blockers", { projectId });
    await call(t, "resolve_blocker", {
      projectId,
      blockerId: before.active[0].blockerId,
      checkpointRevision: before.active[0].checkpointRevision,
      resolution: "Persisted before restart.",
      idempotencyKey: crypto.randomUUID(),
    });

    await t.app.close();
    const restarted = await buildApp({ config: t.config, logger: false });
    try {
      const state = (await callApp(restarted, "list_blockers", { projectId })).structuredContent;
      expect(state.active).toHaveLength(0);
      expect(state.resolved).toHaveLength(1);
      expect(state.resolved[0].blockerId).toBe(before.active[0].blockerId);
      expect(state.history).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });

  it("housekeeping protects unresolved blockers, then archives the resolved old checkpoint while retaining resolution history", async () => {
    const { t, projects: [projectId] } = await setup("CKR18 housekeeping");
    const blocked = await checkpoint(t, projectId!, ["aged blocker"], "aged-blocker");
    await checkpoint(t, projectId!, [], "newer-useful-checkpoint");
    const blockedId = blocked.outcome.recordId as string;
    const old = "2020-01-01T00:00:00.000Z";
    t.app.ck.deps.sqlite.prepare("UPDATE records SET created_at=?, recorded_at=? WHERE id=?").run(old, old, blockedId);
    const newerId = (await call(t, "get_work_context", { projectId })).latestCheckpoint.recordId as string;
    t.app.ck.deps.sqlite.prepare("UPDATE records SET created_at=?, recorded_at=? WHERE id=?").run("2020-01-02T00:00:00.000Z", "2020-01-02T00:00:00.000Z", newerId);

    const before = runMemoryHousekeeping(
      t.app.ck.deps,
      { housekeepingProposalRetentionDays: 1 },
      { actor: "test:ckr18", requestId: null },
      Date.parse("2026-09-21T00:00:00.000Z"),
    );
    expect(before.skipped).toContainEqual({ recordId: blockedId, reason: "unresolved_blocker" });

    const state = await call(t, "list_blockers", { projectId });
    const resolved = await call(t, "resolve_blocker", {
      projectId,
      blockerId: state.active[0].blockerId,
      checkpointRevision: state.active[0].checkpointRevision,
      resolution: "Explicitly fixed before retention.",
      idempotencyKey: crypto.randomUUID(),
    });
    t.app.ck.deps.sqlite.prepare("UPDATE records SET created_at=?, recorded_at=? WHERE id=?").run(old, old, resolved.resolutionRecordId);

    const after = runMemoryHousekeeping(
      t.app.ck.deps,
      { housekeepingProposalRetentionDays: 1 },
      { actor: "test:ckr18", requestId: null },
      Date.parse("2026-09-21T00:00:00.000Z"),
    );
    expect(after.archivedRecordIds).toContain(blockedId);
    expect(after.skipped).toContainEqual({ recordId: resolved.resolutionRecordId, reason: "blocker_resolution_history" });

    const finalState = await call(t, "list_blockers", { projectId });
    expect(finalState.active).toHaveLength(0);
    expect(finalState.resolved).toHaveLength(1);
    expect(finalState.history[0].checkpointStatus).toBe("rejected");
    expect(finalState.history[0].status).toBe("resolved");
  });
});
