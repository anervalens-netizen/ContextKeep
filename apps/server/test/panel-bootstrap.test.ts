import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) await t.cleanup();
});
describe("bounded panel bootstrap", () => {
  it("returns matching initial task data, project pages and provenance without writing memory", async () => {
    const token = randomUUID(),
      t = await makeTestApp({ mcpToken: token });
    apps.push(t);
    async function call(
      name: string,
      args: Record<string, unknown> = {},
      error = false,
    ) {
      const r = await t.app.inject({
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
      expect(r.statusCode).toBe(200);
      const result = r.json().result;
      expect(result.isError === true, JSON.stringify(result)).toBe(error);
      return result.structuredContent;
    }
    const global = await call("open_task_panel");
    expect(global.startsExecution).toBe(false);
    expect(global.bootstrap.reads.map((r: { tool: string }) => r.tool)).toEqual(
      ["list_projects", "get_portfolio"],
    );
    const p = await call("create_project", {
      name: "Synthetic bootstrap",
      idempotencyKey: randomUUID(),
    });
    const task = await call("create_task", {
      projectId: p.id,
      title: "Synthetic task",
      objective: "Inspect the synthetic receipt",
      clientId: "test",
      sessionId: "bootstrap",
      idempotencyKey: randomUUID(),
    });
    const counts = () =>
      ["records", "audit_events", "idempotency_requests", "workflow_runs"].map(
        (table) =>
          t.app.ck.deps.sqlite
            .prepare("SELECT count(*) AS n FROM " + table)
            .get(),
      );
    const before = counts();
    await call("settings.update", {
      set: { taskVisibility: "all_actions", refreshInterval: "manual" },
    });

    const opened = await call("open_task_panel", {
      projectId: p.id,
      taskId: task.taskId,
      revision: 999,
    });
    expect(opened.revision).toBe(task.task.revision);
    expect(opened.bootstrap.version).toBe(1);
    expect(opened.bootstrap.preferences.taskVisibility).toBe("all_actions");
    expect(opened.bootstrap.preferences.refreshInterval).toBe("manual");
    expect(
      opened.bootstrap.reads.find(
        (r: { tool: string }) => r.tool === "list_tasks",
      ).arguments.selection,
    ).toBe("all_actions");
    expect(Date.now() - Date.parse(opened.bootstrap.observedAt)).toBeLessThan(
      10000,
    );
    expect(opened.bootstrap.selectedProject).toEqual({
      id: p.id,
      name: "Synthetic bootstrap",
    });
    expect(opened.bootstrap.reads).toHaveLength(4);
    for (const read of opened.bootstrap.reads) {
      expect(read.arguments.limit).toBeLessThanOrEqual(50);
      const fresh = await call(read.tool, read.arguments);
      expect(read.value).toEqual(fresh);
    }
    const project = await call("open_task_panel", { projectId: p.id });
    const projectRead = project.bootstrap.reads.find(
      (r: { tool: string }) => r.tool === "get_project_dossier",
    );
    expect(projectRead.arguments.view).toBe("recent");
    const freshProject = await call(projectRead.tool, projectRead.arguments);
    expect(Date.parse(freshProject.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(projectRead.value.observedAt),
    );
    expect({ ...projectRead.value, observedAt: null }).toEqual({
      ...freshProject,
      observedAt: null,
    });
    expect(counts()).toEqual(before);
    await call("open_task_panel", { taskId: task.taskId }, true);
    await call(
      "open_task_panel",
      { projectId: randomUUID(), taskId: task.taskId },
      true,
    );
  });
});
