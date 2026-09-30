import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { reportTaskProgress } from "../src/services/operational-dossier.js";
import {
  reserveRun,
  beginRun,
  attachJob,
  verifyRun,
} from "../src/services/workflow.js";

const token = randomUUID();
const tracked: TestApp[] = [];
const identity = () => ({
  clientId: "test",
  sessionId: "post-audit",
  idempotencyKey: randomUUID(),
});
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});
async function call(
  t: TestApp,
  name: string,
  args: Record<string, unknown> = {},
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
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}
async function setup() {
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  const project = await call(t, "create_project", {
    name: `Synthetic integrity ${randomUUID()}`,
    ...identity(),
  });
  const action = await call(t, "capture_work", {
    projectId: project.id,
    subject: "Synthetic task",
    recordType: "action",
    outcome: "Synthetic objective",
    ...identity(),
  });
  return {
    t,
    deps: t.app.ck.deps,
    projectId: project.id as string,
    taskId: action.outcome.recordId as string,
  };
}
async function startRun(f: Awaited<ReturnType<typeof setup>>) {
  const { projectId, taskId, deps } = f;
  const run = reserveRun(deps, {
    projectId,
    taskId,
    operationKey: randomUUID(),
    inputHash: "a".repeat(64),
    device: "fixture",
    identity: "owner",
    criteria: ["Synthetic artifact inspected"],
  }).run;
  const scope = { projectId, taskId, runId: run.id };
  const begun = beginRun(deps, { ...scope, revision: run.revision });
  const externalJobId = `synthetic-${run.id}`;
  attachJob(deps, { ...scope, leaseToken: begun.leaseToken, externalJobId });
  return { ...scope, externalJobId, device: "fixture", identity: "owner" };
}
async function observe(
  f: Awaited<ReturnType<typeof setup>>,
  run: Awaited<ReturnType<typeof startRun>>,
  observedAt: string,
  status = "completed",
) {
  return call(f.t, "observe_run", {
    ...run,
    observedAt,
    status,
    exitCode: status === "completed" ? 0 : null,
    eventKey: randomUUID(),
    ...identity(),
  });
}
async function verifiedFixture() {
  const f = await setup(),
    run = await startRun(f);
  const terminal = await observe(f, run, "2026-01-02T12:00:00.500Z");
  const proof = await call(f.t, "capture_work", {
    projectId: f.projectId,
    taskId: f.taskId,
    outcome: "Synthetic inspected result",
    evidenceText: "Synthetic artifact matches criteria",
    runEvidence: {
      runId: run.runId,
      runRevision: terminal.run.revision,
      externalJobId: run.externalJobId,
    },
    ...identity(),
  });
  const verified = verifyRun(f.deps, {
    ...run,
    revision: terminal.run.revision,
    recordId: proof.outcome.recordId,
    verdict: "passed",
  });
  return { ...f, run, proofId: proof.outcome.recordId as string, verified };
}

