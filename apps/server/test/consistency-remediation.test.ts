import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const tracked: TestApp[] = [];
const identity = () => ({
  clientId: "synthetic-remediation",
  sessionId: "synthetic-remediation",
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
  if (result?.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

async function createTask(t: TestApp, projectId: string, subject: string) {
  const result = await call(t, "capture_work", {
    projectId,
    recordType: "action",
    subject,
    outcome: subject,
    ...identity(),
  });
  return result.outcome.recordId as string;
}

async function setup() {
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  const project = await call(t, "create_project", {
    name: `Synthetic consistency ${randomUUID()}`,
    ...identity(),
  });
  const taskId = await createTask(t, project.id, "Synthetic primary task");
  return { t, projectId: project.id as string, taskId };
}

async function checkpoint(
  t: TestApp,
  projectId: string,
  taskId: string,
  nextAction: string,
) {
  return call(t, "capture_work", {
    projectId,
    taskId,
    outcome: "Synthetic checkpoint",
    checkpoint: {
      summary: "Synthetic checkpoint summary",
      nextAction,
      blockers: [],
    },
    ...identity(),
  });
}

async function progress(
  t: TestApp,
  projectId: string,
  taskId: string,
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled",
  nextAction: string | null,
  expectedProgressRecordId: string | null = null,
) {
  return call(t, "report_task_progress", {
    projectId,
    taskId,
    taskRevision: 1,
    expectedProgressRecordId,
    status,
    summary: `Synthetic ${status}`,
    nextAction,
    ownerAction: null,
    evidenceText: "Synthetic evidence only",
    ...identity(),
  });
}

async function verifiedRun(t: TestApp, projectId: string, taskId: string) {
  const inputHash = "c".repeat(64);
  const reserved = await call(t, "reserve_run", {
    projectId,
    taskId,
    operationKey: randomUUID(),
    inputHash,
    device: "synthetic",
    identity: "owner",
    criteria: ["Synthetic artifact checked"],
    ...identity(),
  });
  const scope = { projectId, taskId, runId: reserved.run.id as string };
  const begun = await call(t, "begin_run", {
    ...scope,
    revision: reserved.run.revision,
    ...identity(),
  });
  const externalJobId = `synthetic-${randomUUID()}`;
  await call(t, "attach_run_job", {
    ...scope,
    leaseToken: begun.leaseToken,
    externalJobId,
    inputHash,
    ...identity(),
  });
  const observed = await call(t, "observe_run", {
    ...scope,
    eventKey: randomUUID(),
    externalJobId,
    device: "synthetic",
    identity: "owner",
    status: "completed",
    exitCode: 0,
    observedAt: new Date().toISOString(),
    ...identity(),
  });
  const proof = await call(t, "capture_work", {
    projectId,
    taskId,
    runEvidence: {
      runId: reserved.run.id,
      runRevision: observed.run.revision,
      externalJobId,
    },
    outcome: "Synthetic terminal evidence",
    evidenceText: "Synthetic artifact independently checked",
    ...identity(),
  });
  const verified = await call(t, "verify_run", {
    ...scope,
    revision: observed.run.revision,
    recordId: proof.outcome.recordId,
    verdict: "passed",
    ...identity(),
  });
  return {
    runId: verified.run.id as string,
    proofId: proof.outcome.recordId as string,
  };
}

describe("CK consistency remediation acceptance", () => {
  it.each(["done", "cancelled", "in_progress"] as const)(
    "F01: explicit %s/null is the current next action, not an older checkpoint",
    async (status) => {
      const { t, projectId, taskId } = await setup();
      await checkpoint(t, projectId, taskId, "OBSOLETE synthetic step");
      await progress(t, projectId, taskId, status, null);
      const work = await call(t, "get_work_context", {
        projectId,
        taskId,
        limitPerSection: 2,
        totalContextBudgetChars: 60_000,
      });
      expect(work.latestNextAction).toBeNull();
      expect(work.resumeCapsule).toMatchObject({
        taskId,
        state: status,
        nextAction: null,
      });
    },
  );

  it("N01: task-scoped working memory cannot be replaced by another task's report", async () => {
    const { t, projectId, taskId } = await setup();
    const own = await checkpoint(t, projectId, taskId, "Synthetic task A step");
    const otherTaskId = await createTask(t, projectId, "Synthetic secondary task");
    const other = await call(t, "capture_work", {
      projectId,
      taskId: otherTaskId,
      outcome: "Synthetic report belonging only to task B",
      ...identity(),
    });
    const work = await call(t, "get_work_context", {
      projectId,
      taskId,
      limitPerSection: 1,
      totalContextBudgetChars: 60_000,
    });
    expect(work.workingMemory.scope).toBe("task");
    expect(work.workingMemory.taskId).toBe(taskId);
    const ids = work.workingMemory.items.map((item: { recordId: string }) => item.recordId);
    expect(ids).toContain(own.outcome.recordId);
    expect(ids).not.toContain(other.outcome.recordId);
  });

  it("N02: compact/minimal work context preserves project and task identity", async () => {
    const { t, projectId, taskId } = await setup();
    for (let i = 0; i < 3; i++) {
      await call(t, "add_owner_note", {
        projectId,
        recordType: "constraint",
        subject: `Synthetic constraint ${i}`,
        statement:
          `Synthetic invariant ${i}. ` +
          "Preserve synthetic attribution and execution safety. ".repeat(35),
        ...identity(),
      });
    }
    await checkpoint(t, projectId, taskId, "Synthetic task step");
    const work = await call(t, "get_work_context", {
      projectId,
      taskId,
      limitPerSection: 3,
      totalContextBudgetChars: 2_000,
      diagnostics: true,
    });
    expect(work.project.id).toBe(projectId);
    expect(work.taskId).toBe(taskId);
  });

  it("N03: summary retains attention from an invalid historical proof even when latest proof is valid", async () => {
    const { t, projectId, taskId } = await setup();
    const old = await verifiedRun(t, projectId, taskId);
    await new Promise((resolve) => setTimeout(resolve, 4));
    await verifiedRun(t, projectId, taskId);
    await progress(t, projectId, taskId, "done", null);
    await call(t, "delete_record", {
      recordId: old.proofId,
      revision: 1,
      reason: "Synthetic historical proof withdrawn",
      ...identity(),
    });
    const dossier = await call(t, "get_project_dossier", {
      projectId,
      offset: 0,
      limit: 50,
    });
    const summary = dossier.tasks.find(
      (item: { taskId: string }) => item.taskId === taskId,
    );
    expect(summary).toMatchObject({
      state: "done",
      needsAttention: true,
      unresolvedExecutionCount: 1,
      currentEvidenceValidity: "valid",
    });
    expect(summary.attentionReasons).toContain("unresolved_execution");
  });

  it("F04: project and portfolio surface older attention independently of recent task pagination", async () => {
    const { t, projectId, taskId } = await setup();
    await progress(
      t,
      projectId,
      taskId,
      "blocked",
      "Synthetic owner decision required",
    );
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3));
      const recent = await createTask(t, projectId, `Synthetic completed ${i}`);
      await progress(t, projectId, recent, "done", null);
    }
    const project = await call(t, "get_project_dossier", {
      projectId,
      offset: 0,
      limit: 3,
    });
    expect(project.attention.count).toBeGreaterThanOrEqual(1);
    expect(
      project.attention.tasks.map((item: { taskId: string }) => item.taskId),
    ).toContain(taskId);

    const portfolio = await call(t, "get_portfolio", { limit: 50 });
    const item = portfolio.items.find(
      (candidate: { id: string }) => candidate.id === projectId,
    );
    expect(item.attentionCount).toBeGreaterThanOrEqual(1);
    expect(
      item.attentionTasks.map((task: { taskId: string }) => task.taskId),
    ).toContain(taskId);
  });
});


