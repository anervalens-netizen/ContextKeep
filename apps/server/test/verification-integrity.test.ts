import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import {
  reserveRun,
  beginRun,
  attachJob,
  observeRun,
  verifyRun,
  getRun,
} from "../src/services/workflow.js";
import {
  taskDossier,
  reportTaskProgress,
} from "../src/services/operational-dossier.js";

const token = randomUUID(),
  tracked: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of tracked.splice(0)) await t.cleanup();
});
const identity = () => ({
  clientId: "test",
  sessionId: "verification-integrity",
  idempotencyKey: randomUUID(),
});
async function call(
  t: TestApp,
  name: string,
  args: Record<string, unknown>,
  error = false,
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
  expect(result.isError === true, JSON.stringify(result)).toBe(error);
  return error ? result : result.structuredContent;
}
async function setup() {
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  const project = await call(t, "create_project", {
    name: "Synthetic evidence project",
    ...identity(),
  });
  async function task(subject: string) {
    return (
      await call(t, "capture_work", {
        projectId: project.id,
        outcome: subject,
        subject,
        recordType: "action",
        ...identity(),
      })
    ).outcome.recordId as string;
  }
  const taskId = await task("First synthetic action"),
    otherTaskId = await task("Second synthetic action");
  return {
    t,
    deps: t.app.ck.deps,
    scope: { projectId: project.id, taskId },
    otherTaskId,
  };
}
function terminal(
  deps: TestApp["app"]["ck"]["deps"],
  scope: { projectId: string; taskId: string },
) {
  const reserved = reserveRun(deps, {
    ...scope,
    operationKey: randomUUID(),
    inputHash: "a".repeat(64),
    device: "fixture",
    identity: "owner",
    criteria: ["Synthetic receipt inspected"],
  }).run;
  const runScope = { ...scope, runId: reserved.id };
  const start = beginRun(deps, { ...runScope, revision: reserved.revision });
  const externalJobId = `fixture-${reserved.id}`;
  attachJob(deps, { ...runScope, leaseToken: start.leaseToken, externalJobId });
  const completed = observeRun(deps, {
    ...runScope,
    externalJobId,
    device: "fixture",
    identity: "owner",
    eventKey: randomUUID(),
    status: "completed",
    exitCode: 0,
    observedAt: new Date().toISOString(),
  }).run;
  return { ...runScope, revision: completed.revision, externalJobId };
}
async function captureProof(
  t: TestApp,
  run: ReturnType<typeof terminal>,
  outcome = "Synthetic receipt inspected",
) {
  return call(t, "capture_work", {
    projectId: run.projectId,
    taskId: run.taskId,
    outcome,
    evidenceText: "Synthetic independent receipt and artifact inspection",
    runEvidence: {
      runId: run.runId,
      runRevision: run.revision,
      externalJobId: run.externalJobId,
    },
    ...identity(),
  });
}
function doneInput(scope: { projectId: string; taskId: string }) {
  return {
    ...scope,
    taskRevision: 1,
    expectedProgressRecordId: null,
    status: "done" as const,
    summary: "Synthetic completion",
    nextAction: null,
    ownerAction: null,
    evidenceText: "Synthetic completion report",
  };
}