describe("post-audit task closure and resume contracts", () => {
  it.each(["cancelled", "done"] as const)(
    "refuses public continuation after explicit %s despite an older report",
    async (status) => {
      const f = await setup();
      const { t, deps, projectId, taskId } = f;
      await call(t, "review_records", {
        items: [{ recordId: taskId, revision: 1 }],
        action: "accept",
        ownerAction: true,
        ...identity(),
      });
      reportTaskProgress(
        deps,
        {
          projectId,
          taskId,
          taskRevision: 2,
          expectedProgressRecordId: null,
          status: "in_progress",
          summary: "Earlier synthetic progress",
          nextAction: "Inspect fixture",
          ownerAction: null,
          evidenceText: "Synthetic report",
        },
        { actor: "test:post-audit", requestId: randomUUID() },
      );
      await call(t, "set_task_continuation", {
        projectId,
        taskId,
        expectedPolicyRecordId: null,
        mode: "verify_and_report",
        objective: "Inspect existing receipt",
        evidenceText: "Synthetic authorization",
        ...identity(),
      });
      const run = await startRun(f),
        terminal = await observe(f, run, "2026-01-02T12:00:00Z");
      await call(t, "edit_record", {
        recordId: taskId,
        revision: 2,
        taskStatus: status,
        ...identity(),
      });
      const resumed = await call(t, "resume_task", { projectId, taskId });
      expect(resumed.dossier.state).toBe(status);
      expect(resumed.dossier.stateSource).toBe("task_record");
      expect(resumed.dossier.progress.status).toBe("in_progress");
      expect(resumed.dossier.taskReviewStatus).toBe("accepted");
      const claim = await call(t, "claim_continuation", {
        projectId,
        taskId,
        runId: run.runId,
        runRevision: terminal.run.revision,
        consumerId: "synthetic-consumer",
        ...identity(),
      });
      expect(claim).toMatchObject({ claimed: false, reason: "task_closed" });
      // A fresh report cannot silently reverse the explicit record closure either.
      await call(t, "report_task_progress", {
        projectId,
        taskId,
        taskRevision: 3,
        expectedProgressRecordId: resumed.dossier.progress.recordId,
        status: "in_progress",
        summary: "Fresh but not an explicit reopening",
        nextAction: null,
        ownerAction: null,
        evidenceText: "Synthetic report",
        ...identity(),
      });
      expect(
        (await call(t, "resume_task", { projectId, taskId })).dossier.state,
      ).toBe(status);
    },
  );
  it("allows explicit reopening after an old reported cancellation without accepting reports", async () => {
    const f = await setup();
    const { t, deps, projectId, taskId } = f;
    reportTaskProgress(
      deps,
      {
        projectId,
        taskId,
        taskRevision: 1,
        expectedProgressRecordId: null,
        status: "cancelled",
        summary: "Earlier stop",
        nextAction: null,
        ownerAction: null,
        evidenceText: "Synthetic cancellation",
      },
      { actor: "test:post-audit", requestId: randomUUID() },
    );
    await call(t, "edit_record", {
      recordId: taskId,
      revision: 1,
      taskStatus: "open",
      ...identity(),
    });
    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.dossier.state).toBe("open");
    expect(resumed.dossier.taskReviewStatus).toBe("proposed");
    expect(resumed.dossier.progress.status).toBe("cancelled");
  });
  it.each(["changed", "retracted"])(
    "preserves %s proof validity and warnings in the public resume text",
    async (status) => {
      const f = await verifiedFixture();
      const scope = { projectId: f.projectId, taskId: f.taskId };
      const before = await call(f.t, "resume_task", scope);
      expect(before.dossier.execution.evidenceValidity.status).toBe("valid");
      expect(before.resumeText).toContain("currentEvidenceValidity=valid");
      if (status === "changed")
        await call(f.t, "edit_record", {
          recordId: f.proofId,
          revision: 1,
          text: "Synthetic changed, uninspected conclusion",
          ...identity(),
        });
      else
        await call(f.t, "delete_record", {
          recordId: f.proofId,
          revision: 1,
          reason: "Synthetic withdrawal",
          ...identity(),
        });
      const after = await call(f.t, "resume_task", scope);
      expect(after.dossier.execution.evidenceValidity.status).toBe(status);
      expect(after.resumeText).toContain(`currentEvidenceValidity=${status}`);
      expect(after.resumeText).toContain("historicalVerification=passed");
      for (const warning of after.dossier.warnings)
        expect(after.resumeText).toContain(warning);
      expect(after.startsExecution).toBe(false);
    },
  );
});

describe("chronological executor observations", () => {
  it.each([
    ["12:00:00Z", "12:00:00.500Z", true],
    ["12:00:00.000Z", "12:00:00.500Z", true],
    ["12:00:00.1234Z", "12:00:00.1235Z", true],
    ["12:00:00.50Z", "12:00:00.500Z", false],
    ["12:00:00Z", "12:00:00.000Z", false],
    ["12:00:00.5Z", "12:00:00.499Z", false],
    ["12:00:00.9999Z", "12:00:01Z", true],
  ])("orders %s then %s correctly", async (first, second, expected) => {
    const f = await setup(),
      run = await startRun(f);
    await observe(f, run, `2026-01-02T${first}`, "lost");
    const next = await observe(f, run, `2026-01-02T${second}`);
    expect(next.applied).toBe(expected);
    expect(next.run.status).toBe(expected ? "completed" : "lost");
  });
  it("selects the latest retained mixed-precision observation, not the largest raw text", async () => {
    const f = await setup(),
      run = await startRun(f);
    await observe(f, run, "2026-01-02T12:00:00Z", "lost");
    await observe(f, run, "2026-01-02T12:00:00.500Z");
    const older = await observe(f, run, "2026-01-02T12:00:00.250Z", "failed");
    expect(older.applied).toBe(false);
    expect(older.run.status).toBe("completed");
    expect((await observe(f, run, "2026-01-02T12:00:00.750Z")).applied).toBe(
      true,
    );
    expect(
      (
        f.deps.sqlite
          .prepare(
            "SELECT observed_at FROM workflow_observations WHERE run_id=? ORDER BY observed_at DESC",
          )
          .all(run.runId) as { observed_at: string }[]
      ).some((x) => x.observed_at === "2026-01-02T12:00:00Z"),
    ).toBe(true);
  });
  it("equal or older instants preserve an existing verification; a newer instant invalidates it", async () => {
    const f = await verifiedFixture();
    for (const time of ["2026-01-02T12:00:00.5Z", "2026-01-02T12:00:00Z"]) {
      const observed = await observe(f, f.run, time, "lost");
      expect(observed.applied).toBe(false);
      expect(observed.run.verification).toBe("passed");
    }
    const newer = await observe(f, f.run, "2026-01-02T12:00:00.5001Z");
    expect(newer.applied).toBe(true);
    expect(newer.run.verification).toBe("pending");
  });
});