describe("CK remediation budget and relation matrix", () => {
  it("keeps task identity/provenance across supported budgets and makes pinned omissions recoverable", async () => {
    const { t, projectId, taskId } = await setup();
    const pinned: string[] = [];
    for (let i = 0; i < 3; i++) {
      const note = await call(t, "add_owner_note", {
        projectId,
        recordType: "constraint",
        subject: `Synthetic pinned constraint ${i}`,
        statement:
          `Synthetic pinned invariant ${i}. ` +
          "Keep execution evidence and provenance explicit. ".repeat(24),
        ...identity(),
      });
      pinned.push(note.acceptedRecordIds[0]);
    }
    await checkpoint(t, projectId, taskId, "Synthetic obsolete checkpoint step");
    await progress(t, projectId, taskId, "done", null);

    for (const diagnostics of [false, true]) {
      for (const budget of [2_000, 6_000, 10_000, 60_000]) {
        const work = await call(t, "get_work_context", {
          projectId,
          taskId,
          permanentConstraintIds: pinned,
          limitPerSection: 5,
          totalContextBudgetChars: budget,
          diagnostics,
        });
        expect(JSON.stringify(work).length).toBeLessThanOrEqual(budget);
        expect(work.project.id).toBe(projectId);
        expect(work.taskId).toBe(taskId);
        expect(work.latestNextAction ?? work.resumeCapsule?.nextAction ?? null).toBeNull();
        for (const item of work.constraints?.items ?? []) {
          expect(item.status).toBe("accepted");
        }
        for (const item of work.workingMemory?.items ?? []) {
          expect(item.status).toBe("proposed");
        }
        const selected = new Set(
          (work.constraints?.items ?? []).map(
            (item: { recordId: string }) => item.recordId,
          ),
        );
        if (!pinned.every((id) => selected.has(id))) {
          expect(
            work.constraints?.recovery ??
              work.constraints?.permanentCore?.omittedCount ??
              work.recovery,
          ).toBeTruthy();
        }
      }
    }
  });

  it("uses the selected task identity to retrieve relevant evidence-backed relations without an extra task query string", async () => {
    const { t, projectId, taskId } = await setup();
    const imported = await call(t, "add_source", {
      projectId,
      text: "Synthetic primary task depends on verified-release-artifact.",
      authorLabel: "synthetic relation evidence",
      ...identity(),
    });
    const source = await call(t, "get_source", {
      sourceId: imported.source.id,
    });
    const created = await call(t, "create_relation", {
      projectId,
      sourceExcerptId: source.excerpts[0].id,
      subject: "Synthetic primary task",
      relation: "depends_on",
      object: "verified-release-artifact",
      evidenceBasis: "observed_technical",
      ...identity(),
    });
    await call(t, "review_records", {
      items: [
        {
          recordId: created.record.id,
          revision: created.record.revision,
        },
      ],
      action: "accept",
      ownerAction: true,
      ...identity(),
    });
    const work = await call(t, "get_work_context", {
      projectId,
      taskId,
      totalContextBudgetChars: 12_000,
    });
    expect(
      work.relations.canonical.map(
        (item: { recordId: string }) => item.recordId,
      ),
    ).toContain(created.record.id);
    expect(work.relations.working).toEqual([]);
  });
});


