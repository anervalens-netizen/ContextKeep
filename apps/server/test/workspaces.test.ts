import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_SCHEMA_VERSION, type ProjectDto, type WorkspaceDto, type WorkspaceScanResultDto } from "@contextkeep/shared";
import { makeTestApp, expectStatus, type TestApp } from "./helpers.js";
import { normalizeGitRemote } from "../src/services/workspaces.js";

const roots: string[] = [];
const apps: TestApp[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ck-workspaces-"));
  roots.push(root);
  return root;
}

function initRepo(dir: string, remote: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
}

async function appFor(root: string): Promise<TestApp> {
  const t = await makeTestApp();
  apps.push(t);
  t.app.ck.config.workspaceRoots = [root];
  t.app.ck.config.workspaceScanMaxDepth = 6;
  return t;
}

describe("M3.1 workspace registry", () => {
  it("normalizes equivalent GitHub remotes, strips credentials and preserves explicit ports", () => {
    expect(normalizeGitRemote("git@github.com:Owner/Repo.git")).toBe("github.com/owner/repo");
    expect(normalizeGitRemote("https://github.com/OWNER/REPO.git")).toBe("github.com/owner/repo");
    const sanitized = normalizeGitRemote("https://user:super-secret@example.com/Owner/Repo.git?token=also-secret#x");
    expect(sanitized).toBe("example.com/Owner/Repo");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("token");
    expect(normalizeGitRemote("ssh://git@git.example:2222/team/repo.git")).toBe("git.example:2222/team/repo");
    expect(normalizeGitRemote("ssh://git@git.example:2223/team/repo.git")).toBe("git.example:2223/team/repo");
  });

  it("requires explicit configured roots and stays owner-gated", async () => {
    const t = await makeTestApp();
    apps.push(t);
    const noRoots = await t.post("/api/workspaces/scan", {});
    expectStatus(noRoots, 409);
    expect(noRoots.json<{ error: { code: string } }>().error.code).toBe("workspace_roots_not_configured");
    const anon = await t.raw("GET", "/api/workspaces");
    expectStatus(anon, 401);
  });

  it("discovers Git roots, collapses equivalent remotes and rescans idempotently", async () => {
    const root = tempRoot();
    const primary = path.join(root, "unihub-retail");
    const duplicate = path.join(root, ".worktrees", "retail-feature");
    initRepo(primary, "https://github.com/anervalens-netizen/unihub-retail.git");
    initRepo(duplicate, "git@github.com:anervalens-netizen/unihub-retail.git");
    const t = await appFor(root);

    const first = await t.post("/api/workspaces/scan", {});
    expectStatus(first, 200);
    const firstBody = first.json<WorkspaceScanResultDto>();
    expect(firstBody.discoveredCount).toBe(1);
    expect(firstBody.insertedCount).toBe(1);
    expect(firstBody.updatedCount).toBe(0);
    expect(firstBody.workspaces).toHaveLength(1);
    expect(firstBody.workspaces[0]!.canonicalPath).toBe(primary);
    expect(firstBody.workspaces[0]!.gitRemote).toBe("github.com/anervalens-netizen/unihub-retail");
    expect(firstBody.workspaces[0]!.projectId).toBeNull();
    expect(firstBody.workspaces[0]!.ignored).toBe(false);
    const workspaceId = firstBody.workspaces[0]!.id;
    const firstSeen = firstBody.workspaces[0]!.firstSeenAt;

    const projects = await t.get("/api/projects");
    expectStatus(projects, 200);
    expect(projects.json<ProjectDto[]>()).toHaveLength(0);

    const second = await t.post("/api/workspaces/scan", {});
    expectStatus(second, 200);
    const secondBody = second.json<WorkspaceScanResultDto>();
    expect(secondBody.discoveredCount).toBe(1);
    expect(secondBody.insertedCount).toBe(0);
    expect(secondBody.updatedCount).toBe(1);
    expect(secondBody.workspaces[0]!.id).toBe(workspaceId);
    expect(secondBody.workspaces[0]!.firstSeenAt).toBe(firstSeen);

    const scanAudits = t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM audit_events WHERE action='workspace.scan_completed'")
      .get() as { n: number };
    expect(scanAudits.n).toBe(2);
  });

  it("links, ignores, unignores and unlinks without changing project lifecycle", async () => {
    const root = tempRoot();
    initRepo(path.join(root, "app"), "https://github.com/example/app.git");
    const t = await appFor(root);
    const scan = (await t.post("/api/workspaces/scan", {})).json<WorkspaceScanResultDto>();
    const workspace = scan.workspaces[0]!;

    const created = await t.post("/api/projects", { name: "Canonical App" });
    expectStatus(created, 200);
    const project = created.json<ProjectDto>();
    expect(project.lifecycle).toBe("unknown");

    const linked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "link",
      projectId: project.id,
      expectedUpdatedAt: workspace.updatedAt,
    });
    expectStatus(linked, 200);
    const linkedDto = linked.json<WorkspaceDto>();
    expect(linkedDto.projectId).toBe(project.id);

    const afterLinkProject = (await t.get(`/api/projects/${project.id}`)).json<ProjectDto>();
    expect(afterLinkProject.lifecycle).toBe("unknown");
    expect(afterLinkProject.lifecycleRecordId).toBeNull();

    const ignored = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "ignore",
      expectedUpdatedAt: linkedDto.updatedAt,
    });
    expectStatus(ignored, 200);
    const ignoredDto = ignored.json<WorkspaceDto>();
    expect(ignoredDto).toMatchObject({ ignored: true, projectId: null });

    const unignored = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "unignore",
      expectedUpdatedAt: ignoredDto.updatedAt,
    });
    expectStatus(unignored, 200);
    const unignoredDto = unignored.json<WorkspaceDto>();
    expect(unignoredDto.ignored).toBe(false);

    const relinked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "link",
      projectId: project.id,
      expectedUpdatedAt: unignoredDto.updatedAt,
    });
    expectStatus(relinked, 200);
    const relinkedDto = relinked.json<WorkspaceDto>();
    const unlinked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "unlink",
      expectedUpdatedAt: relinkedDto.updatedAt,
    });
    expectStatus(unlinked, 200);
    expect(unlinked.json<WorkspaceDto>().projectId).toBeNull();

    const actions = t.app.ck.handle.sqlite
      .prepare("SELECT action FROM audit_events WHERE action LIKE 'workspace.%' ORDER BY rowid")
      .all() as { action: string }[];
    expect(actions.map((r) => r.action)).toEqual([
      "workspace.scan_completed",
      "workspace.linked",
      "workspace.ignored",
      "workspace.unignored",
      "workspace.linked",
      "workspace.unlinked",
    ]);
  });

  it("rejects stale workspace actions instead of overwriting a newer binding decision", async () => {
    const root = tempRoot();
    initRepo(path.join(root, "app"), "https://github.com/example/stale-app.git");
    const t = await appFor(root);
    const workspace = (await t.post("/api/workspaces/scan", {})).json<WorkspaceScanResultDto>().workspaces[0]!;
    const project = (await t.post("/api/projects", { name: "Canonical" })).json<ProjectDto>();

    const linked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "link",
      projectId: project.id,
      expectedUpdatedAt: workspace.updatedAt,
    });
    expectStatus(linked, 200);

    const stale = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "ignore",
      expectedUpdatedAt: workspace.updatedAt,
    });
    expectStatus(stale, 409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe("workspace_stale_action");
    const current = (await t.get("/api/workspaces")).json<WorkspaceDto[]>()[0]!;
    expect(current.projectId).toBe(project.id);
    expect(current.ignored).toBe(false);
  });

  it("tracks a workspace as a new unknown-lifecycle project only on explicit owner action", async () => {
    const root = tempRoot();
    initRepo(path.join(root, "new-app"), "https://github.com/example/new-app.git");
    const t = await appFor(root);
    const scan = (await t.post("/api/workspaces/scan", {})).json<WorkspaceScanResultDto>();
    const workspace = scan.workspaces[0]!;

    const tracked = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "track",
      name: "New App",
      expectedUpdatedAt: workspace.updatedAt,
    });
    expectStatus(tracked, 200);
    const dto = tracked.json<WorkspaceDto>();
    expect(dto.projectId).not.toBeNull();
    expect(dto.projectName).toBe("New App");
    expect(dto.projectLifecycle).toBe("unknown");

    const projects = (await t.get("/api/projects")).json<ProjectDto[]>();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.lifecycle).toBe("unknown");
    expect(projects[0]!.lifecycleRecordId).toBeNull();
    const lifecycleRecords = t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM records WHERE project_id=? AND predicate='lifecycle'")
      .get(dto.projectId) as { n: number };
    expect(lifecycleRecords.n).toBe(0);
  });

  it("refuses Track when that exact project name already exists, requiring explicit Link", async () => {
    const root = tempRoot();
    initRepo(path.join(root, "same-name"), "https://github.com/example/same-name.git");
    const t = await appFor(root);
    await t.post("/api/projects", { name: "Same Name" });
    const scan = (await t.post("/api/workspaces/scan", {})).json<WorkspaceScanResultDto>();
    const workspace = scan.workspaces[0]!;
    const res = await t.post(`/api/workspaces/${workspace.id}/action`, {
      action: "track",
      name: "Same Name",
      expectedUpdatedAt: workspace.updatedAt,
    });
    expectStatus(res, 409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("workspace_project_name_exists");
    const listed = (await t.get("/api/workspaces")).json<WorkspaceDto[]>();
    expect(listed[0]!.projectId).toBeNull();
  });

  it("migration keeps workspace/source-origin tables present on the current schema", async () => {
    const t = await makeTestApp();
    apps.push(t);
    const names = t.app.ck.handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace_bindings','source_origins') ORDER BY name")
      .all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual(["source_origins", "workspace_bindings"]);
    const version = t.app.ck.handle.sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(version.v).toBe(APP_SCHEMA_VERSION);
  });
});
