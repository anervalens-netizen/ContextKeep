import { validateMutationAcknowledgement } from "../../web/src/lib/mutation-ack.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DshImportResultDto,
  DshMemoryCatalogDto,
  ExtractionAdapter,
  DshSessionCatalogDto,
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

function initRepo(dir: string, remote = "https://github.com/example/dsh-project.git"): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
}

function encodeWorkspace(cwd: string): string {
  return `--${path.resolve(cwd).split(path.sep).filter(Boolean).join("-")}--`;
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

function writeDshSession(dshHome: string, sessionId: string, cwd: string): string {
  const dir = path.join(dshHome, "sessions", encodeWorkspace(cwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const frame1Lines = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, createdAt: 1789027200000, cwd, delegationDepth: 0, agentPreset: "code" }),
    JSON.stringify({
      type: "user/message",
      seq: 1,
      time: 1789027201000,
      data: {
        content: [
          { type: "text", text: "Please inspect this project. OPENAI_API_KEY=sk-proj-SUPERSECRET0123456789" },
          { type: "reasoning", text: "USER HIDDEN REASONING MUST NEVER PERSIST" },
        ],
        role: "user",
      },
    }),
  ];
  const frame2Lines = [
    JSON.stringify({ type: "reasoning-chunks", seq: 2, time: 1789027202000, data: { texts: ["HIDDEN REASONING TOKENS MUST NEVER PERSIST"] } }),
    JSON.stringify({ type: "tool/call", seq: 3, time: 1789027203000, data: { name: "shell", arguments: "RAW TOOL ARGUMENTS MUST NEVER PERSIST" } }),
    JSON.stringify({ type: "tool/result", seq: 4, time: 1789027204000, data: { output: "RAW TOOL OUTPUT MUST NEVER PERSIST" } }),
    JSON.stringify({ type: "request/header", seq: 5, time: 1789027205000, data: { header: { system: "SYSTEM PROMPT MUST NEVER PERSIST" } } }),
    JSON.stringify({
      type: "assistant/message",
      seq: 6,
      time: 1789027206000,
      data: {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "PLAIN ASSISTANT REASONING MUST NEVER PERSIST" },
            { type: "text", text: "VISIBLE ExampleAssistant RESULT" },
          ],
        },
      },
    }),
    JSON.stringify({ type: "compaction/prune", seq: 7, time: 1789027207000, data: { shadowedSeqs: [1, 2] } }),
  ];
  const a = zstdCompressSync(Buffer.from(`${frame1Lines.join("\n")}\n`));
  const b = zstdCompressSync(Buffer.from(`${frame2Lines.join("\n")}\n`));
  const file = path.join(dir, "session.jsonl.zstd");
  writeFileSync(file, Buffer.concat([a, b]));
  return file;
}

async function configuredApp(): Promise<{
  t: TestApp;
  root: string;
  repo: string;
  dshHome: string;
  workspaceId: string;
  project: ProjectDto;
}> {
  const root = temp("ck-dsh-workspace-");
  const repo = path.join(root, "project");
  initRepo(repo);
  const dshHome = temp("ck-dsh-home-");
  const t = await makeTestApp();
  apps.push(t);
  t.app.ck.config.workspaceRoots = [root];
  t.app.ck.config.workspaceScanMaxDepth = 4;
  t.app.ck.config.dshHome = dshHome;

  const scanRes = await t.post("/api/workspaces/scan", {});
  expectStatus(scanRes, 200);
  const workspace = scanRes.json<WorkspaceScanResultDto>().workspaces[0]!;
  const projectRes = await t.post("/api/projects", { name: "ExampleAssistant Project" });
  expectStatus(projectRes, 200);
  const project = projectRes.json<ProjectDto>();
  const linkRes = await t.post(`/api/workspaces/${workspace.id}/action`, {
    action: "link",
    projectId: project.id,
    expectedUpdatedAt: workspace.updatedAt,
  });
  expectStatus(linkRes, 200);
  return { t, root, repo, dshHome, workspaceId: workspace.id, project };
}

