import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSearchResultDto, SearchResultDto } from "@contextkeep/shared";
import { makeTestApp, type TestApp } from "./helpers.js";
import { auditEvents, records } from "../src/db/schema.js";
import { toRecordDto } from "../src/services/mappers.js";
import { taskSearchStates } from "../src/services/task-search-state.js";

const token = randomUUID();
const apps: TestApp[] = [];
const identity = () => ({
  clientId: "synthetic-search-state",
  sessionId: "synthetic-search-state",
  idempotencyKey: randomUUID(),
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.cleanup();
});

async function call(app: TestApp, name: string, args: Record<string, unknown>, error = false) {
  const response = await app.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: "Bearer " + token,
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

async function setup(title = "Synthetic checkout task") {
  const app = await makeTestApp({ mcpToken: token });
  apps.push(app);
  const project = await call(app, "create_project", {
    name: "Synthetic search state",
    ...identity(),
  });
  const created = await call(app, "create_task", {
    projectId: project.id,
    title,
    objective: title,
    ...identity(),
  });
  return { app, projectId: project.id as string, taskId: created.taskId as string };
}

async function report(
  app: TestApp,
  projectId: string,
  taskId: string,
  status: string,
  expectedProgressRecordId: string | null = null,
) {
  const task = await call(app, "get_task", { projectId, taskId });
  return call(app, "report_task_progress", {
    projectId,
    taskId,
    taskRevision: task.task.revision,
    expectedProgressRecordId,
    status,
    summary: "Synthetic " + status + " evidence",
    nextAction: null,
    ownerAction: null,
    evidenceText: "Synthetic state evidence inspected",
    ...identity(),
  });
}

function businessState(app: TestApp) {
  const tables = [
    "projects", "records", "sources", "source_excerpts", "record_evidence",
    "audit_events", "workflow_task_records", "workflow_runs", "workflow_events",
    "workflow_continuations", "workflow_subscriptions",
  ];
  return tables.map((table) => [
    table,
    app.app.ck.deps.sqlite.prepare("SELECT * FROM " + table + " ORDER BY rowid").all(),
  ]);
}

function addRecord(
  app: TestApp,
  projectId: string | null,
  overrides: Partial<typeof records.$inferInsert> = {},
) {
  const id = randomUUID();
  const at = "2030-01-01T00:00:00.000Z";
  app.app.ck.deps.db.insert(records).values({
    id, projectId, type: "fact", subject: "Synthetic classification",
    text: "Synthetic classification evidence", recordDedupHash: id,
    reviewStatus: "accepted", evidenceBasis: "agent_report",
    recordedAt: at, createdAt: at, updatedAt: at, ...overrides,
  }).run();
  return id;
}

describe("ME-05 effective task state in search", () => {
  it("projects reported closure in HTTP and MCP without changing accepted task records", async () => {
    const { app, projectId, taskId } = await setup();
    await call(app, "edit_record", {
      recordId: taskId, revision: 1, taskStatus: "blocked", ...identity(),
    });
    await call(app, "review_records", {
      items: [{ recordId: taskId, revision: 2 }],
      action: "accept", ownerAction: true, ...identity(),
    });
    const reported = await report(app, projectId, taskId, "done");
    const before = businessState(app);
    const resumed = await call(app, "resume_task", { projectId, taskId });
    expect(resumed.dossier).toMatchObject({
      state: "done", stateSource: "reported_progress",
    });
    const expected = {
      effectiveState: "done",
      stateSource: "reported_progress",
      progress: {
        recordId: reported.progress.recordId,
        recordedAt: reported.progress.recordedAt,
        taskRevision: reported.progress.taskRevision,
        status: "done", reviewStatus: "proposed", evidenceBasis: "agent_report",
      },
      stateProvenance: resumed.dossier.stateProvenance,
      resume: { tool: "resume_task", projectId, taskId },
    };
    const response = await app.get("/api/search?q=checkout&mode=canonical&projectId=" + projectId);
    expect(response.statusCode).toBe(200);
    const http = SearchResultDto.parse(response.json());
    const hit = http.records.find((record) => record.id === taskId);
    expect(hit).toMatchObject({
      taskStatus: "blocked", reviewStatus: "accepted", taskState: expected,
    });
    for (const scope of ["canonical", "all"]) {
      for (const compact of [false, true]) {
        const result = McpSearchResultDto.parse(await call(app, "search_context", {
          q: "checkout", projectId, scope, compact,
        }));
        expect(result.records.find((record) => record.recordId === taskId)).toMatchObject({
          taskStatus: "blocked", reviewStatus: "accepted", taskState: expected,
        });
        expect(result.workingRecords.some((record) => record.recordId === taskId)).toBe(false);
        if (compact) expect(result).not.toHaveProperty("canonicalRecords");
        else expect(result).toHaveProperty("canonicalRecords", result.records);
      }
    }
    expect(businessState(app)).toEqual(before);
  });

  it("keeps proposed task state in the working bucket in every search representation", async () => {
    const { app, projectId, taskId } = await setup("Synthetic working projection");
    const reported = await report(app, projectId, taskId, "done");
    for (const scope of ["canonical", "working", "all"]) {
      for (const compact of [false, true]) {
        const result = await call(app, "search_context", {
          q: "projection", projectId, scope, compact,
        });
        expect(result.records.some((record: { recordId: string }) => record.recordId === taskId)).toBe(false);
        const hit = result.workingRecords.find((record: { recordId: string }) => record.recordId === taskId);
        if (scope === "canonical") expect(hit).toBeUndefined();
        else expect(hit).toMatchObject({
          taskStatus: "open", reviewStatus: "proposed", provenance: "agent_report",
          taskState: {
            effectiveState: "done", stateSource: "reported_progress",
            progress: { recordId: reported.progress.recordId, reviewStatus: "proposed" },
            resume: { tool: "resume_task", projectId, taskId },
          },
        });
      }
    }
  });

  it("retains explicit terminal state and a resume pointer after new reports and post-closure follow-up", async () => {
    const { app, projectId, taskId } = await setup("Synthetic terminal projection");
    await call(app, "edit_record", {
      recordId: taskId, revision: 1, taskStatus: "done", ...identity(),
    });
    const reported = await report(app, projectId, taskId, "open");
    await call(app, "capture_work", {
      projectId, taskId, outcome: "Synthetic post-closure checkpoint",
      checkpoint: {
        summary: "Synthetic follow-up evidence",
        nextAction: "Inspect the synthetic follow-up",
        blockers: [],
      },
      ...identity(),
    });
    const resumed = await call(app, "resume_task", { projectId, taskId });
    expect(resumed.dossier).toMatchObject({
      state: "done", stateSource: "task_record", nextAction: null,
      followUp: { nextAction: "Inspect the synthetic follow-up" },
    });
    const result = await call(app, "search_context", {
      q: "projection", projectId, scope: "working", compact: true,
    });
    expect(result.workingRecords.find((record: { recordId: string }) => record.recordId === taskId)).toMatchObject({
      taskStatus: "done",
      taskState: {
        effectiveState: "done", stateSource: "task_record",
        progress: { recordId: reported.progress.recordId, status: "open" },
        stateProvenance: resumed.dossier.stateProvenance,
        resume: { tool: "resume_task", projectId, taskId },
      },
    });
  });

  it("uses audited status changes, but not text or review revisions, to supersede old progress", async () => {
    const { app, projectId, taskId } = await setup("Synthetic revision projection");
    const reported = await report(app, projectId, taskId, "done");
    await call(app, "edit_record", {
      recordId: taskId, revision: 1, text: "Synthetic revision projection clarified", ...identity(),
    });
    await call(app, "review_records", {
      items: [{ recordId: taskId, revision: 2 }],
      action: "accept", ownerAction: true, ...identity(),
    });
    const read = async () => {
      const result = await call(app, "search_context", { q: "projection", projectId, scope: "all" });
      return result.records.find((record: { recordId: string }) => record.recordId === taskId);
    };
    expect(await read()).toMatchObject({
      taskStatus: "open",
      taskState: {
        effectiveState: "done", stateSource: "reported_progress",
        progress: { recordId: reported.progress.recordId, taskRevision: 1 },
      },
    });
    await call(app, "edit_record", {
      recordId: taskId, revision: 3, taskStatus: "blocked", ...identity(),
    });
    const conflict = await call(app, "report_task_progress", {
      projectId, taskId, taskRevision: 1,
      expectedProgressRecordId: reported.progress.recordId,
      status: "done", summary: "Synthetic stale report",
      nextAction: null, ownerAction: null, evidenceText: "Synthetic stale evidence",
      ...identity(),
    }, true);
    expect(conflict.error.code).toBe("task_revision_conflict");
    const resumed = await call(app, "resume_task", { projectId, taskId });
    expect(resumed.dossier).toMatchObject({ state: "blocked", stateSource: "task_record" });
    expect(await read()).toMatchObject({
      taskStatus: "blocked",
      taskState: {
        effectiveState: "blocked", stateSource: "task_record",
        progress: { recordId: reported.progress.recordId, status: "done", taskRevision: 1 },
        stateProvenance: resumed.dossier.stateProvenance,
      },
    });
  });

  it.each(["reject", "delete"])("does not use a latest progress report after %s and handles missing progress explicitly", async (action) => {
    const { app, projectId, taskId } = await setup("Synthetic revoked projection");
    const first = await report(app, projectId, taskId, "blocked");
    const latest = await report(app, projectId, taskId, "done", first.progress.recordId);
    if (action === "reject") {
      await call(app, "review_records", {
        items: [{ recordId: latest.progress.recordId, revision: 1 }],
        action: "reject", ownerAction: true, ...identity(),
      });
    } else {
      await call(app, "delete_record", {
        recordId: latest.progress.recordId, revision: 1,
        reason: "Withdraw synthetic progress", ...identity(),
      });
    }
    const read = async () => {
      const result = await call(app, "search_context", {
        q: "projection", projectId, scope: "working", compact: true,
      });
      return result.workingRecords.find((record: { recordId: string }) => record.recordId === taskId);
    };
    const resumed = await call(app, "resume_task", { projectId, taskId });
    expect(resumed.dossier).toMatchObject({ state: "blocked", stateSource: "reported_progress" });
    expect(await read()).toMatchObject({
      taskStatus: "open",
      taskState: {
        effectiveState: "blocked", stateSource: "reported_progress",
        progress: { recordId: first.progress.recordId },
        stateProvenance: resumed.dossier.stateProvenance,
      },
    });
    await call(app, "delete_record", {
      recordId: first.progress.recordId, revision: 1,
      reason: "Withdraw remaining synthetic progress", ...identity(),
    });
    const withoutProgress = await call(app, "resume_task", { projectId, taskId });
    expect(await read()).toMatchObject({
      taskStatus: "open",
      taskState: {
        effectiveState: "open", stateSource: "task_record", progress: null,
        stateProvenance: withoutProgress.dossier.stateProvenance,
      },
    });
  });

  it("classifies only current actual tasks and preserves project scope and historical record identity", async () => {
    const { app, projectId, taskId } = await setup("Synthetic classification task");
    const ordinary = addRecord(app, projectId, { type: "action" });
    const evidence = addRecord(app, projectId, { type: "action" });
    const legacy = addRecord(app, projectId, { type: "action" });
    const fact = addRecord(app, projectId);
    const historical = addRecord(app, projectId, {
      type: "action", taskStatus: "blocked", reviewStatus: "superseded",
    });
    const rejected = addRecord(app, projectId, {
      type: "action", taskStatus: "blocked", reviewStatus: "rejected",
    });
    const orphan = addRecord(app, null, { type: "action", taskStatus: "open" });
    const link = app.app.ck.deps.sqlite.prepare(
      "INSERT INTO workflow_task_records(task_id,record_id) VALUES (?,?)",
    );
    link.run(taskId, evidence);
    link.run(legacy, fact);
    const other = await call(app, "create_project", {
      name: "Synthetic other search scope", ...identity(),
    });
    const otherTask = addRecord(app, other.id, { type: "action", taskStatus: "cancelled" });
    const response = await app.get("/api/search?q=classification&mode=canonical&scope=all&includeHistorical=true&limit=50");
    expect(response.statusCode).toBe(200);
    const result = SearchResultDto.parse(response.json());
    const all = [...result.records, ...result.workingRecords];
    for (const id of [ordinary, evidence, fact, historical, orphan]) {
      const hit = all.find((record) => record.id === id);
      expect(hit).toBeDefined();
      expect(hit).not.toHaveProperty("taskState");
    }
    expect(all.some((record) => record.id === rejected)).toBe(false);
    const legacyResume = await call(app, "resume_task", { projectId, taskId: legacy });
    expect(legacyResume.dossier).toMatchObject({ state: "unknown", stateSource: "unknown" });
    expect(all.find((record) => record.id === legacy)).toMatchObject({
      taskStatus: null,
      taskState: {
        effectiveState: "unknown", stateSource: "unknown", progress: null,
        stateProvenance: legacyResume.dossier.stateProvenance,
        resume: { tool: "resume_task", projectId, taskId: legacy },
      },
    });
    expect(all.find((record) => record.id === taskId)).toMatchObject({
      taskState: { effectiveState: "open", progress: null },
    });
    expect(all.find((record) => record.id === otherTask)).toMatchObject({
      taskState: {
        effectiveState: "cancelled",
        resume: { tool: "resume_task", projectId: other.id, taskId: otherTask },
      },
    });
    const scoped = await call(app, "search_context", {
      q: "classification", projectId, scope: "all", includeHistorical: true, limit: 15,
    });
    expect([...scoped.records, ...scoped.workingRecords].every(
      (record: { projectId: string }) => record.projectId === projectId,
    )).toBe(true);
  });

  it("bounds database round trips for many selected tasks with revised progress", async () => {
    const { app, projectId } = await setup();
    const deps = app.app.ck.deps;
    const ids = new Set<string>();
    for (let i = 0; i < 32; i++) {
      const taskId = addRecord(app, projectId, {
        type: "action", taskStatus: "open", revision: 3,
      });
      ids.add(taskId);
      const progressId = addRecord(app, projectId, {
        reviewStatus: "proposed",
        valueJson: JSON.stringify({
          kind: "task_progress", taskId, revision: 1, taskRevision: 1,
          status: "done", summary: "Synthetic prior closure",
          nextAction: null, ownerAction: null, previousRecordId: null,
        }),
      });
      deps.sqlite.prepare("INSERT INTO workflow_task_records(task_id,record_id) VALUES (?,?)").run(taskId, progressId);
      deps.db.insert(auditEvents).values({
        id: randomUUID(), actor: "owner", action: "record.edited",
        targetType: "record", targetId: taskId, timestamp: "2030-01-01T00:00:00.000Z",
        beforeRef: JSON.stringify({ revision: 2, taskStatus: "blocked" }),
        afterRef: JSON.stringify({ revision: 3, taskStatus: "open" }),
      }).run();
    }
    const selected = deps.db.select().from(records).all()
      .filter((record) => ids.has(record.id)).map((record) => toRecordDto(record));
    const prepare = vi.spyOn(deps.sqlite, "prepare");
    const one = taskSearchStates(deps, selected.slice(0, 1));
    expect(one.size).toBe(1);
    const singleCount = prepare.mock.calls.length;
    prepare.mockClear();
    const many = taskSearchStates(deps, selected);
    expect(many.size).toBe(32);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(singleCount);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(3);
    expect([...many.values()].every((state) =>
      state.effectiveState === "open" && state.stateSource === "task_record" &&
      state.progress?.status === "done",
    )).toBe(true);
  });
});