describe("correlated verification and current evidence validity", () => {
  it.each(["report", "evidence"])(
    "rejects a %s edit between inspected capture and verification",
    async (kind) => {
      const { t, deps, scope } = await setup();
      const run = terminal(deps, scope),
        proof = await captureProof(t, run);
      if (kind === "report") {
        await call(t, "edit_record", {
          recordId: proof.outcome.recordId,
          revision: 1,
          text: "Concurrent uninspected conclusion",
          ...identity(),
        });
      } else {
        const extra = await call(t, "capture_work", {
          ...scope,
          outcome: "Separate synthetic evidence",
          evidenceText: "New uninspected supporting text",
          ...identity(),
        });
        deps.sqlite
          .prepare(
            `INSERT INTO record_evidence(record_id,excerpt_id,relation)
        SELECT ?,excerpt_id,relation FROM record_evidence WHERE record_id=?`,
          )
          .run(proof.outcome.recordId, extra.outcome.recordId);
        expect(
          deps.sqlite
            .prepare("SELECT revision FROM records WHERE id=?")
            .get(proof.outcome.recordId),
        ).toMatchObject({ revision: 1 });
      }
      expect(() =>
        verifyRun(deps, {
          ...run,
          recordId: proof.outcome.recordId,
          verdict: "passed",
        }),
      ).toThrow(
        expect.objectContaining({ code: "verification_evidence_changed" }),
      );
      expect(
        getRun(deps, scope.projectId, scope.taskId, run.runId).verification,
      ).toBe("pending");
      expect(
        deps.sqlite
          .prepare("SELECT count(*) AS n FROM workflow_verification_receipts")
          .get(),
      ).toEqual({ n: 0 });
    },
  );
  it("permits acceptance of the inspected proof before verification", async () => {
    const { t, deps, scope } = await setup();
    const run = terminal(deps, scope),
      proof = await captureProof(t, run);
    await call(t, "review_records", {
      items: [{ recordId: proof.outcome.recordId, revision: 1 }],
      action: "accept",
      ownerAction: true,
      ...identity(),
    });
    verifyRun(deps, {
      ...run,
      recordId: proof.outcome.recordId,
      verdict: "passed",
    });
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution
        ?.evidenceValidity.status,
    ).toBe("valid");
  });

  it("rejects unrelated same-task evidence even when it is recent", async () => {
    const { t, deps, scope } = await setup();
    const old = await call(t, "capture_work", {
      ...scope,
      outcome: "Before the execution",
      ...identity(),
    });
    const run = terminal(deps, scope);
    const fresh = await call(t, "capture_work", {
      ...scope,
      outcome: "Recent but not correlated",
      ...identity(),
    });
    for (const report of [old, fresh])
      expect(() =>
        verifyRun(deps, {
          ...run,
          recordId: report.outcome.recordId,
          verdict: "passed",
        }),
      ).toThrow(
        expect.objectContaining({ code: "verification_evidence_unbound" }),
      );
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution?.verification,
    ).toBe("pending");
  });
  it("rejects a mismatched receipt or revision without persisting a report", async () => {
    const { t, deps, scope } = await setup();
    const run = terminal(deps, scope);
    const count = () =>
      (
        deps.sqlite.prepare("SELECT count(*) AS n FROM records").get() as {
          n: number;
        }
      ).n;
    const before = count();
    for (const bad of [
      { externalJobId: "wrong-receipt" },
      { runRevision: run.revision - 1 },
    ]) {
      const failure = await call(
        t,
        "capture_work",
        {
          ...scope,
          outcome: "Invalid fixture",
          runEvidence: {
            runId: run.runId,
            runRevision: run.revision,
            externalJobId: run.externalJobId,
            ...bad,
          },
          ...identity(),
        },
        true,
      );
      expect(JSON.stringify(failure)).toContain("evidence_receipt_mismatch");
    }
    expect(count()).toBe(before);
  });
  it("never reuses a report binding across two executions of the same task", async () => {
    const { t, deps, scope } = await setup();
    const first = terminal(deps, scope),
      a = await captureProof(t, first);
    const second = terminal(deps, scope),
      b = await captureProof(t, second);
    expect(a.outcome.recordId).not.toBe(b.outcome.recordId);
    expect(() =>
      verifyRun(deps, {
        ...second,
        recordId: a.outcome.recordId,
        verdict: "passed",
      }),
    ).toThrow(expect.objectContaining({ code: "verification_evidence_stale" }));
    expect(
      verifyRun(deps, {
        ...second,
        recordId: b.outcome.recordId,
        verdict: "passed",
      }).run.evidenceValidity.status,
    ).toBe("valid");
  });
  it("preserves historical completion while a retracted proof blocks a new completion report", async () => {
    const { t, deps, scope } = await setup();
    const run = terminal(deps, scope),
      proof = await captureProof(t, run);
    verifyRun(deps, {
      ...run,
      recordId: proof.outcome.recordId,
      verdict: "passed",
    });
    const finished = reportTaskProgress(deps, doneInput(scope), {
      actor: "test",
      requestId: randomUUID(),
    });
    const before = taskDossier(deps, scope.projectId, scope.taskId);
    const deletion = await call(t, "delete_record", {
      recordId: proof.outcome.recordId,
      revision: 1,
      reason: "Synthetic evidence withdrawal",
      ...identity(),
    });
    const after = taskDossier(deps, scope.projectId, scope.taskId);
    expect(after.state).toBe("done");
    expect(after.execution?.verification).toBe("passed");
    expect(after.execution?.evidenceValidity.status).toBe("retracted");
    expect(after.stateToken).not.toBe(before.stateToken);
    expect(after.warnings.join(" ")).toContain("retracted");
    expect(() =>
      reportTaskProgress(
        deps,
        { ...doneInput(scope), expectedProgressRecordId: finished.recordId },
        { actor: "test", requestId: randomUUID() },
      ),
    ).toThrow(expect.objectContaining({ code: "task_verification_required" }));
    const record = await call(t, "get_record", {
      recordId: proof.outcome.recordId,
      includeUnreviewed: true,
    });
    await call(t, "restore_record", {
      recordId: proof.outcome.recordId,
      revision: record.revision,
      deletionId: deletion.deletionId,
      ownerAction: false,
      ...identity(),
    });
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution
        ?.evidenceValidity.status,
    ).toBe("valid");
  });
  it("detects semantic edits and supports a new explicit verification without rewriting the receipt", async () => {
    const { t, deps, scope } = await setup();
    let run = terminal(deps, scope);
    const proof = await captureProof(t, run);
    verifyRun(deps, {
      ...run,
      recordId: proof.outcome.recordId,
      verdict: "passed",
    });
    await call(t, "edit_record", {
      recordId: proof.outcome.recordId,
      revision: 1,
      text: "Changed synthetic conclusion",
      ...identity(),
    });
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution
        ?.evidenceValidity.status,
    ).toBe("changed");
    run = {
      ...run,
      revision: getRun(deps, scope.projectId, scope.taskId, run.runId).revision,
    };
    const fresh = await captureProof(t, run, "Fresh independent re-inspection");
    verifyRun(deps, {
      ...run,
      recordId: fresh.outcome.recordId,
      verdict: "passed",
    });
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution
        ?.evidenceValidity.status,
    ).toBe("valid");
    expect(
      (
        deps.sqlite
          .prepare(
            "SELECT count(*) AS n FROM workflow_verification_receipts WHERE run_id=?",
          )
          .get(run.runId) as { n: number }
      ).n,
    ).toBe(2);
  });
  it("treats owner acceptance alone differently from a semantic change", async () => {
    const { t, deps, scope } = await setup();
    const run = terminal(deps, scope),
      proof = await captureProof(t, run);
    verifyRun(deps, {
      ...run,
      recordId: proof.outcome.recordId,
      verdict: "passed",
    });
    await call(t, "review_records", {
      items: [{ recordId: proof.outcome.recordId, revision: 1 }],
      action: "accept",
      ownerAction: true,
      ...identity(),
    });
    expect(
      taskDossier(deps, scope.projectId, scope.taskId).execution
        ?.evidenceValidity.status,
    ).toBe("valid");
  });
  it("labels legacy verification without fabricating a binding", async () => {
    const { t, deps, scope } = await setup();
    const run = terminal(deps, scope);
    const old = await call(t, "capture_work", {
      ...scope,
      outcome: "Legacy retained evidence",
      ...identity(),
    });
    deps.sqlite
      .prepare(
        "UPDATE workflow_runs SET verification='passed',verification_record_id=? WHERE id=?",
      )
      .run(old.outcome.recordId, run.runId);
    const dossier = taskDossier(deps, scope.projectId, scope.taskId);
    expect(dossier.execution?.evidenceValidity.status).toBe("legacy_unbound");
    expect(() =>
      reportTaskProgress(deps, doneInput(scope), {
        actor: "test",
        requestId: randomUUID(),
      }),
    ).toThrow(expect.objectContaining({ code: "task_verification_required" }));
  });
});

