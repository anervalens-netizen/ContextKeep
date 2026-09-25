import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectDto, WorkspaceReconciliationDto, WorkspaceScanResultDto } from "@contextkeep/shared";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function repo(root: string, name: string, remote: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "ignore" });
  writeFileSync(path.join(dir, "README.md"), "test\n");
  execFileSync("git", ["-C", dir, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "ignore" });
  return dir;
}

function codexSession(codexHome: string, id: string, cwd: string, archived: boolean): void {
  const dir = archived
    ? path.join(codexHome, "archived_sessions")
    : path.join(codexHome, "sessions", "2026", "09", "11");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-11T08-00-00-${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({ timestamp: "2026-09-11T08:00:00.000Z", ordinal: 0, type: "session_meta", payload: { session_id: id, id, timestamp: "2026-09-11T08:00:00.000Z", cwd } })}\n`,
  );
}

function dshSession(dshHome: string, id: string, cwd: string): void {
  const folder = `--${path.resolve(cwd).split(path.sep).filter(Boolean).join("-")}--`;
  const dir = path.join(dshHome, "sessions", folder, id);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify({ type: "session", id, createdAt: Date.now(), cwd })}\n`;
  writeFileSync(path.join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(body)));
}

function codexSummary(codexHome: string, name: string, cwd: string, updatedAt: string): void {
  const dir = path.join(codexHome, "memories", "rollout_summaries");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  writeFileSync(file, `cwd: ${cwd}\n\nSummary-only artifact.\n`);
  const stamp = new Date(updatedAt);
  utimesSync(file, stamp, stamp);
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("M3.5 workspace reconciliation", () => {
  it("surfaces metadata-only agent history, suggestion labels, and explicit terminal decisions", async () => {
    const root = temp("ck-reconcile-root-");
    const ownerRepo = repo(root, "owner-app", "https://github.com/anervalens-netizen/owner-app.git");
    repo(root, "third-party-tool", "https://github.com/block/third-party-tool.git");
    const codexHome = temp("ck-reconcile-codex-");
    const dshHome = temp("ck-reconcile-dsh-");

    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 3;
    t.app.ck.config.workspaceGithubOwner = "anervalens-netizen";
    t.app.ck.config.codexHome = codexHome;
    t.app.ck.config.dshHome = dshHome;

    const scanRes = await t.post("/api/workspaces/scan", {});
    expectStatus(scanRes, 200);
    const scan = scanRes.json<WorkspaceScanResultDto>();
    expect(scan.discoveredCount).toBe(2);

    codexSession(codexHome, "session-11111111-1111-4111-8111-111111111111", ownerRepo, false);
    codexSession(codexHome, "session-22222222-2222-4222-8222-222222222222", ownerRepo, true);
    dshSession(dshHome, "session-33333333-3333-4333-8333-333333333333", ownerRepo);

    const firstRes = await t.get("/api/workspaces/reconciliation");
    expectStatus(firstRes, 200);
    const first = firstRes.json<WorkspaceReconciliationDto>();
    expect(first.total).toBe(2);
    expect(first.unresolved).toBe(2);
    expect(first.tracked).toBe(0);
    expect(first.ignored).toBe(0);
    expect(first.seededProjectIds).toEqual([]);

    const owner = first.items.find((item) => item.workspace.displayName === "owner-app")!;
    const thirdParty = first.items.find((item) => item.workspace.displayName === "third-party-tool")!;
    expect(owner.suggestion.action).toBe("track");
    expect(owner.suggestion.confidence).toBe("high");
    expect(owner.history.codexCurrentCount).toBe(1);
    expect(owner.history.codexArchivedCount).toBe(1);
    expect(owner.history.dshSessionCount).toBe(1);
    expect(thirdParty.suggestion.action).toBe("ignore");
    expect(thirdParty.suggestion.confidence).toBe("medium");

    expectStatus(await t.post(`/api/workspaces/${owner.workspace.id}/action`, {
      action: "track",
      expectedUpdatedAt: owner.workspace.updatedAt,
    }), 200);
    expectStatus(await t.post(`/api/workspaces/${thirdParty.workspace.id}/action`, {
      action: "ignore",
      expectedUpdatedAt: thirdParty.workspace.updatedAt,
    }), 200);

    const secondRes = await t.get("/api/workspaces/reconciliation");
    expectStatus(secondRes, 200);
    const second = secondRes.json<WorkspaceReconciliationDto>();
    expect(second.unresolved).toBe(0);
    expect(second.tracked).toBe(1);
    expect(second.ignored).toBe(1);
    expect(second.items.find((item) => item.workspace.id === owner.workspace.id)?.status).toBe("tracked");
    expect(second.items.find((item) => item.workspace.id === thirdParty.workspace.id)?.status).toBe("ignored");
  });

  it("keeps session recency separate from newer Codex summary activity", async () => {
    const root = temp("ck-reconcile-session-recency-");
    const appRepo = repo(root, "session-app", "https://github.com/example/session-app.git");
    const codexHome = temp("ck-reconcile-session-recency-codex-");
    const dshHome = temp("ck-reconcile-session-recency-dsh-");
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 3;
    t.app.ck.config.codexHome = codexHome;
    t.app.ck.config.dshHome = dshHome;
    expectStatus(await t.post("/api/workspaces/scan", {}), 200);

    codexSession(codexHome, "session-44444444-4444-4444-8444-444444444444", appRepo, false);
    codexSummary(codexHome, "summary-newer", appRepo, "2026-09-12T09:30:00.000Z");

    const result = (await t.get("/api/workspaces/reconciliation")).json<WorkspaceReconciliationDto>();
    const item = result.items.find((candidate) => candidate.workspace.displayName === "session-app")!;
    expect(item.history.codexCurrentCount).toBe(1);
    expect(item.history.codexSummaryCount).toBe(1);
    expect(item.history.lastSessionActivity).toBe("2026-09-11T08:00:00.000Z");
    expect(item.history.lastAgentActivity).toBe("2026-09-12T09:30:00.000Z");
  });

  it("does not infer GitHub ownership when the optional owner identity is unset", async () => {
    const root = temp("ck-reconcile-unknown-owner-");
    repo(root, "unknown-github-repo", "https://github.com/example/unknown-github-repo.git");
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 3;
    t.app.ck.config.workspaceGithubOwner = null;
    // Keep the optional connector catalogs isolated from the developer's live
    // ExampleAssistant/Codex homes; this test only proves the owner-identity suggestion.
    t.app.ck.config.codexHome = temp("ck-reconcile-unknown-owner-codex-");
    t.app.ck.config.dshHome = temp("ck-reconcile-unknown-owner-dsh-");
    expectStatus(await t.post("/api/workspaces/scan", {}), 200);

    const result = await t.get("/api/workspaces/reconciliation");
    expectStatus(result, 200);
    const item = result.json<WorkspaceReconciliationDto>().items[0]!;
    expect(item.suggestion.action).toBe("review");
    expect(item.suggestion.confidence).toBe("low");
  });

  it("does not preselect an ambiguous exact project name or alias match", async () => {
    const root = temp("ck-reconcile-ambiguous-");
    repo(root, "Shared App", "https://github.com/example/shared-app.git");
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 3;
    // This case validates only ambiguous canonical project matching. Isolate
    // connector catalogs so the test never scans the developer's live homes.
    t.app.ck.config.codexHome = temp("ck-reconcile-ambiguous-codex-");
    t.app.ck.config.dshHome = temp("ck-reconcile-ambiguous-dsh-");
    const p1 = (await t.post("/api/projects", { name: "Shared App" })).json<ProjectDto>();
    const p2 = (await t.post("/api/projects", { name: "Other App" })).json<ProjectDto>();
    t.app.ck.handle.sqlite.prepare("UPDATE projects SET aliases_json=? WHERE id=?").run(JSON.stringify(["shared app"]), p2.id);
    expect(p1.id).not.toBe(p2.id);
    expectStatus(await t.post("/api/workspaces/scan", {}), 200);

    const result = (await t.get("/api/workspaces/reconciliation")).json<WorkspaceReconciliationDto>();
    const item = result.items[0]!;
    expect(item.suggestion.action).toBe("review");
    expect(item.suggestion.projectId).toBeNull();
    expect(item.suggestion.reason).toContain("Multiple canonical projects");
  });

  it("marks connector metadata incomplete when a catalog contains unreadable artifacts", async () => {
    const root = temp("ck-reconcile-unreadable-");
    repo(root, "app", "https://github.com/example/app.git");
    const codexHome = temp("ck-reconcile-unreadable-codex-");
    const badDir = path.join(codexHome, "sessions", "2026", "09", "11");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(path.join(badDir, "rollout-bad.jsonl"), "not-json\n");
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.codexHome = codexHome;
    expectStatus(await t.post("/api/workspaces/scan", {}), 200);

    const result = (await t.get("/api/workspaces/reconciliation")).json<WorkspaceReconciliationDto>();
    expect(result.codexCatalogAvailable).toBe(false);
  });

  it("marks demo-seeded canonical projects and keeps reconciliation owner-gated", async () => {
    const t = await makeTestApp({ seed: true });
    apps.push(t);
    const result = await t.get("/api/workspaces/reconciliation");
    expectStatus(result, 200);
    const body = result.json<WorkspaceReconciliationDto>();
    expect(body.seededProjectIds).toHaveLength(5);

    const anon = await t.raw("GET", "/api/workspaces/reconciliation");
    expectStatus(anon, 401);
  });
});
