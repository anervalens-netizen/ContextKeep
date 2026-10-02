import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const tracked: TestApp[] = [];
const identity = () => ({
  clientId: "usage-hardening-test",
  sessionId: "usage-hardening",
  idempotencyKey: randomUUID(),
});

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function call(
  t: TestApp,
  name: string,
  args: Record<string, unknown>,
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
    return result.structuredContent;
  }
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}

async function setup() {
  const t = await makeTestApp({
    mcpToken: token,
    mcpDelegateWorkingMemory: true,
    mcpDefaultClientId: "usage-hardening-test",
  });
  tracked.push(t);
  const project = await call(t, "create_project", {
    name: `Synthetic usage hardening ${randomUUID()}`,
    ...identity(),
  });
  const task = await call(t, "capture_work", {
    projectId: project.id,
    recordType: "action",
    subject: "Synthetic task",
    outcome: "Implement synthetic change",
    ...identity(),
  });
  return { t, projectId: project.id as string, taskId: task.outcome.recordId as string };
}

async function verifiedTerminal(t: TestApp, projectId: string, taskId: string) {
  const inputHash = "b".repeat(64);
  const reserved = await call(t, "reserve_run", {
    projectId,
    taskId,
    operationKey: `verified-${randomUUID()}`,
    inputHash,
    device: "fixture",
    identity: "owner",
    criteria: ["Synthetic result is complete"],
    ...identity(),
  });
  const begun = await call(t, "begin_run", {
    projectId,
    taskId,
    runId: reserved.run.id,
    revision: reserved.run.revision,
    ...identity(),
  });
  const externalJobId = `job-${randomUUID()}`;
  const attached = await call(t, "attach_run_job", {
    projectId,
    taskId,
    runId: reserved.run.id,
    leaseToken: begun.leaseToken,
    externalJobId,
    inputHash,
    ...identity(),
  });
  const observed = await call(t, "observe_run", {
    projectId,
    taskId,
    runId: reserved.run.id,
    eventKey: `event-${randomUUID()}`,
    externalJobId,
    device: "fixture",
    identity: "owner",
    status: "completed",
    exitCode: 0,
    observedAt: new Date().toISOString(),
    ...identity(),
  });
  expect(attached.run.status).toBe("running");
  const proof = await call(t, "capture_work", {
    projectId,
    taskId,
    runEvidence: {
      runId: reserved.run.id,
      runRevision: observed.run.revision,
      externalJobId,
    },
    outcome: "Verified synthetic terminal result",
    evidenceText: "Inspected exact synthetic executor receipt and artifact.",
    subject: "terminal-proof",
    ...identity(),
  });
  const verified = await call(t, "verify_run", {
    projectId,
    taskId,
    runId: reserved.run.id,
    revision: observed.run.revision,
    recordId: proof.outcome.recordId,
    verdict: "passed",
    ...identity(),
  });
  expect(verified.run.evidenceValidity.status).toBe("valid");
  return verified.run;
}