describe("blocker resolution traceability and readiness", () => {
  it("records the resolution in its task, not the adjacent task, and replays safely", async () => {
    const { t, scope, otherTaskId } = await setup();
    await call(t, "capture_work", {
      ...scope,
      outcome: "Synthetic blocked checkpoint",
      checkpoint: { blockers: ["Synthetic prerequisite missing"] },
      ...identity(),
    });
    const before = await call(t, "get_task", scope),
      blocker = before.blockers.active[0];
    const request = {
      projectId: scope.projectId,
      blockerId: blocker.blockerId,
      checkpointRevision: blocker.checkpointRevision,
      resolution: "Synthetic prerequisite now satisfied",
      evidenceText: "Synthetic resolution receipt",
      ...identity(),
    };
    const resolution = await call(t, "resolve_blocker", request),
      replay = await call(t, "resolve_blocker", request);
    expect(replay.resolutionRecordId).toBe(resolution.resolutionRecordId);
    const after = await call(t, "get_task", scope);
    expect(after.blockers.active).toHaveLength(0);
    expect(
      after.records.some(
        (r: { id: string }) => r.id === resolution.resolutionRecordId,
      ),
    ).toBe(true);
    for (const query of [{ projectId: scope.projectId }, scope]) {
      const timeline = await call(t, "get_operational_timeline", {
        ...query,
        scope: "all",
        limit: 50,
      });
      expect(
        timeline.items.some(
          (r: { recordId: string }) =>
            r.recordId === resolution.resolutionRecordId,
        ),
      ).toBe(true);
    }
    const other = await call(t, "get_task", {
      projectId: scope.projectId,
      taskId: otherTaskId,
    });
    expect(
      other.records.some(
        (r: { id: string }) => r.id === resolution.resolutionRecordId,
      ),
    ).toBe(false);
  });
  it("keeps legacy unscoped resolution out of every task", async () => {
    const { t, deps, scope } = await setup();
    await call(t, "capture_work", {
      projectId: scope.projectId,
      outcome: "Legacy blocker",
      checkpoint: { projectLevelIntent: "project_note", blockers: ["Synthetic legacy dependency"] },
      ...identity(),
    });
    const blocker = (
      await call(t, "list_blockers", { projectId: scope.projectId })
    ).active[0];
    const resolution = await call(t, "resolve_blocker", {
      projectId: scope.projectId,
      blockerId: blocker.blockerId,
      checkpointRevision: blocker.checkpointRevision,
      resolution: "Legacy dependency resolved",
      ...identity(),
    });
    expect(
      (
        deps.sqlite
          .prepare(
            "SELECT count(*) AS n FROM workflow_task_records WHERE record_id=?",
          )
          .get(resolution.resolutionRecordId) as { n: number }
      ).n,
    ).toBe(0);
  });
  it("requires authentication and reports real read failure without private details", async () => {
    const { t, deps } = await setup();
    expect((await t.raw("GET", "/api/health")).statusCode).toBe(401);
    const ready = await t.get("/api/health");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ready",
      database: "reachable",
      schemaVersion: 19,
    });
    expect(ready.headers["cache-control"]).toContain("no-store");
    const original = deps.sqlite.prepare.bind(deps.sqlite);
    vi.spyOn(deps.sqlite, "prepare").mockImplementation(((sql: string) => {
      if (sql === "SELECT MAX(version) AS version FROM schema_version")
        throw new Error("Private failure details");
      return original(sql);
    }) as typeof deps.sqlite.prepare);
    const failed = await t.get("/api/health");
    expect(failed.statusCode).toBe(503);
    expect(failed.payload).not.toContain("Private failure");
    expect((await t.get("/api/not-a-real-route")).statusCode).toBe(404);
  });
});
