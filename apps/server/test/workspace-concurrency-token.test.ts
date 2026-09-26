import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectDto,
  WorkspaceDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";
import * as clock from "../src/lib/time.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<{
  t: TestApp;
  workspace: WorkspaceDto;
  project: ProjectDto;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "ck-workspace-version-"));
  roots.push(root);
  const repo = path.join(root, "synthetic");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://example.com/synthetic/repo.git",
    ],
    { stdio: "ignore" },
  );
  const t = await makeTestApp();
  apps.push(t);
  t.app.ck.config.workspaceRoots = [root];
  const response = await t.post("/api/workspaces/scan", {});
  expect(response.statusCode).toBe(200);
  const workspace = response.json<WorkspaceScanResultDto>().workspaces[0]!;
  const created = await t.post("/api/projects", {
    name: "Synthetic canonical project",
  });
  expect(created.statusCode).toBe(200);
  return { t, workspace, project: created.json<ProjectDto>() };
}

describe("workspace concurrency tokens remain unique without clock progress", () => {
  it("rejects an old decision even when the newer link has the same wall-clock millisecond", async () => {
    const { t, workspace, project } = await fixture();
    vi.spyOn(clock, "nowIso").mockReturnValue(workspace.updatedAt);
    const linked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "link",
      projectId: project.id,
      expectedUpdatedAt: workspace.updatedAt,
    });
    expect(linked.statusCode).toBe(200);
    const stale = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "ignore",
      expectedUpdatedAt: workspace.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe(
      "workspace_stale_action",
    );
    const current = (await t.get("/api/workspaces")).json<WorkspaceDto[]>()[0]!;
    expect(current.projectId).toBe(project.id);
    expect(current.ignored).toBe(false);
    expect(current.updatedAt > workspace.updatedAt).toBe(true);
  });

  it("advances the expected token for every action after a backwards clock correction", async () => {
    const { t, workspace, project } = await fixture();
    vi.spyOn(clock, "nowIso").mockReturnValue("2020-01-01T00:00:00.000Z");
    let previous = workspace;
    for (const action of [
      { action: "link", projectId: project.id },
      { action: "unlink" },
      { action: "ignore" },
      { action: "unignore" },
      { action: "track", name: "Synthetic tracked project" },
    ]) {
      const result = await t.post(`/api/workspaces/${workspace.id}/action`, {
        ...action,
        expectedUpdatedAt: previous.updatedAt,
      });
      expect(result.statusCode).toBe(200);
      const next = result.json<WorkspaceDto>();
      expect(next.updatedAt > previous.updatedAt).toBe(true);
      previous = next;
    }
  });

  it("never restores a formerly valid action token during a same-clock rescan", async () => {
    const { t, workspace, project } = await fixture();
    const wallClock = vi
      .spyOn(clock, "nowIso")
      .mockReturnValue(
        new Date(Date.parse(workspace.updatedAt) + 1000).toISOString(),
      );
    const linked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "link",
      projectId: project.id,
      expectedUpdatedAt: workspace.updatedAt,
    });
    expect(linked.statusCode).toBe(200);
    const linkedDto = linked.json<WorkspaceDto>();
    wallClock.mockReturnValue(workspace.updatedAt);
    const scan = await t.post("/api/workspaces/scan", {});
    expect(scan.statusCode).toBe(200);
    const rescanned = scan.json<WorkspaceScanResultDto>().workspaces[0]!;
    const stale = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "ignore",
      expectedUpdatedAt: workspace.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(rescanned.updatedAt > linkedDto.updatedAt).toBe(true);
    expect(rescanned.projectId).toBe(project.id);
  });
});
