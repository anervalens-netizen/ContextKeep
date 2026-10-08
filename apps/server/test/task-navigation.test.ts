import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const apps: TestApp[] = [];
const identity = () => ({
  clientId: "test",
  sessionId: "task-navigation",
  idempotencyKey: randomUUID(),
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
});
async function call(
  app: TestApp,
  name: string,
  args: Record<string, unknown>,
  error = false,
) {
  const response = await app.app.inject({
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
  return result.structuredContent;
}
async function setup() {
  const app = await makeTestApp({ mcpToken: token });
  apps.push(app);
  const project = await call(app, "create_project", {
    name: "Synthetic task navigation",
    ...identity(),
  });
  return { app, projectId: project.id as string };
}

describe("explicit task identity and compatible navigation", () => {
  it("recovers one concurrent intent, rejects changed payload, preserves distinct equal-title tasks and provenance", async () => {
    const { app, projectId } = await setup();
    const input = {
      projectId,
      title: "Synthetic deployment",
      objective: "Verify the synthetic service",
      ...identity(),
    };
    const [first, retry] = await Promise.all([
      call(app, "create_task", input),
      call(app, "create_task", input),
    ]);
    expect(first.taskId).toBe(retry.taskId);
    expect(first.task).toMatchObject({
      taskStatus: "open",
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
    });
    expect(first.startsExecution).toBe(false);
    await call(
      app,
      "create_task",
      { ...input, objective: "A different intent" },
      true,
    );
    const second = await call(app, "create_task", { ...input, ...identity() });
    expect(second.taskId).not.toBe(first.taskId);
    const listed = await call(app, "list_tasks", {
      projectId,
      selection: "actual_tasks",
    });
    expect(listed.total).toBe(2);
    expect(
      (
        await call(app, "list_tasks", {
          projectId,
          selection: "actual_tasks",
          q: "deployment",
          limit: 1,
        })
      ).total,
    ).toBe(2);
    expect((await call(app, "list_tasks", { projectId, q: "%" })).total).toBe(
      0,
    );
    const resumed = await call(app, "resume_task", {
      projectId,
      taskId: first.taskId,
    });
    expect(resumed.dossier.execution).toBeNull();
    expect(resumed.dossier.state).toBe("open");
  });

  it("uses task-role references, not action evidence; shares counts and pagination across list, dossier and portfolio", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Explicit task",
      objective: "Synthetic navigation",
      ...identity(),
    });
    const legacy = await call(app, "capture_work", {
      projectId,
      recordType: "action",
      subject: "Legacy action",
      outcome: "Independent synthetic identity",
      ...identity(),
    });
    const taskId = legacy.outcome.recordId;
    await call(app, "reserve_run", {
      projectId,
      taskId,
      operationKey: "synthetic-reservation",
      inputHash: "a".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Inspect synthetic evidence"],
      ...identity(),
    });
    const evidence = await call(app, "capture_work", {
      projectId,
      taskId: task.taskId,
      recordType: "action",
      subject: "Action evidence",
      outcome: "A synthetic checkpoint is evidence only",
      checkpoint: { summary: "Synthetic progress" },
      ...identity(),
    });
    expect((await call(app, "list_tasks", { projectId })).total).toBe(3);
    const first = await call(app, "list_tasks", {
      projectId,
      selection: "actual_tasks",
      limit: 1,
    });
    const second = await call(app, "list_tasks", {
      projectId,
      selection: "actual_tasks",
      limit: 1,
      offset: first.nextOffset,
    });
    expect(first.total).toBe(2);
    expect(second.total).toBe(2);
    expect(second.nextOffset).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items].map((r: { id: string }) => r.id),
      ),
    ).toEqual(new Set([task.taskId, taskId]));
    expect(
      [...first.items, ...second.items].every(
        (r: { id: string }) => r.id !== evidence.outcome.recordId,
      ),
    ).toBe(true);
    const dossier = await call(app, "get_project_dossier", {
      projectId,
      selection: "actual_tasks",
      limit: 1,
    });
    expect(dossier.pagination.total).toBe(2);
    expect(
      dossier.attention.tasks.every(
        (r: { taskId: string }) => r.taskId !== evidence.outcome.recordId,
      ),
    ).toBe(true);
    const portfolio = await call(app, "get_portfolio", {
      selection: "actual_tasks",
    });
    expect(
      portfolio.items.find((p: { id: string }) => p.id === projectId).taskCount,
    ).toBe(2);
    // Direct legacy access remains valid, even though the evidence is not a selected task.
    expect(
      (
        await call(app, "get_task", {
          projectId,
          taskId: evidence.outcome.recordId,
        })
      ).task.id,
    ).toBe(evidence.outcome.recordId);
    await call(
      app,
      "list_tasks",
      { projectId, selection: "unrecognized" },
      true,
    );
  });

  it("separates explicit project notes from legacy unscoped totals without creating tasks", async () => {
    const { app, projectId } = await setup();
    await call(app, "capture_work", {
      projectId,
      subject: "Project note",
      outcome: "Synthetic project history",
      checkpoint: {
        projectLevelIntent: "project_note",
        summary: "Project-wide note",
      },
      ...identity(),
    });
    const dossier = await call(app, "get_project_dossier", {
      projectId,
      selection: "actual_tasks",
    });
    expect(dossier).toMatchObject({
      projectNotes: 1,
      legacyUnscopedCheckpoints: 0,
      historicalUnscopedCheckpoints: 1,
    });
    expect(dossier.pagination.total).toBe(0);
  });
  it("classifies optional and deferred reports without inventing urgency, using every blocker page", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Classified task",
      objective: "Synthetic categories",
      ...identity(),
    });
    await call(app, "report_task_progress", {
      projectId,
      taskId: task.taskId,
      taskRevision: 1,
      expectedProgressRecordId: null,
      status: "in_progress",
      summary: "Synthetic progress",
      nextAction: "Continue synthetic work",
      ownerAction: "Optional preference",
      evidenceText: "Synthetic report",
      ...identity(),
    });
    await call(app, "capture_work", {
      projectId,
      taskId: task.taskId,
      subject: "Categorized checkpoint",
      outcome: "Synthetic deferred notes",
      checkpoint: {
        summary: "Synthetic categories",
        blockers: Array.from({ length: 7 }, (_, i) => ({
          text: `Deferred ${i}`,
          category: "deferred",
        })),
      },
      ...identity(),
    });
    let resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
    });
    expect(resumed.dossier.needsAttention).toBe(false);
    expect(resumed.dossier.attention.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "deferred",
          count: 7,
          requiresAction: false,
        }),
        expect.objectContaining({
          category: "owner_optional",
          requiresAction: false,
        }),
      ]),
    );
    expect(
      (
        await call(app, "get_project_dossier", {
          projectId,
          selection: "actual_tasks",
        })
      ).attention.count,
    ).toBe(0);
    await call(app, "capture_work", {
      projectId,
      taskId: task.taskId,
      subject: "Blocking checkpoint",
      outcome: "Synthetic blocking evidence",
      checkpoint: {
        summary: "Synthetic block",
        blockers: [{ text: "Inspect synthetic failure", category: "blocking" }],
      },
      ...identity(),
    });
    resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
    });
    expect(resumed.dossier.needsAttention).toBe(true);
    const beforeToken = resumed.dossier.stateToken;
    await call(app, "set_project_lifecycle", {
      projectId,
      revision: 1,
      state: "paused",
      reason: "Synthetic owner pause",
      ...identity(),
    });
    resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
    });
    expect(resumed.dossier).toMatchObject({
      needsAttention: false,
      lifecycleSuppressed: true,
      lifecycleSuppressionReason: "project_paused",
      nextAction: null,
    });
    expect(resumed.dossier.stateToken).not.toBe(beforeToken);
    expect(
      (
        await call(app, "get_portfolio", { selection: "actual_tasks" })
      ).items.find((p: { id: string }) => p.id === projectId).attentionCount,
    ).toBe(0);
    await call(app, "reserve_run", {
      projectId,
      taskId: task.taskId,
      operationKey: "synthetic-live",
      inputHash: "b".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Inspect exact synthetic run"],
      ...identity(),
    });
    resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
    });
    expect(resumed.dossier.needsAttention).toBe(true);
    expect(resumed.dossier.attention.items).toContainEqual(
      expect.objectContaining({
        category: "actionable_now",
        reason: "unresolved_execution",
      }),
    );
    expect(
      (
        await call(app, "get_project_dossier", {
          projectId,
          selection: "actual_tasks",
        })
      ).attention.tasks[0].attention,
    ).toEqual(resumed.dossier.attention);
  });

  it("keeps invalidated proof visible on a terminal task and a retired project", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Proof task",
      objective: "Synthetic proof",
      ...identity(),
    });
    const scope = { projectId, taskId: task.taskId };
    const reserved = await call(app, "reserve_run", {
      ...scope,
      operationKey: "proof-run",
      inputHash: "c".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Synthetic result"],
      ...identity(),
    });
    const runId = reserved.run.id;
    const begun = await call(app, "begin_run", {
      ...scope,
      runId,
      revision: 1,
      ...identity(),
    });
    await call(app, "attach_run_job", {
      ...scope,
      runId,
      leaseToken: begun.leaseToken,
      externalJobId: "fixture-job",
      ...identity(),
    });
    const observed = await call(app, "observe_run", {
      ...scope,
      runId,
      device: "fixture",
      identity: "owner",
      externalJobId: "fixture-job",
      eventKey: "synthetic-finished",
      exitCode: 0,
      status: "completed",
      observedAt: new Date().toISOString(),
      ...identity(),
    });
    const proof = await call(app, "capture_work", {
      ...scope,
      subject: "Bound proof",
      outcome: "Synthetic result inspected",
      runEvidence: {
        runId,
        runRevision: observed.run.revision,
        externalJobId: "fixture-job",
      },
      ...identity(),
    });
    await call(app, "verify_run", {
      ...scope,
      runId,
      revision: observed.run.revision,
      recordId: proof.outcome.recordId,
      verdict: "passed",
      ...identity(),
    });
    await call(app, "report_task_progress", {
      ...scope,
      taskRevision: 1,
      expectedProgressRecordId: null,
      status: "done",
      summary: "Synthetic result complete",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Verified synthetic result",
      ...identity(),
    });
    await call(app, "delete_record", {
      recordId: proof.outcome.recordId,
      revision: 1,
      reason: "Withdraw synthetic proof",
      ...identity(),
    });
    await call(app, "set_project_lifecycle", {
      projectId,
      revision: 1,
      state: "retired",
      reason: "Synthetic retirement",
      ...identity(),
    });
    const resumed = await call(app, "resume_task", scope);
    expect(resumed.dossier.state).toBe("done");
    expect(
      (await call(app, "list_tasks", { projectId, selection: "actual_tasks" }))
        .items[0],
    ).toMatchObject({
      taskStatus: "open",
      effectiveState: "done",
      stateSource: "reported_progress",
    });
    expect(resumed.dossier.needsAttention).toBe(true);
    expect(resumed.dossier.attention.items).toContainEqual(
      expect.objectContaining({
        category: "historical_integrity",
        reason: "invalid_execution_evidence",
        requiresAction: true,
      }),
    );
    const portfolio = await call(app, "get_portfolio", {
      selection: "actual_tasks",
      includeRetired: true,
    });
    expect(
      portfolio.items.find((p: { id: string }) => p.id === projectId)
        .attentionTasks[0].attention,
    ).toEqual(resumed.dossier.attention);
  });
});

