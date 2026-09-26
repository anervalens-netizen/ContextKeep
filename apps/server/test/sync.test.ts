import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto, SyncRunResultDto, SyncStatusDto, WorkspaceScanResultDto } from "@contextkeep/shared";
import { SyncCoordinator, runSyncOnce } from "../src/services/sync.js";
import { ApiError } from "../src/lib/errors.js";
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

function initRepo(dir: string, remote = "https://github.com/example/sync-project.git"): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
}

function oldTime(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000);
}

function writeCodexSession(
  codexHome: string,
  sessionId: string,
  cwd: string,
  text: string,
  minutesAgo: number,
): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "11");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-11T05-00-00-${sessionId}.jsonl`);
  const embeddedBase = oldTime(minutesAgo).getTime();
  const embeddedAt = (offsetMs: number) => new Date(embeddedBase + offsetMs).toISOString();
  const lines = [
    JSON.stringify({
      timestamp: embeddedAt(0),
      ordinal: 0,
      type: "session_meta",
      payload: { session_id: sessionId, id: sessionId, timestamp: embeddedAt(0), cwd },
    }),
    JSON.stringify({
      timestamp: embeddedAt(1_000),
      ordinal: 1,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }),
    JSON.stringify({
      timestamp: embeddedAt(2_000),
      ordinal: 2,
      type: "response_item",
      payload: { type: "reasoning", encrypted_content: "HIDDEN" },
    }),
    JSON.stringify({
      timestamp: embeddedAt(3_000),
      ordinal: 3,
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Visible completion." }] },
    }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  const stamp = oldTime(minutesAgo);
  utimesSync(file, stamp, stamp);
  return file;
}

function moveCodexToArchive(codexHome: string, currentFile: string): string {
  const archived = path.join(codexHome, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  const target = path.join(archived, path.basename(currentFile));
  renameSync(currentFile, target);
  return target;
}

function encodeDshWorkspace(cwd: string): string {
  return `--${path.resolve(cwd).split(path.sep).filter(Boolean).join("-")}--`;
}

function writeDshSession(dshHome: string, sessionId: string, cwd: string, minutesAgo: number): string {
  return writeDshSessionWithIdentity(dshHome, sessionId, cwd, cwd, minutesAgo, "ExampleAssistant visible request");
}

function writeDshSessionWithIdentity(
  dshHome: string,
  sessionId: string,
  folderCwd: string,
  embeddedCwd: string,
  minutesAgo: number,
  userText: string,
): string {
  const dir = path.join(dshHome, "sessions", encodeDshWorkspace(folderCwd), sessionId);
  mkdirSync(dir, { recursive: true });
  const embeddedBase = oldTime(minutesAgo).getTime();
  const frame1 = zstdCompressSync(Buffer.from([
    JSON.stringify({ type: "session", id: sessionId, createdAt: embeddedBase, cwd: embeddedCwd }),
    JSON.stringify({ type: "user/message", seq: 1, time: embeddedBase + 30_000, data: { content: [{ type: "text", text: userText }] } }),
  ].join("\n") + "\n"));
  const frame2 = zstdCompressSync(Buffer.from([
    JSON.stringify({ type: "reasoning-chunks", seq: 2, time: embeddedBase + 40_000, data: { texts: ["HIDDEN"] } }),
    JSON.stringify({ type: "assistant/message", seq: 3, time: embeddedBase + 50_000, data: { message: { content: [{ type: "text", text: "ExampleAssistant visible result" }] } } }),
  ].join("\n") + "\n"));
  const file = path.join(dir, "session.jsonl.zstd");
  writeFileSync(file, Buffer.concat([frame1, frame2]));
  const stamp = oldTime(minutesAgo);
  utimesSync(file, stamp, stamp);
  return file;
}

async function linkedApp(): Promise<{ t: TestApp; repo: string; codexHome: string; dshHome: string; project: ProjectDto }> {
  const root = temp("ck-sync-root-");
  const repo = path.join(root, "project");
  initRepo(repo);
  const codexHome = temp("ck-sync-codex-");
  const dshHome = temp("ck-sync-dsh-");
  const t = await makeTestApp({ adapters: "manual,faketest,asynctest" });
  apps.push(t);
  t.app.ck.config.workspaceRoots = [root];
  t.app.ck.config.workspaceScanMaxDepth = 4;
  t.app.ck.config.codexHome = codexHome;
  t.app.ck.config.dshHome = dshHome;
  t.app.ck.config.syncIdleMinutes = 1;
  t.app.ck.config.syncMaxArtifacts = 25;
  t.app.ck.config.syncMaxChars = 1_000_000;
  t.app.ck.config.syncMaxCostUsd = 1;
  t.app.ck.config.syncExtractionAdapter = "faketest";

  const scan = await t.post("/api/workspaces/scan", {});
  expectStatus(scan, 200);
  const workspace = scan.json<WorkspaceScanResultDto>().workspaces[0]!;
  const projectRes = await t.post("/api/projects", { name: "Sync Project" });
  expectStatus(projectRes, 200);
  const project = projectRes.json<ProjectDto>();
  const link = await t.post(`/api/workspaces/${workspace.id}/action`, {
    action: "link",
    projectId: project.id,
    expectedUpdatedAt: workspace.updatedAt,
  });
  expectStatus(link, 200);
  return { t, repo, codexHome, dshHome, project };
}

function mutationCounts(t: TestApp) {
  return t.app.ck.handle.sqlite.prepare(`
    SELECT
      (SELECT count(*) FROM sources) AS sources,
      (SELECT count(*) FROM source_origins) AS origins,
      (SELECT count(*) FROM records) AS records,
      (SELECT count(*) FROM import_jobs) AS jobs,
      (SELECT count(*) FROM source_extractions) AS extractions,
      (SELECT count(*) FROM connector_sync_state) AS sync_state,
      (SELECT count(*) FROM audit_events) AS audit
  `).get() as Record<string, number>;
}

describe("M3.4 bounded sync", () => {
  it("accounts usage from a failed paid provider response before continuing the run", async () => {
    const { t, repo, codexHome } = await linkedApp();
    writeCodexSession(codexHome, "session-56565656-5656-4565-8565-565656565656", repo, "New artifact: paid provider failure with billable usage.", 5);
    writeCodexSession(codexHome, "session-57575757-5757-4575-8575-575757575757", repo, "Older artifact: second extraction must be deferred after the failed call.", 60);
    let calls = 0;
    const usage = (cost: number) => ({ inputTokens: 100, outputTokens: 100, estCostUsd: cost, model: "mock" });
    const fake = {
      id: "mock",
      version: "1",
      costCategory: "paid",
      estimateUsage: async () => usage(0.04),
      extract: async () => {
        calls += 1;
        throw new ApiError(409, "provider_output_truncated", "Billed provider response truncated", { usage: usage(0.08) });
      },
    } as any;
    const original = t.app.ck.deps.registry;
    const deps = { ...t.app.ck.deps, registry: { ...original, get: (id: string) => id === "mock" ? fake : original.get(id) } } as any;

    const result = await runSyncOnce(deps, t.app.ck.config, {
      connector: "codex", dryRun: false, mode: "archiveAndExtract", extractionAdapterId: "mock",
      idleMinutes: 1, maxArtifacts: 5, maxChars: 1_000_000, maxCostUsd: 0.08,
    }, { actor: "fixture" });

    expect(result.plan.plannedExtract).toBe(2);
    expect(calls).toBe(1);
    expect(result.accountedProviderCostUsd).toBeCloseTo(0.08, 6);
    expect(result.providerBudgetExhausted).toBe(true);
    expect(result.counts.failed).toBe(1);
    expect(result.counts.deferredBudget).toBeGreaterThanOrEqual(1);
  });

  it("dry-run plans Codex + ExampleAssistant without any persistent mutation or provider extraction", async () => {
    const { t, repo, codexHome, dshHome } = await linkedApp();
    writeCodexSession(codexHome, "session-11111111-1111-4111-8111-111111111111", repo, "Codex visible request", 60);
    writeDshSession(dshHome, "session-22222222-2222-4222-8222-222222222222", repo, 60);

    const before = mutationCounts(t);
    const res = await t.post("/api/sync/run", {
      connector: "both",
      dryRun: true,
      mode: "archiveOnly",
      idleMinutes: 1,
      maxArtifacts: 10,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.dryRun).toBe(true);
    expect(result.plan.discovered).toBe(2);
    expect(result.plan.eligible).toBe(2);
    expect(result.plan.plannedArchive).toBe(2);
    expect(result.plan.selected).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mutationCounts(t)).toEqual(before);
  });


  it("rejects a ExampleAssistant folder/cwd project mismatch before archive or extraction", async () => {
    const { t, repo, dshHome, project } = await linkedApp();
    const otherRepo = path.join(path.dirname(repo), "other-dsh-project");
    initRepo(otherRepo, "https://github.com/example/other-dsh-project.git");

    const otherProjectRes = await t.post("/api/projects", { name: "Other ExampleAssistant Project" });
    expectStatus(otherProjectRes, 200);
    const otherProject = otherProjectRes.json<ProjectDto>();

    const rescan = await t.post("/api/workspaces/scan", {});
    expectStatus(rescan, 200);
    const otherWorkspace = rescan
      .json<WorkspaceScanResultDto>()
      .workspaces.find((workspace) => workspace.canonicalPath === otherRepo);
    expect(otherWorkspace).toBeTruthy();

    const linkOther = await t.post(`/api/workspaces/${otherWorkspace!.id}/action`, {
      action: "link",
      projectId: otherProject.id,
      expectedUpdatedAt: otherWorkspace!.updatedAt,
    });
    expectStatus(linkOther, 200);

    const sessionId = "session-34343434-3434-4434-8434-343434343434";
    writeDshSessionWithIdentity(
      dshHome,
      sessionId,
      repo,
      otherRepo,
      60,
      "fact: ExampleAssistant scope mismatch must never cross project evidence boundaries.",
    );

    const res = await t.post("/api/sync/run", {
      projectId: project.id,
      connector: "dsh",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.counts.failed).toBe(1);
    expect(result.counts.archivedCreated).toBe(0);
    expect(result.counts.extractedCreated).toBe(0);
    expect(result.errors.some((error) => error.code === "sync_workspace_mismatch")).toBe(true);

    const sqlite = t.app.ck.handle.sqlite;
    expect((sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare("SELECT count(*) AS n FROM source_extractions").get() as { n: number }).n).toBe(0);
  });

  it("does not let a newest over-budget artifact starve an older executable artifact", async () => {
    const { t, repo, codexHome } = await linkedApp();
    const tooLarge = "session-23232323-2323-4232-8232-232323232323";
    const small = "session-24242424-2424-4242-8242-242424242424";
    writeCodexSession(codexHome, tooLarge, repo, "X".repeat(2000), 5);
    writeCodexSession(codexHome, small, repo, "small eligible request", 60);

    const res = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 200, maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.plan.deferredByCharBudget).toBeGreaterThanOrEqual(1);
    expect(result.plan.selected).toBe(1);
    expect(result.counts.archivedCreated).toBe(1);
    const origin = t.app.ck.handle.sqlite.prepare("SELECT external_id FROM source_origins").get() as { external_id: string };
    expect(origin.external_id).toBe(small);
  });

  it("bounds archive work without starvation and treats a changed external session as a new snapshot", async () => {
    const { t, repo, codexHome } = await linkedApp();
    const a = "session-33333333-3333-4333-8333-333333333333";
    const b = "session-44444444-4444-4444-8444-444444444444";
    const aFile = writeCodexSession(codexHome, a, repo, "first snapshot alpha", 120);
    writeCodexSession(codexHome, b, repo, "second session beta", 180);

    const one = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(one, 200);
    expect(one.json<SyncRunResultDto>().counts.archivedCreated).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_origins").get() as { n: number }).n).toBe(1);

    const two = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(two, 200);
    expect(two.json<SyncRunResultDto>().counts.archivedCreated).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_origins").get() as { n: number }).n).toBe(2);

    writeCodexSession(codexHome, a, repo, "first snapshot alpha with a material update", 5);
    const later = oldTime(5);
    utimesSync(aFile, later, later);
    const three = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(three, 200);
    const third = three.json<SyncRunResultDto>();
    expect(third.counts.failed).toBe(0);
    expect(third.counts.archivedCreated).toBe(1);
    const origins = t.app.ck.handle.sqlite.prepare("SELECT external_id, count(*) AS n FROM source_origins GROUP BY external_id").all() as { external_id: string; n: number }[];
    expect(origins.find((row) => row.external_id === a)?.n).toBe(2);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(0);
  });


  it("detects content changes even when connector mtime is preserved", async () => {
    const { t, repo, codexHome } = await linkedApp();
    const id = "session-35353535-3535-4535-8535-353535353535";
    const file = writeCodexSession(codexHome, id, repo, "original preserved-mtime content", 60);
    const preserved = statSync(file).mtime;

    const first = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(first, 200);
    expect(first.json<SyncRunResultDto>().counts.archivedCreated).toBe(1);

    writeCodexSession(codexHome, id, repo, "replacement content with identical mtime", 60);
    utimesSync(file, preserved, preserved);

    const second = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(second, 200);
    const result = second.json<SyncRunResultDto>();
    expect(result.plan.unchanged).toBe(0);
    expect(result.counts.archivedCreated).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_origins WHERE external_id=?").get(id) as { n: number }).n).toBe(2);
    const latestText = t.app.ck.handle.sqlite
      .prepare(`SELECT s.original_text AS text
                FROM source_origins so JOIN sources s ON s.id=so.source_id
                WHERE so.external_id=? ORDER BY so.created_at DESC LIMIT 1`)
      .get(id) as { text: string };
    expect(latestText.text).toContain("replacement content with identical mtime");
  });

  it("refreshes archive_state when a current Codex session is archived without an mtime change", async () => {
    const { t, repo, codexHome } = await linkedApp();
    const id = "session-45454545-4545-4454-8454-454545454545";
    const current = writeCodexSession(codexHome, id, repo, "archive transition", 60);
    const first = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(first, 200);
    expect((t.app.ck.handle.sqlite.prepare("SELECT archive_state FROM source_origins WHERE external_id=?").get(id) as { archive_state: string }).archive_state).toBe("current");

    moveCodexToArchive(codexHome, current);
    const second = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(second, 200);
    const result = second.json<SyncRunResultDto>();
    expect(result.plan.selected).toBe(1);
    expect(result.counts.archivedUnchanged).toBe(1);
    const rows = t.app.ck.handle.sqlite.prepare("SELECT archive_state FROM source_origins WHERE external_id=?").all(id) as { archive_state: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.archive_state).toBe("archived");
  });

  it("always reports executable work even after the diagnostic plan cap is filled", async () => {
    const { t, repo, codexHome } = await linkedApp();
    const unlinkedCwd = path.join(temp("ck-sync-unlinked-cwd-"), "missing-project");
    for (let i = 0; i < 301; i += 1) {
      const token = String(i).padStart(8, "0");
      writeCodexSession(codexHome, `session-${token}-0000-4000-8000-000000000000`, unlinkedCwd, `unlinked ${i}`, 5);
    }
    const linkedId = "session-99999999-9999-4999-8999-999999999999";
    writeCodexSession(codexHome, linkedId, repo, "linked executable after diagnostics", 60);

    const res = await t.post("/api/sync/run", {
      connector: "codex", dryRun: true, mode: "archiveOnly", idleMinutes: 1,
      maxArtifacts: 1, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.plan.unlinked).toBe(301);
    expect(result.plan.selected).toBe(1);
    expect(result.plan.items.some((item) => item.externalId === linkedId && item.action === "archive")).toBe(true);
  });

  it("archives when aggregate extraction budget is exhausted, then resumes by extracting the existing source", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    const id = "session-55555555-5555-4555-8555-555555555555";
    writeCodexSession(
      codexHome,
      id,
      repo,
      "usage-estimate: input=100 output=10 cost=0.04 model=fake-test-v1\nfact: Bounded sync can resume extraction.",
      60,
    );

    const firstRes = await t.post("/api/sync/run", {
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 0.01,
    });
    expectStatus(firstRes, 200);
    const first = firstRes.json<SyncRunResultDto>();
    expect(first.plan.deferredByCostBudget).toBe(1);
    expect(first.counts.archivedCreated).toBe(1);
    expect(first.counts.extractedCreated).toBe(0);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(0);

    const secondRes = await t.post("/api/sync/run", {
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 0.1,
    });
    expectStatus(secondRes, 200);
    const second = secondRes.json<SyncRunResultDto>();
    expect(second.plan.plannedArchive).toBe(0);
    expect(second.plan.plannedExtract).toBe(1);
    expect(second.counts.extractedCreated).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(1);
    const record = t.app.ck.handle.sqlite.prepare("SELECT project_id, review_status, text FROM records").get() as { project_id: string; review_status: string; text: string };
    expect(record.project_id).toBe(project.id);
    expect(record.review_status).toBe("proposed");
    expect(record.text).toBe("Bounded sync can resume extraction.");

    const before = mutationCounts(t);
    const thirdRes = await t.post("/api/sync/run", {
      connector: "codex", dryRun: false, mode: "archiveAndExtract", extractionAdapterId: "faketest",
      idleMinutes: 1, maxArtifacts: 5, maxChars: 1_000_000, maxCostUsd: 0.1,
    });
    expectStatus(thirdRes, 200);
    const third = thirdRes.json<SyncRunResultDto>();
    expect(third.plan.unchanged).toBeGreaterThanOrEqual(1);
    expect(third.plan.selected).toBe(0);
    const after = mutationCounts(t);
    expect(after.sources).toBe(before.sources);
    expect(after.origins).toBe(before.origins);
    expect(after.records).toBe(before.records);
    expect(after.jobs).toBe(before.jobs);
    expect(after.extractions).toBe(before.extractions);
  });


  it("stops remaining provider extraction after actual/reserved run cost consumes the budget", async () => {
    const { t, repo, codexHome } = await linkedApp();
    writeCodexSession(
      codexHome,
      "session-56565656-5656-4565-8565-565656565656",
      repo,
      [
        "async-usage-estimate: input=100 output=10 cost=0.04 model=asynctest-model-v1",
        "async-actual-usage: input=200 output=20 cost=0.08 model=asynctest-model-v1",
        "async-fact: newest artifact consumes the full sync provider budget",
      ].join("\n"),
      5,
    );
    writeCodexSession(
      codexHome,
      "session-57575757-5757-4575-8575-575757575757",
      repo,
      [
        "async-usage-estimate: input=100 output=10 cost=0.04 model=asynctest-model-v1",
        "async-actual-usage: input=100 output=10 cost=0.04 model=asynctest-model-v1",
        "async-fact: older artifact must be archived but extraction deferred",
      ].join("\n"),
      60,
    );

    const res = await t.post("/api/sync/run", {
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "asynctest",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 0.08,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.plan.plannedExtract).toBe(2);
    expect(result.counts.archivedCreated).toBe(2);
    expect(result.counts.extractedCreated).toBe(1);
    expect(result.counts.deferredBudget).toBeGreaterThanOrEqual(1);
    expect(result.accountedProviderCostUsd).toBeCloseTo(0.08, 6);
    expect(result.providerBudgetExhausted).toBe(true);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_extractions").get() as { n: number }).n).toBe(1);
  });

  it("can explicitly archive unassigned material but never auto-extract it", async () => {
    const root = temp("ck-sync-unassigned-");
    const repo = path.join(root, "project");
    initRepo(repo);
    const codexHome = temp("ck-sync-unassigned-codex-");
    const dshHome = temp("ck-sync-unassigned-dsh-");
    const t = await makeTestApp({ adapters: "manual,faketest" });
    apps.push(t);
    t.app.ck.config.workspaceRoots = [root];
    t.app.ck.config.workspaceScanMaxDepth = 4;
    t.app.ck.config.codexHome = codexHome;
    t.app.ck.config.dshHome = dshHome;
    const scan = await t.post("/api/workspaces/scan", {});
    expectStatus(scan, 200);
    expect(scan.json<WorkspaceScanResultDto>().workspaces).toHaveLength(1);
    writeCodexSession(
      codexHome,
      "session-66666666-6666-4666-8666-666666666666",
      repo,
      "usage-estimate: input=100 output=10 cost=0.01 model=fake-test-v1\nfact: This must not auto-extract while unlinked.",
      60,
    );

    const res = await t.post("/api/sync/run", {
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      allowUnassignedArchive: true,
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.plan.plannedArchive).toBe(1);
    expect(result.plan.plannedExtract).toBe(0);
    expect(result.counts.archivedCreated).toBe(1);
    expect(result.counts.extractedCreated).toBe(0);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n).toBe(1);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n).toBe(0);
    expect((t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_extractions").get() as { n: number }).n).toBe(0);
  });

  it("keeps sync owner-gated and the built-in timer disabled by default", async () => {
    const { t } = await linkedApp();
    const anon = await t.raw("POST", "/api/sync/run", { connector: "both", dryRun: true, mode: "archiveOnly" });
    expectStatus(anon, 401);
    const statusRes = await t.get("/api/sync/status");
    expectStatus(statusRes, 200);
    const status = statusRes.json<SyncStatusDto>();
    expect(status.intervalEnabled).toBe(false);
    expect(status.intervalMinutes).toBe(0);
    expect(status.scheduledMode).toBe("archiveOnly");
  });

  // ------------------------------------------------- history backfill recovery
  it("(M-history) SyncPlanDto.projectId is the exact project scope, never another project's artifacts", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    const otherRepo = path.join(path.dirname(repo), "other-project");
    // A distinct git remote, otherwise the scan resolves both repos to the
    // same canonical workspace and the second project never exists.
    initRepo(otherRepo, "https://github.com/example/other-project.git");
    const otherProjectRes = await t.post("/api/projects", { name: "Other Project" });
    expectStatus(otherProjectRes, 200);
    const otherProject = otherProjectRes.json<ProjectDto>();
    const rescan = await t.post("/api/workspaces/scan", {});
    expectStatus(rescan, 200);
    const otherWorkspace = rescan
      .json<WorkspaceScanResultDto>()
      .workspaces.find((w) => w.canonicalPath === otherRepo);
    expect(otherWorkspace).toBeTruthy();
    const linkOther = await t.post(`/api/workspaces/${otherWorkspace!.id}/action`, {
      action: "link",
      projectId: otherProject.id,
      expectedUpdatedAt: otherWorkspace!.updatedAt,
    });
    expectStatus(linkOther, 200);

    writeCodexSession(codexHome, "session-77777777-7777-4777-8777-777777777777", repo, "scoped artifact", 60);
    writeCodexSession(codexHome, "session-88888888-8888-4888-8888-888888888888", otherRepo, "other project artifact", 60);

    const scopedRes = await t.post("/api/sync/run", {
      projectId: project.id, connector: "codex", dryRun: true, mode: "archiveOnly",
      idleMinutes: 1, maxArtifacts: 10, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(scopedRes, 200);
    const scoped = scopedRes.json<SyncRunResultDto>();
    expect(scoped.plan.projectId).toBe(project.id);
    expect(scoped.plan.eligible).toBe(1);
    expect(scoped.plan.selected).toBe(1);
    expect(scoped.plan.items.length).toBeGreaterThan(0);
    for (const item of scoped.plan.items) expect(item.projectId).toBe(project.id);

    // An unscoped run reports null, so the UI can never mistake a global or
    // timer-driven run for a project batch.
    const globalRes = await t.post("/api/sync/run", {
      connector: "codex", dryRun: true, mode: "archiveOnly",
      idleMinutes: 1, maxArtifacts: 10, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(globalRes, 200);
    const global = globalRes.json<SyncRunResultDto>();
    expect(global.plan.projectId).toBeNull();
    expect(global.plan.selected).toBe(2);
  });

  it("(M-history) /api/sync/status exposes the finished project-scoped run for recovery", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(codexHome, "session-99999999-1111-4111-8111-999999999999", repo, "recoverable artifact", 60);

    const before = await t.get("/api/sync/status");
    expectStatus(before, 200);
    expect(before.json<SyncStatusDto>().running).toBe(false);
    expect(before.json<SyncStatusDto>().lastResult).toBeNull();

    const runRes = await t.post("/api/sync/run", {
      projectId: project.id, connector: "codex", dryRun: false, mode: "archiveOnly",
      idleMinutes: 1, maxArtifacts: 5, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(runRes, 200);

    const statusRes = await t.get("/api/sync/status");
    expectStatus(statusRes, 200);
    const status = statusRes.json<SyncStatusDto>();
    // The run is over, and its result is durable enough for a reloaded page to
    // recover — including the project it was scoped to.
    expect(status.running).toBe(false);
    expect(status.lastResult?.dryRun).toBe(false);
    expect(status.lastResult?.plan.projectId).toBe(project.id);
    expect(status.lastResult?.runId).toBe(runRes.json<SyncRunResultDto>().runId);
  });
});

describe("L4.1 persistent sync jobs", () => {
  it("persists a completed backfill job with terminal progress in status", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(codexHome, "session-12121212-1212-4212-8212-121212121212", repo, "durable job artifact", 60);

    const res = await t.post("/api/sync/run", {
      projectId: project.id, connector: "codex", dryRun: false, mode: "archiveOnly",
      idleMinutes: 1, maxArtifacts: 5, maxChars: 1_000_000, maxCostUsd: 1,
    });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();

    const statusRes = await t.get("/api/sync/status");
    expectStatus(statusRes, 200);
    const status = statusRes.json<SyncStatusDto>();
    expect(status.currentJob).toBeNull();
    expect(status.lastJob?.id).toBe(result.runId);
    expect(status.lastJob?.stage).toBe("completed");
    expect(status.lastJob?.selected).toBe(1);
    expect(status.lastJob?.completed).toBe(1);
    expect(status.lastJob?.failed).toBe(0);
    expect(status.lastJob?.projectId).toBe(project.id);
  });

  it("marks a persisted running job interrupted on restart without losing progress", async () => {
    const { t, project } = await linkedApp();
    const id = "34343434-3434-4434-8434-343434343434";
    const startedAt = "2026-09-17T10:00:00.000Z";
    const updatedAt = "2026-09-17T10:01:00.000Z";
    const sql = [
      "INSERT INTO sync_jobs(",
      "id,project_id,connector,mode,input_json,stage,selected,completed,failed,current_key,",
      "result_json,last_error,started_at,updated_at,finished_at",
      ") VALUES(?,?,?,?,?,'running',?,?,?,?,NULL,NULL,?,?,NULL)",
    ].join("");
    t.app.ck.handle.sqlite.prepare(sql).run(
      id,
      project.id,
      "codex",
      "archiveOnly",
      JSON.stringify({ projectId: project.id, connector: "codex", mode: "archiveOnly", dryRun: false }),
      5,
      2,
      1,
      "codex:artifact-in-progress",
      startedAt,
      updatedAt,
    );

    insertRecoverableSyncJob(t, {
      id: "already-completed-sync-job",
      projectId: project.id,
      stage: "completed",
      input: { projectId: project.id, connector: "codex", dryRun: false, mode: "archiveOnly" },
    });

    const restarted = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);
    const status = restarted.status();

    expect(status.currentJob).toBeNull();
    expect(status.lastJob?.id).toBe(id);
    expect(status.lastJob?.stage).toBe("interrupted");
    expect(status.lastJob?.selected).toBe(5);
    expect(status.lastJob?.completed).toBe(2);
    expect(status.lastJob?.failed).toBe(1);
    expect(status.lastJob?.currentKey).toBe("codex:artifact-in-progress");
    expect(status.lastJob?.finishedAt).not.toBeNull();
    expect(status.lastJob?.lastError).toContain("restarted");

    const completed = t.app.ck.handle.sqlite
      .prepare("SELECT stage,finished_at FROM sync_jobs WHERE id=?")
      .get("already-completed-sync-job") as { stage: string; finished_at: string | null };
    expect(completed.stage).toBe("completed");
    expect(completed.finished_at).not.toBeNull();
  });
});

type RecoverableStage = "failed" | "interrupted" | "cancelled" | "completed_with_errors";

function insertRecoverableSyncJob(
  t: TestApp,
  opts: { id: string; projectId: string; stage: RecoverableStage | "running" | "completed"; input: Record<string, unknown> },
): void {
  const stamp = "2026-09-17T12:00:00.000Z";
  t.app.ck.handle.sqlite.prepare([
    "INSERT INTO sync_jobs(",
    "id,project_id,connector,mode,input_json,stage,selected,completed,failed,current_key,",
    "result_json,last_error,started_at,updated_at,finished_at",
    ") VALUES(?,?,?,?,?,?,0,0,0,NULL,NULL,NULL,?,?,?)",
  ].join("")).run(
    opts.id,
    opts.projectId,
    opts.input.connector,
    opts.input.mode,
    JSON.stringify(opts.input),
    opts.stage,
    stamp,
    stamp,
    opts.stage === "running" ? null : stamp,
  );
}

describe("L4.2 retry/cancel/resume", () => {
  it("retries a failed persisted job from its original input", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(codexHome, "session-45454545-4545-4454-8454-454545454545", repo, "fact: retry me once", 60);
    const input = {
      projectId: project.id,
      connector: "codex",
      dryRun: false,
      mode: "archiveOnly",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    };
    insertRecoverableSyncJob(t, { id: "failed-sync-job", projectId: project.id, stage: "failed", input });

    const res = await t.post("/api/sync/jobs/failed-sync-job/action", { action: "retry" });
    expectStatus(res, 200);
    const result = res.json<SyncRunResultDto>();
    expect(result.runId).not.toBe("failed-sync-job");
    expect(result.plan.selected).toBe(1);
    expect(result.counts.archivedCreated).toBe(1);

    const status = (await t.get("/api/sync/status")).json<SyncStatusDto>();
    expect(status.currentJob).toBeNull();
    expect(status.lastJob?.id).toBe(result.runId);
    expect(status.lastJob?.stage).toBe("completed");
  });

  it("resumes an interrupted extraction run without repeating completed provider work", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(codexHome, "session-56565656-5656-4565-8565-565656565656", repo, "fact: lunar telemetry calibration uses basalt reference markers", 70);
    writeCodexSession(codexHome, "session-67676767-6767-4676-8676-676767676767", repo, "question: cedar notebook checksum differs after midnight archive rotation", 60);

    const first = await t.post("/api/sync/run", {
      projectId: project.id,
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      idleMinutes: 1,
      maxArtifacts: 1,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    });
    expectStatus(first, 200);
    expect(first.json<SyncRunResultDto>().plan.selected).toBe(1);

    const before = t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM source_extractions WHERE stage='done'")
      .get() as { n: number };
    expect(before.n).toBe(1);

    const resumeInput = {
      projectId: project.id,
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "faketest",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    };
    insertRecoverableSyncJob(t, { id: "interrupted-sync-job", projectId: project.id, stage: "interrupted", input: resumeInput });

    const resumed = await t.post("/api/sync/jobs/interrupted-sync-job/action", { action: "resume" });
    expectStatus(resumed, 200);
    const result = resumed.json<SyncRunResultDto>();
    expect(result.plan.selected).toBe(1);
    expect(result.counts.extractedCreated + result.counts.extractionUnchanged).toBe(1);

    const after = t.app.ck.handle.sqlite
      .prepare("SELECT count(*) AS n FROM source_extractions WHERE stage='done'")
      .get() as { n: number };
    expect(after.n).toBe(2);
  });

  it("cancels a persisted running job durably", async () => {
    const { t, project } = await linkedApp();
    insertRecoverableSyncJob(t, {
      id: "running-sync-job",
      projectId: project.id,
      stage: "running",
      input: { projectId: project.id, connector: "codex", dryRun: false, mode: "archiveOnly" },
    });

    const cancelled = await t.post("/api/sync/jobs/running-sync-job/action", { action: "cancel" });
    expectStatus(cancelled, 200);
    expect(cancelled.json<{ stage: string }>().stage).toBe("cancelled");

    const row = t.app.ck.handle.sqlite
      .prepare("SELECT stage,finished_at,last_error FROM sync_jobs WHERE id=?")
      .get("running-sync-job") as { stage: string; finished_at: string | null; last_error: string | null };
    expect(row.stage).toBe("cancelled");
    expect(row.finished_at).not.toBeNull();
    expect(row.last_error).toBe("Cancelled by owner.");
  });

  it("stops execution before starting another artifact when cancellation is observed", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(codexHome, "session-78787878-7878-4787-8787-787878787878", repo, "fact: must remain untouched", 60);
    const before = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_origins").get() as { n: number }).n;

    await expect(runSyncOnce(
      t.app.ck.deps,
      t.app.ck.config,
      {
        projectId: project.id,
        connector: "codex",
        dryRun: false,
        mode: "archiveOnly",
        idleMinutes: 1,
        maxArtifacts: 5,
        maxChars: 1_000_000,
        maxCostUsd: 1,
      },
      { actor: "owner:test", requestId: null },
      { shouldCancel: () => true },
    )).rejects.toThrow("Sync run was cancelled.");

    const after = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_origins").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});


describe("CK-A08 shutdown drain", () => {
  it("releases the coordinator after initial job persistence fails and preserves the original failure", async () => {
    const { t, project } = await linkedApp();
    const coordinator = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);
    const input = {
      projectId: project.id,
      connector: "codex" as const,
      dryRun: false,
      mode: "archiveOnly" as const,
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    };
    const sqlite = t.app.ck.deps.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let insertFailure = true;
    const prepare = vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
      if (insertFailure && sql.startsWith("INSERT INTO sync_jobs")) {
        insertFailure = false;
        throw new Error("injected initial sync job failure");
      }
      return originalPrepare(sql);
    });
    await expect(coordinator.run(input, { actor: "owner:test", requestId: null }))
      .rejects.toThrow("injected initial sync job failure");
    expect(coordinator.status().running).toBe(false);
    prepare.mockRestore();

    const recovered = await coordinator.run(input, { actor: "owner:test", requestId: null });
    expect(recovered.errors).toEqual([]);
    expect(coordinator.status().running).toBe(false);
  });

  it("drains immediately and idempotently when no sync run is active", async () => {
    const { t } = await linkedApp();
    const coordinator = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);

    await Promise.all([
      coordinator.stopAndDrain({ deadlineMs: 25 }),
      coordinator.stopAndDrain({ deadlineMs: 25 }),
    ]);

    expect(coordinator.status().running).toBe(false);
    await expect(
      coordinator.run(
        { connector: "both", dryRun: true, mode: "archiveOnly", allowUnassignedArchive: false },
        { actor: "owner:test", requestId: null },
      ),
    ).rejects.toMatchObject({ code: "sync_shutting_down" });
  });

  it("cooperatively aborts active provider work, persists interrupted, and rejects new runs", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(
      codexHome,
      "session-89898989-8989-4898-8989-898989898989",
      repo,
      "fact: shutdown drain must never complete after cancellation",
      60,
    );

    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let observedSignal: AbortSignal | undefined;
    let abortObserved = false;
    const blockingAdapter = {
      id: "shutdown-test",
      version: "1",
      label: "shutdown test",
      costCategory: "free",
      estimateUsage: async () => null,
      extract: async (_input: unknown, signal?: AbortSignal) => {
        observedSignal = signal;
        startedResolve();
        if (!signal) throw new Error("missing cooperative shutdown signal");
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            abortObserved = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    } as any;

    const original = t.app.ck.deps.registry;
    const deps = {
      ...t.app.ck.deps,
      registry: { ...original, get: (id: string) => id === "shutdown-test" ? blockingAdapter : original.get(id) },
    } as any;
    const coordinator = new SyncCoordinator(deps, t.app.ck.config);
    const input = {
      projectId: project.id,
      connector: "codex" as const,
      dryRun: false,
      mode: "archiveAndExtract" as const,
      extractionAdapterId: "shutdown-test",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    };

    const runPromise = coordinator.run(input, { actor: "owner:test", requestId: null }).catch((error) => error);
    await started;

    expect(typeof (coordinator as any).stopAndDrain).toBe("function");
    await Promise.all([
      (coordinator as any).stopAndDrain({ deadlineMs: 1_000 }),
      (coordinator as any).stopAndDrain({ deadlineMs: 1_000 }),
    ]);

    const runError = await runPromise;
    expect(observedSignal).toBeDefined();
    expect(abortObserved).toBe(true);
    expect(runError).toMatchObject({ code: "sync_interrupted" });

    const row = deps.sqlite.prepare("SELECT stage,last_error FROM sync_jobs ORDER BY started_at DESC,id DESC LIMIT 1").get() as {
      stage: string;
      last_error: string | null;
    };
    expect(row.stage).toBe("interrupted");
    expect(row.last_error).toMatch(/shutdown|interrupted/i);

    await expect(coordinator.run(input, { actor: "owner:test", requestId: null }))
      .rejects.toMatchObject({ code: "sync_shutting_down" });
  });

  it("does not finish drain at its deadline while an abort-ignoring provider can still continue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { t, repo, codexHome, project } = await linkedApp();
      writeCodexSession(
        codexHome,
        "session-90909090-9090-4909-8909-909090909090",
        repo,
        "fact: late provider response must not close over a closed database",
        60,
      );

      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let releaseResolve!: () => void;
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      let observedSignal: AbortSignal | undefined;
      const slowAdapter = {
        id: "shutdown-late-test",
        version: "1",
        label: "shutdown late test",
        costCategory: "free",
        estimateUsage: async () => null,
        extract: async (_input: unknown, signal?: AbortSignal) => {
          observedSignal = signal;
          startedResolve();
          await release;
          return { candidates: [], usage: null };
        },
      } as any;

      const original = t.app.ck.deps.registry;
      const deps = {
        ...t.app.ck.deps,
        registry: { ...original, get: (id: string) => id === "shutdown-late-test" ? slowAdapter : original.get(id) },
      } as any;
      const coordinator = new SyncCoordinator(deps, t.app.ck.config);
      const input = {
        projectId: project.id,
        connector: "codex" as const,
        dryRun: false,
        mode: "archiveAndExtract" as const,
        extractionAdapterId: "shutdown-late-test",
        idleMinutes: 1,
        maxArtifacts: 5,
        maxChars: 1_000_000,
        maxCostUsd: 1,
      };

      const runPromise = coordinator.run(input, { actor: "owner:test", requestId: null }).catch((error) => error);
      await started;

      const drainFn = (coordinator as any).stopAndDrain;
      if (typeof drainFn !== "function") {
        releaseResolve();
        await runPromise;
      }
      expect(typeof drainFn).toBe("function");

      let drained = false;
      const drainPromise = drainFn.call(coordinator, { deadlineMs: 25 }).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(25);

      expect(observedSignal?.aborted).toBe(true);
      expect(drained).toBe(false);
      const duringDeadline = deps.sqlite.prepare("SELECT stage FROM sync_jobs ORDER BY started_at DESC,id DESC LIMIT 1").get() as {
        stage: string;
      };
      expect(duringDeadline.stage).toBe("interrupted");

      releaseResolve();
      await drainPromise;
      const runError = await runPromise;
      expect(runError).toMatchObject({ code: "sync_interrupted" });
      expect(drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escape a deadline persistence fault and still waits for the continuation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { t, repo, codexHome, project } = await linkedApp();
      writeCodexSession(codexHome, "session-91929292-9192-4919-8919-919292929292", repo, "fact: deadline persistence fault", 60);
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      let releaseResolve!: () => void;
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const slowAdapter = {
        id: "shutdown-fault-test",
        version: "1",
        label: "shutdown fault test",
        costCategory: "free",
        estimateUsage: async () => null,
        extract: async () => {
          startedResolve();
          await release;
          return { candidates: [], usage: null };
        },
      } as any;
      const original = t.app.ck.deps.registry;
      const deps = {
        ...t.app.ck.deps,
        registry: { ...original, get: (id: string) => id === "shutdown-fault-test" ? slowAdapter : original.get(id) },
      } as any;
      const coordinator = new SyncCoordinator(deps, t.app.ck.config);
      const input = {
        projectId: project.id,
        connector: "codex" as const,
        dryRun: false,
        mode: "archiveAndExtract" as const,
        extractionAdapterId: "shutdown-fault-test",
        idleMinutes: 1,
        maxArtifacts: 5,
        maxChars: 1_000_000,
        maxCostUsd: 1,
      };
      const runPromise = coordinator.run(input, { actor: "owner:test", requestId: null }).catch((error) => error);
      await started;

      const sqlite = deps.sqlite;
      const originalPrepare = sqlite.prepare.bind(sqlite);
      const prepare = vi.spyOn(sqlite, "prepare").mockImplementation((sql: string) => {
        if (sql.startsWith("UPDATE sync_jobs SET stage='interrupted'")) throw new Error("injected deadline persistence failure");
        return originalPrepare(sql);
      });
      let drained = false;
      const drainPromise = coordinator.stopAndDrain({ deadlineMs: 25 }).then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(25);
      expect(drained).toBe(false);
      expect(coordinator.status().lastError).toMatch(/shutdown drain exceeded 25ms/i);

      releaseResolve();
      await expect(drainPromise).resolves.toBeUndefined();
      await expect(runPromise).resolves.toMatchObject({ code: "sync_interrupted" });
      expect(drained).toBe(true);
      prepare.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("CK-A08 application shutdown ordering", () => {
  it("signals active sync before close and closes SQLite only after the provider continuation stops", async () => {
    const { t, repo, codexHome, project } = await linkedApp();
    writeCodexSession(
      codexHome,
      "session-91919191-9191-4919-8919-919191919191",
      repo,
      "fact: application close must drain active sync before sqlite close",
      60,
    );

    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let abortObserved = false;
    let sqliteWasOpenAtAbort = false;
    const appShutdownAdapter = {
      id: "shutdown-app-test",
      version: "1",
      label: "shutdown app test",
      costCategory: "free",
      estimateUsage: async () => null,
      extract: async (_input: unknown, signal?: AbortSignal) => {
        startedResolve();
        if (!signal) throw new Error("missing application shutdown signal");
        return await new Promise((_resolve, reject) => {
          const onAbort = () => {
            abortObserved = true;
            sqliteWasOpenAtAbort = (t.app.ck.handle.sqlite as any).open === true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    } as any;

    const originalRegistry = t.app.ck.deps.registry;
    (t.app.ck.deps as any).registry = {
      ...originalRegistry,
      get: (id: string) => id === "shutdown-app-test" ? appShutdownAdapter : originalRegistry.get(id),
    };

    const runPromise = t.post("/api/sync/run", {
      projectId: project.id,
      connector: "codex",
      dryRun: false,
      mode: "archiveAndExtract",
      extractionAdapterId: "shutdown-app-test",
      idleMinutes: 1,
      maxArtifacts: 5,
      maxChars: 1_000_000,
      maxCostUsd: 1,
    });
    await started;

    await t.app.close();
    const response = await runPromise;

    expect(abortObserved).toBe(true);
    expect(sqliteWasOpenAtAbort).toBe(true);
    expect((t.app.ck.handle.sqlite as any).open).toBe(false);
    expect(response.statusCode).toBe(409);
  });
});