describe("application database readiness", () => {
  it.each([
    "projects",
    "records",
    "workflow_runs",
    "workflow_run_evidence",
    "workflow_verification_receipts",
  ])(
    "reports 503 when required table %s disappears after a healthy read",
    async (table) => {
      const { t, deps } = await setup();
      expect((await t.get("/api/health")).statusCode).toBe(200);
      deps.sqlite.exec(
        `ALTER TABLE ${table} RENAME TO synthetic_missing_table`,
      );
      try {
        const failed = await t.get("/api/health");
        expect(failed.statusCode).toBe(503);
        expect(failed.json().status).toBe("not_ready");
        expect(failed.payload).not.toContain("synthetic_missing_table");
      } finally {
        deps.sqlite.exec(
          `ALTER TABLE synthetic_missing_table RENAME TO ${table}`,
        );
      }
      expect((await t.get("/api/health")).statusCode).toBe(200);
    },
  );
  it.each([18, 20])(
    "does not claim schema 19 when the actual schema stamp is %s",
    async (version) => {
      const { t, deps } = await setup();
      deps.sqlite
        .prepare("UPDATE schema_version SET version=? WHERE version=19")
        .run(version);
      expect((await t.get("/api/health")).statusCode).toBe(503);
    },
  );
  it("checks required evidence columns rather than only table names", async () => {
    const { t, deps } = await setup();
    deps.sqlite.exec(
      "ALTER TABLE workflow_verification_receipts RENAME COLUMN evidence_hash TO synthetic_missing_hash",
    );
    const failed = await t.get("/api/health");
    expect(failed.statusCode).toBe(503);
    expect(failed.payload).not.toContain("synthetic_missing_hash");
  });
});

it("does not reinterpret a proposed text edit as an explicit task reopening", async () => {
  const f = await setup();
  const { t, deps, projectId, taskId } = f;
  await call(t, "edit_record", {
    recordId: taskId,
    revision: 1,
    taskStatus: "open",
    ...identity(),
  });
  reportTaskProgress(
    deps,
    {
      projectId,
      taskId,
      taskRevision: 2,
      expectedProgressRecordId: null,
      status: "cancelled",
      summary: "Synthetic stopped task",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Synthetic stop report",
    },
    { actor: "test:post-audit", requestId: randomUUID() },
  );
  await call(t, "edit_record", {
    recordId: taskId,
    revision: 2,
    text: "Synthetic corrected wording only",
    ...identity(),
  });
  const resumed = await call(t, "resume_task", { projectId, taskId });
  expect(resumed.dossier.state).toBe("cancelled");
  expect(resumed.dossier.stateSource).toBe("reported_progress");
  expect(resumed.dossier.taskReviewStatus).toBe("proposed");
});

it("recognizes an explicit status edit during owner acceptance, including retained audit snapshots", async () => {
  const f = await setup();
  const { t, deps, projectId, taskId } = f;
  await call(t, "set_task_continuation", {
    projectId,
    taskId,
    expectedPolicyRecordId: null,
    mode: "verify_and_report",
    objective: "Inspect the existing synthetic result",
    evidenceText: "Synthetic bounded authorization",
    ...identity(),
  });
  const run = await startRun(f),
    terminal = await observe(f, run, "2026-01-02T12:00:00Z");
  reportTaskProgress(
    deps,
    {
      projectId,
      taskId,
      taskRevision: 1,
      expectedProgressRecordId: null,
      status: "cancelled",
      summary: "Synthetic stopped task",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Synthetic stop report",
    },
    { actor: "test:post-audit", requestId: randomUUID() },
  );
  const accepted = await t.post("/api/inbox/decide", {
    items: [{ recordId: taskId, revision: 1 }],
    action: "accept",
    edits: { [taskId]: { revision: 1, taskStatus: "open" } },
    ownerAction: true,
  });
  expect(accepted.statusCode, accepted.payload).toBe(200);
  const resumed = await call(t, "resume_task", { projectId, taskId });
  expect(resumed.dossier.taskReviewStatus).toBe("accepted");
  expect(resumed.dossier.state).toBe("open");
  const claim = await call(t, "claim_continuation", {
    projectId,
    taskId,
    runId: run.runId,
    runRevision: terminal.run.revision,
    consumerId: "synthetic-consumer",
    ...identity(),
  });
  expect(claim.claimed).toBe(true);
});

it("does not reinterpret plain owner acceptance as reopening a reported cancellation", async () => {
  const f = await setup();
  const { t, deps, projectId, taskId } = f;
  await call(t, "edit_record", {
    recordId: taskId,
    revision: 1,
    taskStatus: "open",
    ...identity(),
  });
  reportTaskProgress(
    deps,
    {
      projectId,
      taskId,
      taskRevision: 2,
      expectedProgressRecordId: null,
      status: "cancelled",
      summary: "Synthetic stopped task",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Synthetic stop report",
    },
    { actor: "test:post-audit", requestId: randomUUID() },
  );
  const accepted = await t.post("/api/inbox/decide", {
    items: [{ recordId: taskId, revision: 2 }],
    action: "accept",
    edits: {},
    ownerAction: true,
  });
  expect(accepted.statusCode, accepted.payload).toBe(200);
  const resumed = await call(t, "resume_task", { projectId, taskId });
  expect(resumed.dossier.taskReviewStatus).toBe("accepted");
  expect(resumed.dossier.state).toBe("cancelled");
  expect(resumed.dossier.stateSource).toBe("reported_progress");
});