it("filters before pagination using effective state and shared attention, retaining terminal unresolved executions",async()=>{
  const {app,projectId}=await setup();
  const ids:string[]=[];
  for(let i=0;i<4;i++) {
    const created=await call(app,"create_task",{projectId,title:"Candidate "+i,objective:"Synthetic navigation filter",...identity()});
    ids.push(created.taskId);
    if(i<3)await call(app,"report_task_progress",{projectId,taskId:created.taskId,taskRevision:1,expectedProgressRecordId:null,
      status:i<2?"done":"blocked",summary:"Synthetic reported state",nextAction:null,ownerAction:null,evidenceText:"Synthetic evidence",...identity()});
  }
  await call(app,"reserve_run",{projectId,taskId:ids[0],operationKey:"synthetic-navigation-live",inputHash:"d".repeat(64),
    device:"fixture",identity:"owner",criteria:["Inspect existing synthetic run"],...identity()});
  const scope={projectId,selection:"actual_tasks",limit:1};
  const first=await call(app,"list_tasks",{...scope,view:"active"});
  const second=await call(app,"list_tasks",{...scope,view:"active",offset:first.nextOffset});
  expect(first.total).toBe(2);expect(second.total).toBe(2);expect(second.nextOffset).toBeNull();
  expect(new Set([...first.items,...second.items].map((r:{id:string})=>r.id))).toEqual(new Set([ids[2],ids[3]]));
  const attention=await call(app,"list_tasks",{...scope,view:"attention",limit:50});
  const dossier=await call(app,"get_project_dossier",{projectId,selection:"actual_tasks"});
  expect(attention.total).toBe(dossier.attention.count);
  expect(new Set(attention.items.map((r:{id:string})=>r.id))).toEqual(new Set(dossier.attention.tasks.map((r:{taskId:string})=>r.taskId)));
  expect(attention.items.some((r:{id:string;effectiveState:string})=>r.id===ids[0]&&r.effectiveState==="done")).toBe(true);
  const filteredDossier=await call(app,"get_project_dossier",{...scope,view:"active",q:"Candidate 2"});
  expect(filteredDossier.pagination.total).toBe(1);
  expect(filteredDossier.tasks.map((r:{taskId:string})=>r.taskId)).toEqual([ids[2]]);
  // Search limits the main cards; project-wide attention must not lose another task.
  expect(filteredDossier.attention.count).toBe(attention.total);
  expect(filteredDossier.attention.tasks.some((r:{taskId:string})=>r.taskId===ids[0])).toBe(true);
  const emptyDossier=await call(app,"get_project_dossier",{...scope,view:"active",q:"no matching title"});
  expect(emptyDossier.pagination.total).toBe(0);
  expect(emptyDossier.tasks).toEqual([]);
  expect(emptyDossier.attention.count).toBe(attention.total);
  const match=await call(app,"list_tasks",{...scope,view:"active",q:"Candidate 2"});
  expect(match.total).toBe(1);expect(match.items[0].id).toBe(ids[2]);expect(match.nextOffset).toBeNull();
  expect((await call(app,"list_tasks",{...scope,view:"active",q:"%"})).total).toBe(0);
  const recent=await call(app,"list_tasks",{...scope,view:"recent",limit:50});
  expect(recent.total).toBe(4);
  expect(recent.items.map((r:{lastActivityAt:string})=>r.lastActivityAt)).toEqual(recent.items.map((r:{lastActivityAt:string})=>r.lastActivityAt).sort().reverse());
  const before=recent.total;
  expect((await call(app,"list_tasks",{projectId})).total).toBe(before);
  await call(app,"list_tasks",{...scope,view:"unknown"},true);
});