describe("CK remediation cross-surface utility corpus", () => {
  it("preserves terminal state while exposing a newer checkpoint only as an explicit follow-up", async () => {
    const { t, projectId, taskId } = await setup();
    await progress(t, projectId, taskId, "done", null);
    await new Promise((resolve) => setTimeout(resolve, 4));
    await checkpoint(
      t,
      projectId,
      taskId,
      "Synthetic follow-up after closure",
    );

    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.dossier).toMatchObject({
      state: "done",
      nextAction: null,
      followUp: { nextAction: "Synthetic follow-up after closure" },
    });
    expect(resumed.dossier.warnings.join(" ")).toContain("follow-up");

    const work = await call(t, "get_work_context", {
      projectId,
      taskId,
      totalContextBudgetChars: 60_000,
    });
    expect(work.latestNextAction).toBeNull();
    expect(work.resumeCapsule).toMatchObject({
      state: "done",
      nextAction: null,
      followUp: { nextAction: "Synthetic follow-up after closure" },
    });
  });

  it("answers equivalent Romanian/English resume intents from the same explicit state and never starts a run", async () => {
    const { t, projectId, taskId } = await setup();
    await checkpoint(t, projectId, taskId, "OBSOLETE rerun instruction");
    await progress(t, projectId, taskId, "done", null);
    const runCount = () =>
      (
        t.app.ck.deps.sqlite
          .prepare(
            "SELECT count(*) AS n FROM workflow_runs WHERE project_id=? AND task_id=?",
          )
          .get(projectId, taskId) as { n: number }
      ).n;
    const before = runCount();

    for (const intent of [
      "Mai trebuie ceva de făcut?",
      "Ce nu trebuie repetat?",
      "Ce s-a schimbat de la ultima verificare?",
      "What is the justified next step?",
    ]) {
      const work = await call(t, "get_work_context", {
        projectId,
        taskId,
        task: intent,
        totalContextBudgetChars: 10_000,
      });
      expect(work.taskId).toBe(taskId);
      expect(work.resumeCapsule).toMatchObject({
        state: "done",
        nextAction: null,
      });
      expect(work.latestNextAction).toBeNull();
    }

    const resumed = await call(t, "resume_task", { projectId, taskId });
    const project = await call(t, "get_project_dossier", {
      projectId,
      offset: 0,
      limit: 10,
    });
    const digest = project.tasks.find(
      (item: { taskId: string }) => item.taskId === taskId,
    );
    const handoff = await call(t, "create_task_handoff", {
      projectId,
      taskId,
      ...identity(),
    });

    expect(resumed.dossier.nextAction).toBeNull();
    expect(digest.nextAction).toBeNull();
    expect(handoff.snapshot.dossier.nextAction).toBeNull();
    expect(handoff.startsExecution).toBe(false);
    expect(runCount()).toBe(before);
  });
});