describe("M3.3 ExampleAssistant connector", () => {
  it("catalogs real-layout sessions without decompressing/importing/provider calls", async () => {
    const { t, repo, dshHome, workspaceId, project } = await configuredApp();
    writeDshSession(dshHome, "session-11111111-1111-4111-8111-111111111111", repo);

    const anon = await t.raw("GET", "/api/connectors/dsh/sessions");
    expectStatus(anon, 401);

    const res = await t.get("/api/connectors/dsh/sessions?limit=20");
    expectStatus(res, 200);
    const body = res.json<DshSessionCatalogDto>();
    expect(body.totalCount).toBe(1);
    expect(body.unreadableCount).toBe(0);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      workspaceBindingId: workspaceId,
      projectId: project.id,
      importedSnapshotCount: 0,
    });
    const jobs = t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number };
    const sources = t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number };
    expect(jobs.n).toBe(0);
    expect(sources.n).toBe(0);
  });

  it("derives catalog recency from embedded session timestamps rather than file mtime", async () => {
    const { t, repo, dshHome } = await configuredApp();
    writeDshSession(dshHome, "session-18181818-1818-4181-8181-181818181818", repo);

    const res = await t.get("/api/connectors/dsh/sessions?limit=20");
    expectStatus(res, 200);
    const session = res.json<DshSessionCatalogDto>().sessions[0]!;
    expect(session.updatedAt).toBe(new Date(1789027207000).toISOString());
  });

  it("returns a controlled connector error when the sessions root cannot be enumerated", async () => {
    const { t, dshHome } = await configuredApp();
    writeFileSync(path.join(dshHome, "sessions"), "not-a-directory");
    const res = await t.get("/api/connectors/dsh/sessions?limit=20");
    expectStatus(res, 409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("dsh_sessions_unreadable");
  });

  it("imports a multi-frame zstd session safely and idempotently", async () => {
    const { t, repo, dshHome, workspaceId, project } = await configuredApp();
    const sessionId = "session-22222222-2222-4222-8222-222222222222";
    writeDshSession(dshHome, sessionId, repo);

    const first = await t.post("/api/connectors/dsh/sessions/import", {
      sessionId,
      adapterId: "manual",
    });
    expectStatus(first, 200);
    const imported = first.json<DshImportResultDto>();
    expect(imported.status).toBe("created");
    expect(imported.workspaceBindingId).toBe(workspaceId);
    expect(imported.projectId).toBe(project.id);
    expect(imported.safeItemCount).toBe(2);
    expect(imported.redactionCount).toBeGreaterThan(0);

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
    expect(source.event_at).toBe(new Date(1789027206000).toISOString());
    expect(source.original_text).toContain("Please inspect this project.");
    expect(source.original_text).toContain("VISIBLE ExampleAssistant RESULT");
    expect(source.original_text).toContain("<REDACTED_CREDENTIAL>");
    expect(source.original_text).not.toContain("SUPERSECRET");
    expect(source.original_text).not.toContain("HIDDEN REASONING");
    expect(source.original_text).not.toContain("RAW TOOL");
    expect(source.original_text).not.toContain("SYSTEM PROMPT");
    expect(source.original_text).not.toContain("compaction");

    const origin = t.app.ck.handle.sqlite
      .prepare("SELECT connector, external_id, workspace_binding_id, archive_state FROM source_origins WHERE source_id=?")
      .get(imported.sourceId) as { connector: string; external_id: string; workspace_binding_id: string; archive_state: string };
    expect(origin).toEqual({ connector: "dsh", external_id: sessionId, workspace_binding_id: workspaceId, archive_state: "unknown" });

    const sourceCountBefore = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    const second = await t.post("/api/connectors/dsh/sessions/import", { sessionId, adapterId: "manual" });
    expectStatus(second, 200);
    expect(second.json<DshImportResultDto>().status).toBe("unchanged");
    const sourceCountAfter = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n;
    expect(sourceCountAfter).toBe(sourceCountBefore);
  });

  it("serializes concurrent connector imports through the durable initial-import claim", async () => {
    const { t, repo, dshHome } = await configuredApp();
    const sessionId = "session-24242424-2424-4242-8242-242424242424";
    writeDshSession(dshHome, sessionId, repo);

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

    const first = t.post("/api/connectors/dsh/sessions/import", {
      sessionId,
      adapterId: adapter.id,
    });
    await providerEntered;

    const second = await t.post("/api/connectors/dsh/sessions/import", {
      sessionId,
      adapterId: adapter.id,
    });
    expectStatus(second, 409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("import_in_progress");
    expect(extractCalls).toBe(1);

    release();
    expectStatus(await first, 200);
    expect(extractCalls).toBe(1);
  });

  it("keeps an encoded-workspace collision unlinked rather than guessing", async () => {
    const root = temp("ck-dsh-collision-");
    const a = path.join(root, "a-b", "c");
    const b = path.join(root, "a", "b-c");
    initRepo(a, "https://github.com/example/a.git");
    initRepo(b, "https://github.com/example/b.git");
    const dshHome = temp("ck-dsh-collision-home-");
    const t = await makeTestApp();
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 5;
    t.app.ck.config.dshHome = dshHome;
    const scan = await t.post("/api/workspaces/scan", {});
    expectStatus(scan, 200);
    expect(scan.json<WorkspaceScanResultDto>().workspaces).toHaveLength(2);

    const collisionFolder = encodeWorkspace(a);
    expect(collisionFolder).toBe(encodeWorkspace(b));
    const sessionId = "session-33333333-3333-4333-8333-333333333333";
    writeDshSession(dshHome, sessionId, a);

    const catalog = (await t.get("/api/connectors/dsh/sessions?limit=20")).json<DshSessionCatalogDto>();
    expect(catalog.sessions[0]!.workspaceBindingId).toBeNull();
    expect(catalog.sessions[0]!.projectId).toBeNull();
  });

  it("catalogs/imports only allowlisted ExampleAssistant memory markdown", async () => {
    const { t, dshHome } = await configuredApp();
    const memory = path.join(dshHome, "memory");
    mkdirSync(path.join(memory, "journal"), { recursive: true });
    writeFileSync(path.join(memory, "APPS.md"), "ContextKeep is healthy. TOKEN=memory-secret-value\n");
    writeFileSync(path.join(memory, "journal", "2026-09-11.md"), "Daily owner-visible note.\n");
    writeFileSync(path.join(memory, "PRIVATE-NOTES.md"), "MUST NOT BE CATALOGUED\n");
    writeFileSync(path.join(dshHome, ".credentials.yaml"), "MUST NEVER BE CATALOGUED\n");

    const catalogRes = await t.get("/api/connectors/dsh/memory?limit=20");
    expectStatus(catalogRes, 200);
    const catalog = catalogRes.json<DshMemoryCatalogDto>();
    expect(catalog.totalCount).toBe(2);
    expect(catalog.files.map((x) => x.relativePath).sort()).toEqual(["APPS.md", "journal/2026-09-11.md"]);

    const importRes = await t.post("/api/connectors/dsh/memory/import", {
      relativePath: "APPS.md",
      adapterId: "manual",
    });
    expectStatus(importRes, 200);
    const imported = importRes.json<DshImportResultDto>();
    expect(imported.status).toBe("created");
    expect(imported.redactionCount).toBeGreaterThan(0);
    expect(imported.workspaceBindingId).toBeNull();
    expect(imported.externalId).toBe("memory:APPS.md");
    expect(validateMutationAcknowledgement("/api/connectors/dsh/memory/import", "POST", { relativePath: "APPS.md" }, imported).valid).toBe(true);
    expect(validateMutationAcknowledgement("/api/connectors/dsh/memory/import", "POST", { relativePath: "APPS.md" }, { ...imported, externalId: "APPS.md" }).valid).toBe(false);

    const source = t.app.ck.handle.sqlite
      .prepare("SELECT original_text FROM sources WHERE id=?")
      .get(imported.sourceId) as { original_text: string };
    expect(source.original_text).toContain("ContextKeep is healthy.");
    expect(source.original_text).not.toContain("memory-secret-value");
    expect(source.original_text).not.toContain("MUST NEVER BE CATALOGUED");

    const forbidden = await t.post("/api/connectors/dsh/memory/import", {
      relativePath: "PRIVATE-NOTES.md",
      adapterId: "manual",
    });
    expectStatus(forbidden, 400);

    const again = await t.post("/api/connectors/dsh/memory/import", { relativePath: "APPS.md", adapterId: "manual" });
    expectStatus(again, 200);
    expect(again.json<DshImportResultDto>().status).toBe("unchanged");
  });

  it("rejects a symlinked ExampleAssistant memory root before catalog/import can read outside files", async () => {
    const { t, dshHome } = await configuredApp();
    const outside = temp("ck-dsh-memory-outside-");
    writeFileSync(path.join(outside, "README.md"), "OUTSIDE SECRET CONTENT\n");
    symlinkSync(outside, path.join(dshHome, "memory"), "dir");

    const catalog = await t.get("/api/connectors/dsh/memory?limit=20");
    expectStatus(catalog, 409);
    expect(catalog.json<{ error: { code: string } }>().error.code).toBe("dsh_memory_unsafe_root");

    const imported = await t.post("/api/connectors/dsh/memory/import", { relativePath: "README.md", adapterId: "manual" });
    expectStatus(imported, 409);
    expect(imported.json<{ error: { code: string } }>().error.code).toBe("dsh_memory_unsafe_root");
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(0);
  });
});
