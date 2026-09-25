import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodexImportResultDto,
  CodexSessionCatalogDto,
  ExtractionAdapter,
  CodexSummaryCatalogDto,
  ProjectDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const tempDirs: string[] = [];
const apps: TestApp[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function initRepo(dir: string, remote = "https://github.com/example/codex-project.git"): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
}

function sessionLines(id: string, cwd: string, visible = "VISIBLE RESULT"): string[] {
  return [
    JSON.stringify({
      timestamp: "2026-09-10T10:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        session_id: id,
        id,
        timestamp: "2026-09-10T10:00:00.000Z",
        cwd,
        source: "vscode",
        thread_source: "user",
        base_instructions: "HIDDEN SYSTEM INSTRUCTIONS MUST NEVER PERSIST",
      },
    }),
    JSON.stringify({
      timestamp: "2026-09-10T10:00:01.000Z",
      ordinal: 1,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context><cwd>/hidden/internal/path</cwd><approval_policy>never</approval_policy></environment_context>" },
          { type: "input_text", text: "Please inspect the project. OPENAI_API_KEY=sk-proj-SUPERSECRET0123456789" },
          { type: "output_text", text: "WRONG ROLE OUTPUT MUST NEVER PERSIST" },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-09-10T10:00:02.000Z",
      ordinal: 2,
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "BASE64-HIDDEN",
        summary: "HIDDEN REASONING MUST NEVER PERSIST",
      },
    }),
    JSON.stringify({
      timestamp: "2026-09-10T10:00:03.000Z",
      ordinal: 3,
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "RAW TOOL OUTPUT MUST NEVER PERSIST" },
    }),
    JSON.stringify({
      timestamp: "2026-09-10T10:00:04.000Z",
      ordinal: 4,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "PLAIN HIDDEN REASONING MUST NEVER PERSIST" },
          { type: "input_text", text: "WRONG ROLE INPUT MUST NEVER PERSIST" },
          { type: "output_text", text: visible },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-09-10T10:00:05.000Z",
      ordinal: 5,
      type: "compacted",
      payload: { message: "COMPACTION INTERNAL MUST NEVER PERSIST", replacement_history: "INTERNAL" },
    }),
  ];
}

function slowAdapter(gate: Promise<void>, onExtract: () => void): ExtractionAdapter {
  return {
    id: "slow-connector-test",
    version: "1.0.0",
    label: "Slow connector test",
    costCategory: "free",
    async estimateUsage() { return null; },
    async extract() {
      onExtract();
      await gate;
      return { candidates: [], usage: null };
    },
  };
}

function registryFor(adapter: ExtractionAdapter) {
  return {
    enabledIds: () => [adapter.id],
    get(id: string) {
      if (id !== adapter.id) throw new Error(`unexpected adapter ${id}`);
      return adapter;
    },
    list: () => [{ id: adapter.id, label: adapter.label, version: adapter.version, enabled: true }],
  };
}