describe("F02 bounded context deduplication", () => {
  it("keeps one full current-state body and preserves working-memory pointers at 10k", async () => {
    const { t, projectId, taskId } = await setup();
    const current = await call(t, "add_owner_note", {
      projectId,
      recordType: "fact",
      subject: "Synthetic runtime version",
      statement:
        "Current runtime version is synthetic-v1. " +
        "Synthetic observed deployment state. ".repeat(45),
      ...identity(),
    });
    for (let i = 0; i < 3; i++) {
      await call(t, "capture_work", {
        projectId,
        taskId,
        outcome:
          `Synthetic task report ${i}. ` +
          "Preserve this bounded working-memory pointer. ".repeat(30),
        ...identity(),
      });
    }

    const work = await call(t, "get_work_context", {
      projectId,
      taskId,
      task: "synthetic runtime version",
      limitPerSection: 3,
      totalContextBudgetChars: 10_000,
    });
    const fact = work.facts.items.find(
      (item: { recordId: string }) =>
        item.recordId === current.acceptedRecordIds[0],
    );
    const state = work.currentState.items.find(
      (item: { recordId: string }) =>
        item.recordId === current.acceptedRecordIds[0],
    );
    expect(fact).toMatchObject({
      recordId: current.acceptedRecordIds[0],
      currentStateRef: true,
      status: "accepted",
    });
    expect(fact.text).toBeUndefined();
    expect(state?.text).toContain("synthetic-v1");
    expect(work.facts.deduplicatedCurrentStateCount).toBeGreaterThanOrEqual(1);
    expect(work.workingMemory.returned).toBeGreaterThan(0);
    expect(JSON.stringify(work).length).toBeLessThanOrEqual(10_000);
  });
});
