import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

import { compactLatestCheckpoint } from "../src/services/context-packing.js";
import { workflowResults } from "../src/mcp/workflow-results.js";

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

describe("bounded operational resume", () => {
  it("retains proposed state authority at the minimum work-context budget", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Synthetic completed work",
      objective: "Implement the old plan",
      ...identity(),
    });
    const progress = await call(app, "report_task_progress", {
      projectId,
      taskId: task.taskId,
      taskRevision: task.task.revision,
      expectedProgressRecordId: null,
      status: "done",
      summary: "Synthetic verification complete",
      nextAction: null,
      ownerAction: null,
      evidenceText: "Inspected synthetic artifact; all criteria passed",
      ...identity(),
    });
    for (const budget of [2000, 6000]) {
      const context = await call(app, "get_work_context", {
        projectId,
        taskId: task.taskId,
        totalContextBudgetChars: budget,
      });
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(budget);
      expect(context.resumeCapsule).toMatchObject({
        state: "done",
        stateSource: "reported_progress",
        stateRecordId: progress.recordId,
        stateProvenance: {
          reviewStatus: "proposed",
          evidenceBasis: "agent_report",
        },
      });
    }
    const resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
      depth: "compact",
      format: "structured",
      totalContextBudgetChars: 6000,
    });
    expect(JSON.stringify(resumed).length).toBeLessThanOrEqual(6000);
    expect(resumed.resumeText).toBeUndefined();
    expect(resumed.dossier.objective).toBeUndefined();
    expect(resumed.dossier).toMatchObject({
      state: "done",
      expectedProgressRecordId: progress.recordId,
      stateProvenance: {
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
      },
      nextAction: null,
    });
    const legacy = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
      depth: "compact",
    });
    expect(legacy.resumeText).toContain("None; task is closed.");
    expect(legacy.dossier.objectiveSemantics).toBe(
      "historical_original_not_current_instructions",
    );
  });

  it("keeps unresolved counts and recovery when a page is reduced", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Synthetic active work",
      objective: "Inspect results",
      ...identity(),
    });
    for (let n = 0; n < 8; n++)
      await call(app, "reserve_run", {
        projectId,
        taskId: task.taskId,
        operationKey: `synthetic-${n}`,
        inputHash: "a".repeat(64),
        device: "fixture",
        identity: "owner",
        criteria: ["Inspect synthetic artifact"],
        ...identity(),
      });
    const resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
      depth: "compact",
      format: "structured",
      totalContextBudgetChars: 6000,
      unresolvedLimit: 8,
    });
    expect(JSON.stringify(resumed).length).toBeLessThanOrEqual(6000);
    expect(resumed.dossier.unresolvedExecutionCount).toBe(8);
    const page = resumed.dossier.unresolvedExecutions;
    expect(page.total).toBe(8);
    expect(page.returned).toBeLessThan(8);
    expect(page.nextOffset).toBe(page.returned);
    expect(page.recovery.unresolvedOffset).toBe(page.nextOffset);
    expect(resumed.omitted).toContain("unresolvedExecutions.items");
    const next = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
      depth: "compact",
      format: "structured",
      totalContextBudgetChars: 6000,
      unresolvedOffset: page.nextOffset,
      unresolvedLimit: 2,
    });
    expect(next.dossier.unresolvedExecutions.items[0].id).not.toBe(
      page.items[0]?.id,
    );
  });

  it("preserves source omission markers when compact depth clips a current instruction", async () => {
    const { app, projectId } = await setup();
    const task = await call(app, "create_task", {
      projectId,
      title: "Synthetic long action",
      objective: "Inspect synthetic evidence",
      ...identity(),
    });
    const progress = await call(app, "report_task_progress", {
      projectId,
      taskId: task.taskId,
      taskRevision: task.task.revision,
      expectedProgressRecordId: null,
      status: "in_progress",
      summary: "Still inspecting",
      nextAction:
        "Inspect synthetic evidence. ".repeat(50) +
        "Do not execute before verification.",
      ownerAction: null,
      evidenceText: "Synthetic action requires further inspection.",
      ...identity(),
    });
    const resumed = await call(app, "resume_task", {
      projectId,
      taskId: task.taskId,
      depth: "compact",
      format: "structured",
      totalContextBudgetChars: 6000,
    });
    expect(resumed.truncated).toBe(true);
    expect(resumed.omitted).toContainEqual({
      field: "nextAction",
      recordId: progress.recordId,
      tool: "get_record",
      includeUnreviewed: true,
    });
    expect(JSON.stringify(resumed).length).toBeLessThanOrEqual(6000);
  });

  it("marks local checkpoint omissions and rejects missing result authority", () => {
    const compact = compactLatestCheckpoint({
      recordId: randomUUID(),
      checkpoint: {
        summary: "s".repeat(500),
        outcome: "o".repeat(500),
        nextAction: "n".repeat(500),
        blockers: ["b".repeat(300), "short", "third"],
      },
    });
    expect(compact?.checkpoint).toMatchObject({
      summaryTruncated: true,
      outcomeTruncated: true,
      nextActionTruncated: true,
      blockersOmitted: 1,
      blockersTruncated: true,
    });
    expect(
      (compact?.checkpoint as { summary: string }).summary.endsWith("…"),
    ).toBe(true);
    for (const schema of Object.values(workflowResults))
      expect(schema.safeParse({}).success).toBe(false);
  });
});
