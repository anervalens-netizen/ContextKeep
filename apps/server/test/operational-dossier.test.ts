import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import {
  getTaskProgress,
  taskDossier,
  reportTaskProgress,
  projectDossier,
  portfolioOverview,
  operationalTimeline,
  resumeTask,
  linkProject,
  projectLinks,
} from "../src/services/operational-dossier.js";
import {
  reserveRun,
  beginRun,
  attachJob,
  observeRun,
  verifyRun,
} from "../src/services/workflow.js";
import {
  setContinuationPolicy,
  claimContinuation,
  finishContinuation,
} from "../src/services/continuation.js";

const token = randomUUID(),
  tracked: TestApp[] = [];
const identity = () => ({
  clientId: "test",
  sessionId: "operational-dossier",
  idempotencyKey: randomUUID(),
});
const ctx = () => ({
  actor: "test:operational-dossier",
  requestId: randomUUID(),
});
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});
async function call(
  t: TestApp,
  name: string,
  args: Record<string, unknown> = {},
  expectError = false,
) {
  const response = await t.app.inject({
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
  expect(response.statusCode).toBe(200);
  const result = response.json().result;
  if (expectError) {
    expect(result.isError).toBe(true);
    return result;
  }
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}
async function setup() {
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  const p = await call(t, "create_project", {
    name: `Synthetic dossier ${randomUUID()}`,
    ...identity(),
  });
  const tasks: string[] = [];
  for (const subject of ["First synthetic task", "Second synthetic task"]) {
    const capture = await call(t, "capture_work", {
      projectId: p.id,
      subject,
      recordType: "action",
      outcome: subject,
      ...identity(),
    });
    tasks.push(capture.outcome.recordId);
  }
  return {
    t,
    deps: t.app.ck.deps,
    projectId: p.id,
    taskId: tasks[0]!,
    otherTaskId: tasks[1]!,
  };
}
const report = (projectId: string, taskId: string) => ({
  projectId,
  taskId,
  taskRevision: 1,
  expectedProgressRecordId: null,
  status: "in_progress" as const,
  summary: "Synthetic implementation ready for verification",
  nextAction: "Inspect synthetic artifact",
  ownerAction: null,
  evidenceText: `Synthetic evidence for ${taskId}`,
});
function terminal(
  deps: TestApp["app"]["ck"]["deps"],
  projectId: string,
  taskId: string,
) {
  const run = reserveRun(deps, {
    projectId,
    taskId,
    operationKey: randomUUID(),
    inputHash: "a".repeat(64),
    device: "fixture",
    identity: "owner",
    criteria: ["Synthetic artifact exists"],
  }).run;
  const scope = { projectId, taskId, runId: run.id };
  const start = beginRun(deps, { ...scope, revision: run.revision });
  attachJob(deps, {
    ...scope,
    leaseToken: start.leaseToken,
    externalJobId: `job-${run.id}`,
  });
  const done = observeRun(deps, {
    ...scope,
    externalJobId: `job-${run.id}`,
    device: "fixture",
    identity: "owner",
    eventKey: "terminal",
    status: "completed",
    exitCode: 0,
    observedAt: new Date().toISOString(),
  });
  return {
    ...scope,
    runRevision: done.run.revision,
    consumerId: "synthetic-consumer",
  };
}
describe("operational dossier", () => {
  it("records progress on proposed tasks without accepting knowledge; read-only resume starts nothing", async () => {
    const { t, deps, projectId, taskId } = await setup();
    const args = { ...report(projectId, taskId), ...identity() };
    const first = await call(t, "report_task_progress", args);
    const retry = await call(t, "report_task_progress", args);
    expect(retry).toEqual(first);
    const before = deps.sqlite
      .prepare("SELECT count(*) AS n FROM workflow_runs")
      .get();
    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.startsExecution).toBe(false);
    expect(resumed.dossier.state).toBe("in_progress");
    expect(resumed.dossier.taskReviewStatus).toBe("proposed");
    expect(resumed.dossier.progress.authority).toBe("reported_progress");
    expect(resumed.resumeText).toContain(taskId);
    expect(
      deps.sqlite.prepare("SELECT count(*) AS n FROM workflow_runs").get(),
    ).toEqual(before);
    const stored = deps.sqlite
      .prepare("SELECT task_status,review_status FROM records WHERE id=?")
      .get(taskId);
    expect(stored).toEqual({ task_status: null, review_status: "proposed" });
    expect(
      (await call(t, "list_tasks", { projectId })).items.find(
        (v: { id: string }) => v.id === taskId,
      ).operationalProgress.status,
    ).toBe("in_progress");
  });
  it("fences parallel writers and stale task revisions", async () => {
    const { deps, projectId, taskId } = await setup();
    const args = report(projectId, taskId);
    const first = reportTaskProgress(deps, args, ctx());
    expect(() => reportTaskProgress(deps, args, ctx())).toThrow(
      expect.objectContaining({ code: "task_progress_conflict" }),
    );
    expect(() =>
      reportTaskProgress(
        deps,
        { ...args, taskRevision: 2, expectedProgressRecordId: first.recordId },
        ctx(),
      ),
    ).toThrow(expect.objectContaining({ code: "task_revision_conflict" }));
    const second = reportTaskProgress(
      deps,
      {
        ...args,
        expectedProgressRecordId: first.recordId,
        status: "blocked",
        ownerAction: "Provide fixture input",
      },
      ctx(),
    );
    expect(second.progress?.revision).toBe(2);
    expect(second.progress?.previousRecordId).toBe(first.recordId);
  });
  it("keeps checkpoints and progress separate for parallel tasks; legacy blockers remain history", async () => {
    const { t, deps, projectId, taskId, otherTaskId } = await setup();
    reportTaskProgress(deps, report(projectId, taskId), ctx());
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "First task checkpoint",
      checkpoint: { nextAction: "First next step" },
      ...identity(),
    });
    await call(t, "capture_work", {
      projectId,
      taskId: otherTaskId,
      outcome: "Other task checkpoint",
      checkpoint: {
        nextAction: "Other next step",
        blockers: ["Other fixture missing"],
      },
      ...identity(),
    });
    await call(t, "capture_work", {
      projectId,
      outcome: "Legacy project observation",
      checkpoint: {
        nextAction: "Legacy next step",
        blockers: ["Historical blocker"],
      },
      ...identity(),
    });
    const a = taskDossier(deps, projectId, taskId),
      b = taskDossier(deps, projectId, otherTaskId);
    expect(a.nextAction).toBe("First next step");
    expect(a.blockers.activeCount).toBe(0);
    expect(b.nextAction).toBe("Other next step");
    expect(b.blockers.activeCount).toBe(1);
    expect(b.state).toBe("unknown");
    expect(projectDossier(deps, projectId).historicalUnscopedCheckpoints).toBe(
      1,
    );
  });
  it("does not infer task completion from text or an exit-zero run", async () => {
    const { t, deps, projectId, taskId } = await setup();
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "completed",
      ...identity(),
    });
    terminal(deps, projectId, taskId);
    const dossier = taskDossier(deps, projectId, taskId);
    expect(dossier.state).toBe("unknown");
    expect(dossier.execution?.status).toBe("completed");
    expect(dossier.execution?.verification).toBe("pending");
    expect(dossier.warnings.join(" ")).toMatch(/verification/);
  });
  it("rejects closing a task with an uncertain active execution", async () => {
    const { deps, projectId, taskId } = await setup();
    reserveRun(deps, {
      projectId,
      taskId,
      operationKey: "uncertain",
      inputHash: "a".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Inspect"],
    });
    expect(() =>
      reportTaskProgress(
        deps,
        { ...report(projectId, taskId), status: "done" },
        ctx(),
      ),
    ).toThrow(expect.objectContaining({ code: "task_has_live_runs" }));
    expect(getTaskProgress(deps, taskId)).toBeNull();
  });
  it("provides identical HTTP and MCP dossier semantics and explicit page totals", async () => {
    const { t, projectId, taskId } = await setup();
    await call(t, "report_task_progress", {
      ...report(projectId, taskId),
      ...identity(),
    });
    const http = await t.get(
      `/api/projects/${projectId}/dossier?offset=0&limit=1`,
    );
    expect(http.statusCode).toBe(200);
    const mcp = await call(t, "get_project_dossier", {
      projectId,
      offset: 0,
      limit: 1,
    });
    expect(http.json<{ tasks: unknown }>().tasks).toEqual(mcp.tasks);
    expect(mcp.pagination).toMatchObject({ total: 2, nextOffset: 1 });
    const resume = await t.get(
      `/api/projects/${projectId}/tasks/${taskId}/resume`,
    );
    expect(resume.json<{ startsExecution: boolean }>().startsExecution).toBe(
      false,
    );
  });
  it("excludes retired projects and never links projects by guessed names", async () => {
    const { t, deps, projectId, taskId } = await setup();
    const target = await call(t, "create_project", {
      name: "Synthetic dependency",
      ...identity(),
    });
    const linked = linkProject(
      deps,
      {
        projectId,
        targetProjectId: target.id,
        deviceId: null,
        relation: "depends_on",
        evidenceText: "Synthetic explicit dependency",
      },
      ctx(),
    );
    expect(linked.outcome.reviewStatus).toBe("proposed");
    expect(projectLinks(deps, target.id).items[0]).toMatchObject({
      projectId,
      targetProjectId: target.id,
      targetProjectName: "Synthetic dependency",
    });
    await call(t, "update_project", {
      projectId: target.id,
      revision: target.revision,
      name: "Renamed dependency",
      ...identity(),
    });
    expect(projectLinks(deps, projectId).items[0].targetProjectName).toBe(
      "Renamed dependency",
    );
    expect(() =>
      linkProject(
        deps,
        {
          projectId,
          targetProjectId: projectId,
          deviceId: null,
          relation: "depends_on",
          evidenceText: "Self",
        },
        ctx(),
      ),
    ).toThrow();
    await call(t, "set_project_lifecycle", {
      projectId,
      revision: 1,
      state: "retired",
      reason: "Synthetic completed lifecycle",
      ...identity(),
    });
    expect(portfolioOverview(deps).items.some((p) => p.id === projectId)).toBe(
      false,
    );
    expect(
      portfolioOverview(deps, 0, 20, true).items.some(
        (p) => p.id === projectId,
      ),
    ).toBe(true);
    expect(
      operationalTimeline(deps, {}).items.some(
        (v: any) => v.projectId === projectId,
      ),
    ).toBe(false);
    expect(resumeTask(deps, projectId, taskId).startsExecution).toBe(false);
  });
  it("unifies activity with provenance, scope and pagination without accepting reports", async () => {
    const { t, deps, projectId, taskId, otherTaskId } = await setup();
    reportTaskProgress(deps, report(projectId, taskId), ctx());
    await call(t, "capture_work", {
      projectId,
      taskId: otherTaskId,
      outcome: "Different task evidence",
      ...identity(),
    });
    terminal(deps, projectId, taskId);
    const activity = operationalTimeline(deps, { projectId, taskId, limit: 1 });
    expect(activity.total).toBe(3);
    expect(activity.nextOffset).toBe(1);
    const working = operationalTimeline(deps, {
      projectId,
      taskId,
      scope: "working",
    });
    expect(working.items).toHaveLength(2);
    expect(working.items.every((v: any) => v.reviewStatus === "proposed")).toBe(
      true,
    );
    expect(
      operationalTimeline(deps, { projectId, taskId, scope: "canonical" })
        .total,
    ).toBe(0);
    expect(
      operationalTimeline(deps, { projectId, taskId, scope: "executions" })
        .total,
    ).toBe(1);
    expect(
      operationalTimeline(deps, {
        projectId,
        since: "2099-01-01T00:00:00.000Z",
      }).total,
    ).toBe(0);
    await call(t, "get_changes_digest", {
      projectId,
      since: "2000-01-01T00:00:00.000Z",
      limit: 1,
    });
  });
});
describe("bounded continuation", () => {
  it("configures policy without creating a subscription; one claim wins and expiry never replays", async () => {
    const { deps, projectId, taskId } = await setup();
    const run = terminal(deps, projectId, taskId);
    expect(claimContinuation(deps, run)).toMatchObject({
      claimed: false,
      reason: "continuation_disabled",
    });
    const policy = setContinuationPolicy(
      deps,
      {
        projectId,
        taskId,
        expectedPolicyRecordId: null,
        mode: "verify_and_report",
        objective: "Verify the existing synthetic artifact",
        evidenceText: "Owner-authorized synthetic verification",
      },
      ctx(),
    );
    expect(policy.subscriptionCreated).toBe(false);
    expect(taskDossier(deps, projectId, taskId).continuation.ready).toBe(false);
    const claim = claimContinuation(deps, run);
    expect(claim.claimed).toBe(true);
    expect(
      claimContinuation(deps, { ...run, consumerId: "second-consumer" }),
    ).toMatchObject({ claimed: false, reason: "already_claimed" });
    deps.sqlite
      .prepare(
        "UPDATE workflow_continuations SET lease_until='2000-01-01T00:00:00.000Z'",
      )
      .run();
    expect(claimContinuation(deps, run)).toMatchObject({
      claimed: false,
      reason: "recovery_required",
    });
    expect(claimContinuation(deps, { ...run, runRevision: 1 })).toMatchObject({
      claimed: false,
      reason: "stale_event",
    });
  });
  it("requires same-task evidence and separate verification before completing a continuation", async () => {
    const { t, deps, projectId, taskId, otherTaskId } = await setup();
    const run = terminal(deps, projectId, taskId);
    setContinuationPolicy(
      deps,
      {
        projectId,
        taskId,
        expectedPolicyRecordId: null,
        mode: "verify_and_report",
        objective: "Inspect fixture",
        evidenceText: "Fixture authorization",
      },
      ctx(),
    );
    const claim = claimContinuation(deps, run);
    if (!claim.claimed || !("token" in claim))
      throw new Error("Expected claim");
    const wrong = await call(t, "capture_work", {
      projectId,
      taskId: otherTaskId,
      outcome: "Wrong task proof",
      ...identity(),
    });
    const finish = {
      ...run,
      token: claim.token!,
      resultRecordId: wrong.outcome.recordId,
      result: "reported" as const,
    };
    expect(() => finishContinuation(deps, finish)).toThrow(
      expect.objectContaining({ code: "continuation_evidence_missing" }),
    );
    const proof = await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Synthetic artifact verified",
      ...identity(),
    });
    finish.resultRecordId = proof.outcome.recordId;
    expect(() => finishContinuation(deps, finish)).toThrow(
      expect.objectContaining({ code: "continuation_verification_pending" }),
    );
    verifyRun(deps, {
      ...run,
      revision: run.runRevision,
      recordId: proof.outcome.recordId,
      verdict: "passed",
    });
    expect(finishContinuation(deps, finish).completed).toBe(true);
    expect(finishContinuation(deps, finish)).toMatchObject({
      completed: true,
      replay: true,
    });
    expect(claimContinuation(deps, run)).toMatchObject({
      claimed: false,
      reason: "stale_event",
    });
    expect(taskDossier(deps, projectId, taskId).state).toBe("unknown");
  });
  it("revalidates a disabled policy and closed task before claiming an event", async () => {
    const { deps, projectId, taskId } = await setup();
    const run = terminal(deps, projectId, taskId);
    const p = setContinuationPolicy(
      deps,
      {
        projectId,
        taskId,
        expectedPolicyRecordId: null,
        mode: "verify_and_report",
        objective: "Inspect fixture",
        evidenceText: "Fixture",
      },
      ctx(),
    );
    setContinuationPolicy(
      deps,
      {
        projectId,
        taskId,
        expectedPolicyRecordId: p.policy.recordId,
        mode: "off",
        objective: "Stopped by owner",
        evidenceText: "Synthetic disable",
      },
      ctx(),
    );
    expect(claimContinuation(deps, run)).toMatchObject({
      claimed: false,
      reason: "continuation_disabled",
    });
    reportTaskProgress(
      deps,
      { ...report(projectId, taskId), status: "cancelled" },
      ctx(),
    );
    expect(claimContinuation(deps, run)).toMatchObject({
      claimed: false,
      reason: "task_closed",
    });
  });
});