describe("usage hardening regressions", () => {
  it("requires explicit project intent for unscoped checkpoints and retains task scope", async () => {
    const { t, projectId, taskId } = await setup();

    const rejected = await call(
      t,
      "capture_work",
      {
        projectId,
        outcome: "Accidental unscoped checkpoint",
        checkpoint: { nextAction: "Would be lost from task resume" },
        ...identity(),
      },
      true,
    );
    expect(rejected.error.code).toBe("checkpoint_task_required");

    const projectNote = await call(t, "capture_work", {
      projectId,
      outcome: "Explicit project history",
      checkpoint: {
        projectLevelIntent: "project_note",
        blockers: ["Compatibility blocker mention"],
      },
      ...identity(),
    });
    expect(projectNote.captureScope).toBe("project");
    expect(projectNote.warnings.join(" ")).toContain("excluded from resume_task");

    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Task checkpoint",
      checkpoint: {
        blockers: [
          { text: "Await fixture", category: "deferred", logicalKey: "fixture-wait" },
        ],
      },
      ...identity(),
    });
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Second task checkpoint",
      checkpoint: {
        blockers: [
          { text: "Await fixture", category: "deferred", logicalKey: "fixture-wait" },
        ],
      },
      ...identity(),
    });

    const taskBlockers = await call(t, "list_blockers", {
      projectId,
      taskId,
      offset: 0,
      limit: 25,
    });
    expect(taskBlockers.activeCount).toBe(2);
    expect(taskBlockers.active.every((b: any) => b.category === "deferred")).toBe(true);
    expect(taskBlockers.active.every((b: any) => b.logicalKey === "fixture-wait")).toBe(true);

    const projectBlockers = await call(t, "list_blockers", {
      projectId,
      offset: 0,
      limit: 25,
    });
    const legacy = projectBlockers.active.find((b: any) => b.text === "Compatibility blocker mention");
    expect(legacy.category).toBe("legacy");
  });

  it("puts current state/blockers/unresolved history before the original objective", async () => {
    const { t, projectId, taskId } = await setup();
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Blocked checkpoint",
      checkpoint: {
        blockers: [{ text: "Synthetic owner check", category: "verification" }],
      },
      ...identity(),
    });

    const old = await call(t, "reserve_run", {
      projectId,
      taskId,
      operationKey: "older-uncertain",
      inputHash: "a".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Inspect uncertain start"],
      ...identity(),
    });
    await call(t, "begin_run", {
      projectId,
      taskId,
      runId: old.run.id,
      revision: old.run.revision,
      ...identity(),
    });

    const latest = await verifiedTerminal(t, projectId, taskId);
    expect(latest.status).toBe("completed");

    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.dossier.execution.id).toBe(latest.id);
    expect(resumed.dossier.unresolvedExecutions.total).toBe(1);
    expect(resumed.dossier.unresolvedExecutions.items[0].id).toBe(old.run.id);
    expect(resumed.resumeText).toContain("Active blockers: 1");
    expect(resumed.resumeText).toContain(`Unresolved run ${old.run.id}`);
    expect(resumed.resumeText.indexOf("Current task state:")).toBeLessThan(
      resumed.resumeText.indexOf("Historical/original objective:"),
    );
  });

  it("warns when a terminal task retains active blocker mentions without changing task state", async () => {
    const { t, projectId, taskId } = await setup();
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Deferred device check",
      checkpoint: {
        blockers: [{ text: "Physical device deferred", category: "deferred" }],
      },
      ...identity(),
    });
    await call(t, "report_task_progress", {
      projectId,
      taskId,
      taskRevision: 1,
      expectedProgressRecordId: null,
      status: "done",
      summary: "Scoped work is complete",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Synthetic completion evidence independent of deferred device check.",
      ...identity(),
    });
    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.dossier.state).toBe("done");
    expect(resumed.dossier.blockers.activeCount).toBe(1);
    expect(resumed.dossier.warnings.join(" ")).toContain("retains 1 active blocker");
  });

  it("keeps canonical handoff canonical while operational handoff includes proposed progress", async () => {
    const { t, projectId, taskId } = await setup();
    const marker = `operational-marigold-${randomUUID()}`;
    await call(t, "report_task_progress", {
      projectId,
      taskId,
      taskRevision: 1,
      expectedProgressRecordId: null,
      status: "in_progress",
      summary: marker,
      nextAction: "Continue synthetic qualification",
      ownerAction: null,
      evidenceText: "Synthetic operational progress evidence.",
      ...identity(),
    });

    const operational = await call(t, "create_task_handoff", {
      projectId,
      taskId,
      ...identity(),
    });
    expect(operational.reviewStatus).toBe("proposed");
    expect(operational.snapshot.operationalContext.progress.summary).toBe(marker);
    expect(operational.snapshot.semantics).toContain("not a canonical handoff");

    const stored = t.app.ck.handle.sqlite.prepare(
      "SELECT value_json AS valueJson FROM records WHERE id=?",
    ).get(operational.recordId) as { valueJson: string };
    expect(JSON.parse(stored.valueJson).operationalContext.progress.summary).toBe(marker);

    const canonical = await call(t, "create_handoff", {
      projectId,
      objective: null,
      contextBudgetChars: 20000,
      ...identity(),
    });
    expect(canonical.markdown).not.toContain(marker);
  });

  it("keeps search compatibility by default and removes the duplicate canonical alias only in compact mode", async () => {
    const { t, projectId } = await setup();
    const marker = `persimmon-${randomUUID()}`;
    await call(t, "add_owner_note", {
      projectId,
      statement: `Canonical ${marker}`,
      recordType: "fact",
      subject: "search-marker",
      ...identity(),
    });
    const full = await call(t, "search_context", {
      projectId,
      q: marker,
      scope: "canonical",
    });
    expect(full.records.length).toBeGreaterThan(0);
    expect(full.canonicalRecords).toEqual(full.records);

    const compact = await call(t, "search_context", {
      projectId,
      q: marker,
      scope: "canonical",
      compact: true,
    });
    expect(compact.compact).toBe(true);
    expect(compact.records).toEqual(full.records);
    expect("canonicalRecords" in compact).toBe(false);
  });

  it("reconciles an uncertain run from exact evidence without replay and allows proof of the resolved non-start", async () => {
    const { t, projectId, taskId } = await setup();
    const inputHash = "c".repeat(64);
    const operationKey = "synthetic-uncertain";
    const reserved = await call(t, "reserve_run", {
      projectId,
      taskId,
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
      criteria: ["No external start occurred"],
      ...identity(),
    });
    const begun = await call(t, "begin_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: reserved.run.revision,
      ...identity(),
    });
    expect(begun.run.status).toBe("job_start_uncertain");
    const recoveryView = await call(t, "get_task", {
      projectId,
      taskId,
      offset: 0,
      limit: 20,
    });
    const recoveryRun = recoveryView.runs.find((run: any) => run.id === reserved.run.id);
    expect(recoveryRun.recoveryIdentity).toEqual({
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
    });
    expect("leaseToken" in recoveryRun).toBe(false);

    const wrong = await call(
      t,
      "reconcile_uncertain_run",
      {
        projectId,
        taskId,
        runId: reserved.run.id,
        revision: begun.run.revision,
        operationKey,
        inputHash: "d".repeat(64),
        device: "fixture",
        identity: "owner",
        disposition: "not_started",
        externalJobId: null,
        evidenceText: "Inspected exact synthetic executor registry.",
        evidenceSource: "synthetic executor registry",
        observedAt: new Date().toISOString(),
        ...identity(),
      },
      true,
    );
    expect(wrong.error.code).toBe("run_identity_conflict");

    const reconciled = await call(t, "reconcile_uncertain_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: begun.run.revision,
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
      disposition: "not_started",
      externalJobId: null,
      evidenceText: "Inspected exact synthetic executor registry and confirmed no start.",
      evidenceSource: "synthetic executor registry",
      observedAt: new Date().toISOString(),
      ...identity(),
    });
    expect(reconciled.executionStarted).toBe(false);
    expect(reconciled.run.status).toBe("not_started");
    expect(reconciled.run.reconciliation.disposition).toBe("not_started");

    const proof = await call(t, "capture_work", {
      projectId,
      taskId,
      runEvidence: {
        runId: reserved.run.id,
        runRevision: reconciled.run.revision,
        externalJobId: null,
      },
      outcome: "Verified reconciled non-start",
      evidenceText: "Re-read the exact reconciliation evidence and run identity.",
      subject: "non-start-proof",
      ...identity(),
    });
    const verified = await call(t, "verify_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: reconciled.run.revision,
      recordId: proof.outcome.recordId,
      verdict: "failed",
      ...identity(),
    });
    expect(verified.run.verification).toBe("failed");
    expect(verified.run.evidenceValidity.status).toBe("valid");

    const resumed = await call(t, "resume_task", { projectId, taskId });
    expect(resumed.dossier.unresolvedExecutions.total).toBe(0);
  });

  it("keeps state tokens bounded when blocker text is large", async () => {
    const { t, projectId, taskId } = await setup();
    await call(t, "capture_work", {
      projectId,
      taskId,
      outcome: "Large synthetic blocker checkpoint",
      checkpoint: {
        blockers: Array.from({ length: 5 }, (_, index) => ({
          text: `Blocker ${index} ${"x".repeat(980)}`,
          category: "blocking",
          logicalKey: `large-${index}-${"y".repeat(150)}`,
        })),
      },
      ...identity(),
    });
    const dossier = await call(t, "get_project_dossier", {
      projectId,
      offset: 0,
      limit: 20,
    });
    const task = dossier.tasks.find((item: any) => item.taskId === taskId);
    expect(task.stateToken.length).toBeLessThan(1024);
    const portfolio = await call(t, "get_portfolio", {
      offset: 0,
      limit: 20,
      includeRetired: false,
    });
    expect(portfolio.items.some((item: any) => item.id === projectId)).toBe(true);
  });

  it("can attach an exact receipt discovered after an explicit lost reconciliation without replay", async () => {
    const { t, projectId, taskId } = await setup();
    const inputHash = "e".repeat(64);
    const operationKey = "late-receipt";
    const reserved = await call(t, "reserve_run", {
      projectId,
      taskId,
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
      criteria: ["Recover a later discovered receipt"],
      ...identity(),
    });
    const begun = await call(t, "begin_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: reserved.run.revision,
      ...identity(),
    });
    const lost = await call(t, "reconcile_uncertain_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: begun.run.revision,
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
      disposition: "lost",
      externalJobId: null,
      evidenceText: "Initial exact executor inspection could not recover the receipt.",
      evidenceSource: "synthetic executor registry",
      observedAt: new Date().toISOString(),
      ...identity(),
    });
    expect(lost.run.status).toBe("lost");
    expect(lost.run.recoveryIdentity.inputHash).toBe(inputHash);

    const externalJobId = `job-${randomUUID()}`;
    const attached = await call(t, "reconcile_uncertain_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      revision: lost.run.revision,
      operationKey,
      inputHash,
      device: "fixture",
      identity: "owner",
      disposition: "attached",
      externalJobId,
      evidenceText: "A later exact registry read found the retained executor receipt.",
      evidenceSource: "synthetic executor registry exact receipt",
      observedAt: new Date().toISOString(),
      ...identity(),
    });
    expect(attached.executionStarted).toBe(false);
    expect(attached.run.status).toBe("running");
    expect(attached.run.externalJobId).toBe(externalJobId);

    const observed = await call(t, "observe_run", {
      projectId,
      taskId,
      runId: reserved.run.id,
      eventKey: `late-${randomUUID()}`,
      externalJobId,
      device: "fixture",
      identity: "owner",
      status: "completed",
      exitCode: 0,
      observedAt: new Date().toISOString(),
      ...identity(),
    });
    expect(observed.run.status).toBe("completed");
  });
});
