import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexImportResultDto, ProjectDto, SearchResultDto, SourceDto, WorkspaceScanResultDto } from "@contextkeep/shared";
import { importCodexSession } from "../src/services/codex.js";
import { previewCodexSession } from "../src/services/sync-preview.js";
import { ApiError } from "../src/lib/errors.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(root: string, name: string, remote: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
  return dir;
}

function writeCodexSession(codexHome: string, id: string, cwd: string, text: string): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "11");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-11T09-00-00-${id}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: "2026-09-11T09:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: id, id, timestamp: "2026-09-11T09:00:00.000Z", cwd },
    }),
    JSON.stringify({
      timestamp: "2026-09-11T09:00:01.000Z",
      ordinal: 1,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }),
    JSON.stringify({
      timestamp: "2026-09-11T09:00:02.000Z",
      ordinal: 2,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Shared visible completion." }] },
    }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("Codex Connector review cleanup regressions", () => {
  it("does not accept a near-duplicate confirmation for an unrelated source", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    const unrelated = await t.post("/api/imports/text", {
      text: "An unrelated source about cooking recipes, garden soil, and bicycle repairs. ".repeat(8),
      adapterId: "manual",
    });
    expectStatus(unrelated, 201);
    const unrelatedId = unrelated.json<{ source: { id: string } }>().source.id;

    const base = "Deployment notes.\n\n" + "The release process requires exact-SHA promotion and Sigstore verification. ".repeat(6);
    const baseRes = await t.post("/api/imports/text", { text: base, adapterId: "manual" });
    expectStatus(baseRes, 201);
    const baseId = baseRes.json<{ source: { id: string } }>().source.id;

    const variant = `${base}\n\nAlso check the staging dashboard before Friday.`;
    const attempted = await t.post("/api/imports/text", {
      text: variant,
      adapterId: "manual",
      confirmNearDuplicateOf: unrelatedId,
    });
    expectStatus(attempted, 200);
    const body = attempted.json<{
      status: string;
      source: null;
      nearDuplicates: { sourceId: string }[];
    }>();
    expect(body.status).toBe("near_duplicate_pending");
    expect(body.source).toBeNull();
    expect(body.nearDuplicates.some((candidate) => candidate.sourceId === baseId)).toBe(true);
    expect(body.nearDuplicates.some((candidate) => candidate.sourceId === unrelatedId)).toBe(false);
    const audit = t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM audit_events WHERE action='source.near_duplicate_confirmed' AND target_id=?")
      .get(unrelatedId) as { n: number };
    expect(audit.n).toBe(0);
  });

  it("rejects snapshot drift before a Codex connector import writes anything", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    const codexHome = temp("ck-review-drift-");
    const sessionId = "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const file = writeCodexSession(codexHome, sessionId, "/tmp/non-project", "planned text");
    const relativePath = path.relative(codexHome, file);
    const preview = previewCodexSession(codexHome, { relativePath, sessionId, archiveState: "current" });
    writeCodexSession(codexHome, sessionId, "/tmp/non-project", "changed after planning");

    let caught: unknown = null;
    try {
      await importCodexSession(
        t.app.ck.deps,
        codexHome,
        { sessionId, archiveState: "current", adapterId: "manual", confirmNearDuplicateOf: null },
        { actor: "owner:test", requestId: "drift-test" },
        { expectedExternalPart: preview.externalPart },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("sync_preview_drift");
    const counts = t.app.ck.handle.sqlite.prepare(`
      SELECT
        (SELECT count(*) FROM sources) AS sources,
        (SELECT count(*) FROM source_origins) AS origins,
        (SELECT count(*) FROM import_jobs) AS jobs,
        (SELECT count(*) FROM records) AS records
    `).get() as { sources: number; origins: number; jobs: number; records: number };
    expect(counts).toEqual({ sources: 0, origins: 0, jobs: 0, records: 0 });
  });

  it("keeps one deduped source visible from every project proven by connector provenance", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    const root = temp("ck-review-source-projects-");
    const repoA = repo(root, "a", "https://github.com/example/project-a.git");
    const repoB = repo(root, "b", "https://github.com/example/project-b.git");
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 3;
    const scanRes = await t.post("/api/workspaces/scan", {});
    expectStatus(scanRes, 200);
    const workspaces = scanRes.json<WorkspaceScanResultDto>().workspaces;
    const workspaceA = workspaces.find((workspace) => workspace.canonicalPath === repoA)!;
    const workspaceB = workspaces.find((workspace) => workspace.canonicalPath === repoB)!;
    const projectA = (await t.post("/api/projects", { name: "Project A" })).json<ProjectDto>();
    const projectB = (await t.post("/api/projects", { name: "Project B" })).json<ProjectDto>();
    expectStatus(await t.post(`/api/workspaces/${workspaceA.id}/action`, {
      action: "link", projectId: projectA.id, expectedUpdatedAt: workspaceA.updatedAt,
    }), 200);
    expectStatus(await t.post(`/api/workspaces/${workspaceB.id}/action`, {
      action: "link", projectId: projectB.id, expectedUpdatedAt: workspaceB.updatedAt,
    }), 200);

    const codexHome = temp("ck-review-source-codex-");
    t.app.ck.config.codexHome = codexHome;
    const sessionA = "session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sessionB = "session-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    writeCodexSession(codexHome, sessionA, repoA, "Shared source visibility phrase.");
    writeCodexSession(codexHome, sessionB, repoB, "Shared source visibility phrase.");

    const first = await t.post("/api/connectors/codex/sessions/import", {
      sessionId: sessionA, archiveState: "current", adapterId: "manual",
    });
    expectStatus(first, 200);
    const firstBody = first.json<CodexImportResultDto>();
    expect(firstBody.status).toBe("created");
    const second = await t.post("/api/connectors/codex/sessions/import", {
      sessionId: sessionB, archiveState: "current", adapterId: "manual",
    });
    expectStatus(second, 200);
    const secondBody = second.json<CodexImportResultDto>();
    expect(secondBody.status).toBe("duplicate_linked");
    expect(secondBody.sourceId).toBe(firstBody.sourceId);

    const aSources = await t.get(`/api/sources?projectId=${projectA.id}`);
    const bSources = await t.get(`/api/sources?projectId=${projectB.id}`);
    expectStatus(aSources, 200);
    expectStatus(bSources, 200);
    expect(aSources.json<SourceDto[]>()).toHaveLength(1);
    expect(bSources.json<SourceDto[]>()).toHaveLength(1);

    const searchB = await t.get(`/api/search?q=${encodeURIComponent("visibility phrase")}&projectId=${projectB.id}`);
    expectStatus(searchB, 200);
    expect(searchB.json<SearchResultDto>().sources).toHaveLength(1);
  });
});