function writeSession(
  codexHome: string,
  state: "current" | "archived",
  id: string,
  cwd: string,
  visible = "VISIBLE RESULT",
): string {
  const dir = state === "current"
    ? path.join(codexHome, "sessions", "2026", "09", "10")
    : path.join(codexHome, "archived_sessions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T10-00-00-${id}.jsonl`);
  writeFileSync(file, `${sessionLines(id, cwd, visible).join("\n")}\n`);
  return file;
}

async function configuredApp(): Promise<{
  t: TestApp;
  root: string;
  repo: string;
  codexHome: string;
  workspaceId: string;
  project: ProjectDto;
}> {
  const root = temp("ck-codex-workspace-");
  const repo = path.join(root, "project");
  initRepo(repo);
  const codexHome = temp("ck-codex-home-");
  const t = await makeTestApp();
  apps.push(t);
  t.app.ck.config.workspaceRoots = [root];
  t.app.ck.config.workspaceScanMaxDepth = 4;
  t.app.ck.config.codexHome = codexHome;

  const scanRes = await t.post("/api/workspaces/scan", {});
  expectStatus(scanRes, 200);
  const workspace = scanRes.json<WorkspaceScanResultDto>().workspaces[0]!;
  const projectRes = await t.post("/api/projects", { name: "Codex Project" });
  expectStatus(projectRes, 200);
  const project = projectRes.json<ProjectDto>();
  const linkRes = await t.post(`/api/workspaces/${workspace.id}/action`, {
    action: "link",
    projectId: project.id,
    expectedUpdatedAt: workspace.updatedAt,
  });
  expectStatus(linkRes, 200);
  return { t, root, repo, codexHome, workspaceId: workspace.id, project };
}

describe("M3.2 Codex connector", () => {
  it("catalogs current + archived sessions without importing or invoking a provider", async () => {
    const { t, repo, codexHome, workspaceId, project } = await configuredApp();
    writeSession(codexHome, "current", "session-11111111-1111-4111-8111-111111111111", repo);
    writeSession(codexHome, "archived", "session-22222222-2222-4222-8222-222222222222", repo);

    const anon = await t.raw("GET", "/api/connectors/codex/sessions");
    expectStatus(anon, 401);

    const res = await t.get("/api/connectors/codex/sessions?state=all&limit=20");
    expectStatus(res, 200);
    const body = res.json<CodexSessionCatalogDto>();
    expect(body.currentCount).toBe(1);
    expect(body.archivedCount).toBe(1);
    expect(body.unreadableCount).toBe(0);
    expect(body.sessions).toHaveLength(2);
    for (const session of body.sessions) {
      expect(session.cwd).toBe(repo);
      expect(session.workspaceBindingId).toBe(workspaceId);
      expect(session.projectId).toBe(project.id);
      expect(session.importedSnapshotCount).toBe(0);
      expect(session.relativePath).not.toContain("auth.json");
    }
    const jobs = t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number };
    const sources = t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number };
    expect(jobs.n).toBe(0);
    expect(sources.n).toBe(0);
  });

  it("derives catalog recency from embedded session timestamps rather than file mtime", async () => {
    const { t, repo, codexHome } = await configuredApp();
    writeSession(codexHome, "current", "session-19191919-1919-4191-8191-191919191919", repo);

    const res = await t.get("/api/connectors/codex/sessions?state=all&limit=20");
    expectStatus(res, 200);
    const session = res.json<CodexSessionCatalogDto>().sessions[0]!;
    expect(session.updatedAt).toBe("2026-09-10T10:00:05.000Z");
  });

  it("imports real Codex input_text/output_text safely and idempotently, excluding hidden/tool/context/wrong-role content", async () => {
    const { t, repo, codexHome, workspaceId, project } = await configuredApp();
    const sessionId = "session-33333333-3333-4333-8333-333333333333";
    writeSession(codexHome, "current", sessionId, repo);

    const first = await t.post("/api/connectors/codex/sessions/import", {
      sessionId,
      archiveState: "current",
      adapterId: "manual",
    });
    expectStatus(first, 200);
    const imported = first.json<CodexImportResultDto>();
    expect(imported.status).toBe("created");
    expect(imported.workspaceBindingId).toBe(workspaceId);
    expect(imported.projectId).toBe(project.id);
    expect(imported.safeItemCount).toBe(2);
    expect(imported.redactionCount).toBeGreaterThan(0);
    expect(imported.sourceId).not.toBeNull();

    const source = t.app.ck.handle.sqlite
      .prepare("SELECT original_text, provenance_basis, redaction_state, project_id, event_at FROM sources WHERE id=?")
      .get(imported.sourceId) as {
        original_text: string;
        provenance_basis: string;
        redaction_state: string;
        project_id: string | null;
        event_at: string | null;
      };
    expect(source.project_id).toBe(project.id);
    expect(source.provenance_basis).toBe("system");
    expect(source.redaction_state).toBe("automatic");
    expect(source.event_at).toBe("2026-09-10T10:00:04.000Z");
    expect(source.original_text).toContain("Please inspect the project.");
    expect(source.original_text).toContain("VISIBLE RESULT");
    expect(source.original_text).toContain("<REDACTED_CREDENTIAL>");
    expect(source.original_text).not.toContain("SUPERSECRET");
    expect(source.original_text).not.toContain("environment_context");
    expect(source.original_text).not.toContain("hidden/internal/path");
    expect(source.original_text).not.toContain("HIDDEN SYSTEM INSTRUCTIONS");
    expect(source.original_text).not.toContain("HIDDEN REASONING");
    expect(source.original_text).not.toContain("RAW TOOL OUTPUT");
    expect(source.original_text).not.toContain("COMPACTION INTERNAL");
    expect(source.original_text).not.toContain("WRONG ROLE OUTPUT");
    expect(source.original_text).not.toContain("WRONG ROLE INPUT");

    const origin = t.app.ck.handle.sqlite
      .prepare("SELECT connector, external_id, workspace_binding_id, archive_state FROM source_origins WHERE source_id=?")
      .get(imported.sourceId) as { connector: string; external_id: string; workspace_binding_id: string; archive_state: string };
    expect(origin).toEqual({ connector: "codex", external_id: sessionId, workspace_binding_id: workspaceId, archive_state: "current" });

    const sourceCountBefore = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    const second = await t.post("/api/connectors/codex/sessions/import", {
      sessionId,
      archiveState: "current",
      adapterId: "manual",
    });
    expectStatus(second, 200);
    expect(second.json<CodexImportResultDto>().status).toBe("unchanged");
    const sourceCountAfter = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    expect(sourceCountAfter).toBe(sourceCountBefore);
  });

  it("serializes concurrent connector imports through the durable initial-import claim", async () => {
    const { t, repo, codexHome } = await configuredApp();
    const sessionId = "session-35353535-3535-4353-8353-353535353535";
    writeSession(codexHome, "current", sessionId, repo);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    let extractCalls = 0;
    const adapter = slowAdapter(gate, () => {
      extractCalls += 1;
      entered();
    });
    t.app.ck.deps.registry = registryFor(adapter);

    const first = t.post("/api/connectors/codex/sessions/import", {
      sessionId,
      archiveState: "current",
      adapterId: adapter.id,
    });
    await providerEntered;

    const second = await t.post("/api/connectors/codex/sessions/import", {
      sessionId,
      archiveState: "current",
      adapterId: adapter.id,
    });
    expectStatus(second, 409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("import_in_progress");
    expect(extractCalls).toBe(1);

    release();
    expectStatus(await first, 200);
    expect(extractCalls).toBe(1);
  });

  it("falls back to session_meta when the final visible message timestamp is invalid", async () => {
    const { t, repo, codexHome } = await configuredApp();
    const sessionId = "session-34343434-3434-4343-8343-343434343434";
    const file = writeSession(codexHome, "archived", sessionId, repo);
    const lines = sessionLines(sessionId, repo);
    const finalVisible = JSON.parse(lines[4]!) as { timestamp: string };
    finalVisible.timestamp = "not-a-timestamp";
    lines[4] = JSON.stringify(finalVisible);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const importedRes = await t.post("/api/connectors/codex/sessions/import", {
      sessionId,
      archiveState: "archived",
      adapterId: "manual",
    });
    expectStatus(importedRes, 200);
    const imported = importedRes.json<CodexImportResultDto>();
    const source = t.app.ck.handle.sqlite.prepare("SELECT event_at FROM sources WHERE id=?").get(imported.sourceId) as { event_at: string };
    expect(source.event_at).toBe("2026-09-10T10:00:00.000Z");
  });

  it("preserves distinct Codex origins when exact sanitized content collapses to one source", async () => {
    const { t, repo, codexHome } = await configuredApp();
    const a = "session-44444444-4444-4444-8444-444444444444";
    const b = "session-55555555-5555-4555-8555-555555555555";
    writeSession(codexHome, "archived", a, repo, "SAME FINAL");
    writeSession(codexHome, "archived", b, repo, "SAME FINAL");

    const one = await t.post("/api/connectors/codex/sessions/import", { sessionId: a, archiveState: "archived", adapterId: "manual" });
    expectStatus(one, 200);
    const first = one.json<CodexImportResultDto>();
    expect(first.status).toBe("created");

    const two = await t.post("/api/connectors/codex/sessions/import", { sessionId: b, archiveState: "archived", adapterId: "manual" });
    expectStatus(two, 200);
    const second = two.json<CodexImportResultDto>();
    expect(second.status).toBe("duplicate_linked");
    expect(second.sourceId).toBe(first.sourceId);

    const origins = t.app.ck.handle.sqlite
      .prepare("SELECT external_id, source_id FROM source_origins WHERE connector='codex' ORDER BY external_id")
      .all() as { external_id: string; source_id: string }[];
    expect(origins).toHaveLength(2);
    expect(origins.map((row) => row.external_id)).toEqual([a, b]);
    expect(new Set(origins.map((row) => row.source_id)).size).toBe(1);
  });

  it("catalogs and imports only rollout_summaries Markdown, with exact cwd mapping and redaction", async () => {
    const { t, repo, codexHome, workspaceId, project } = await configuredApp();
    const root = path.join(codexHome, "memories", "rollout_summaries");
    mkdirSync(root, { recursive: true });
    const fileName = "2026-09-10-example-summary.md";
    writeFileSync(
      path.join(root, fileName),
      `cwd: ${repo}\n\nOutcome: the project is healthy.\nTOKEN=summary-secret-value\n`,
    );
    writeFileSync(path.join(codexHome, "memories", "raw_memories.md"), "RAW MEMORY MUST NOT BE CATALOGUED");

    const catalogRes = await t.get("/api/connectors/codex/summaries?limit=20");
    expectStatus(catalogRes, 200);
    const catalog = catalogRes.json<CodexSummaryCatalogDto>();
    expect(catalog.totalCount).toBe(1);
    expect(catalog.summaries[0]!.fileName).toBe(fileName);
    expect(catalog.summaries[0]!.workspaceBindingId).toBe(workspaceId);
    expect(catalog.summaries[0]!.projectId).toBe(project.id);

    const importRes = await t.post("/api/connectors/codex/summaries/import", { fileName, adapterId: "manual" });
    expectStatus(importRes, 200);
    const imported = importRes.json<CodexImportResultDto>();
    expect(imported.status).toBe("created");
    expect(imported.workspaceBindingId).toBe(workspaceId);
    expect(imported.projectId).toBe(project.id);
    expect(imported.redactionCount).toBeGreaterThan(0);

    const source = t.app.ck.handle.sqlite
      .prepare("SELECT original_text FROM sources WHERE id=?")
      .get(imported.sourceId) as { original_text: string };
    expect(source.original_text).toContain("Outcome: the project is healthy.");
    expect(source.original_text).not.toContain("summary-secret-value");
    expect(source.original_text).not.toContain("RAW MEMORY MUST NOT BE CATALOGUED");

    const again = await t.post("/api/connectors/codex/summaries/import", { fileName, adapterId: "manual" });
    expectStatus(again, 200);
    expect(again.json<CodexImportResultDto>().status).toBe("unchanged");
  });
});
