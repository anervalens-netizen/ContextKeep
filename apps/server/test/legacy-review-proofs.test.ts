import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncCoordinator, runSyncOnce } from "../src/services/sync.js";
import { buildWorkspaceReconciliation } from "../src/services/reconciliation.js";
import { previewCodexSession } from "../src/services/sync-preview.js";
import { ApiError } from "../src/lib/errors.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const seams = vi.hoisted(() => ({
  codexCatalog: null as {
    currentCount: number;
    archivedCount: number;
    unreadableCount: number;
    sessions: Array<Record<string, unknown>>;
  } | null,
  catalogLimits: [] as number[],
  preview: null as
    | ((home: string, opts: { sessionId: string }) => Record<string, unknown>)
    | null,
  importError: null as Error | null,
}));

vi.mock("../src/services/codex.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/codex.js")
  >("../src/services/codex.js");
  return {
    ...actual,
    catalogCodexSessions: (
      db: unknown,
      home: string,
      opts: { state: "all" | "current" | "archived"; limit: number },
    ) => {
      seams.catalogLimits.push(opts.limit);
      if (!seams.codexCatalog)
        return actual.catalogCodexSessions(db as never, home, opts);
      return {
        ...seams.codexCatalog,
        sessions: seams.codexCatalog.sessions.slice(0, opts.limit),
      };
    },
    importCodexSession: async (
      _deps: unknown,
      _home: string,
      input: { sessionId: string; archiveState: "current" | "archived" },
      _ctx: unknown,
      guard: { expectedExternalPart?: string },
    ) => {
      if (seams.importError) throw seams.importError;
      return {
        status: "created",
        externalId: input.sessionId,
        externalPart:
          guard.expectedExternalPart ?? `snapshot:${input.sessionId}`,
        sourceId: `synthetic-source-${input.sessionId}`,
        archiveState: input.archiveState,
        workspaceBindingId: null,
        projectId: null,
        safeItemCount: 1,
        safeCharCount: 24,
        redactionCount: 0,
        importResult: null,
      };
    },
  };
});

vi.mock("../src/services/sync-preview.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/sync-preview.js")
  >("../src/services/sync-preview.js");
  return {
    ...actual,
    previewCodexSession: (
      home: string,
      opts: {
        sessionId: string;
        relativePath: string;
        archiveState: "current" | "archived";
      },
    ) => {
      if (seams.preview) return seams.preview(home, opts) as never;
      return actual.previewCodexSession(home, opts);
    },
  };
});

const dirs: string[] = [];
const apps: TestApp[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function isolatedHomes(t: TestApp): void {
  t.app.ck.config.codexHome = temp("ck-legacy-review-codex-");
  t.app.ck.config.dshHome = temp("ck-legacy-review-dsh-");
}

function session(
  id: string,
  workspaceBindingId: string | null,
  updatedAt: string,
  projectId: string | null = null,
): Record<string, unknown> {
  return {
    sessionId: id,
    archiveState: "current",
    relativePath: `sessions/${id}.jsonl`,
    cwd: `/synthetic/${workspaceBindingId ?? "unlinked"}`,
    createdAt: updatedAt,
    updatedAt,
    byteSize: 128,
    workspaceBindingId,
    workspaceName: workspaceBindingId,
    projectId,
    projectName: projectId ? "Synthetic project" : null,
    importedSnapshotCount: 0,
  };
}

function syntheticPreview(
  id: string,
  updatedAt = "2026-09-26T00:00:00.000Z",
): Record<string, unknown> {
  return {
    connector: "codex",
    kind: "session",
    externalId: id,
    externalPart: `snapshot:synthetic-${id}`,
    externalRevision: "1",
    archiveState: "current",
    externalUpdatedAt: updatedAt,
    eventAt: updatedAt,
    authorLabel: "codex-synthetic",
    text: "User:\nSynthetic visible request",
    safeItemCount: 1,
    safeCharCount: 31,
    redactionCount: 0,
  };
}

function configureCodexCatalog(sessions: Array<Record<string, unknown>>): void {
  seams.catalogLimits.length = 0;
  seams.codexCatalog = {
    currentCount: sessions.filter((item) => item.archiveState === "current")
      .length,
    archivedCount: sessions.filter((item) => item.archiveState === "archived")
      .length,
    unreadableCount: 0,
    sessions,
  };
  seams.preview = (_home, opts) => syntheticPreview(opts.sessionId);
}

function insertWorkspace(
  t: TestApp,
  id: string,
  displayName: string,
  lastGitActivity: string,
  lastObservedActivity: string,
): void {
  const sqlite = t.app.ck.handle.sqlite;
  sqlite
    .prepare(
      `
    INSERT INTO workspace_bindings(
      id, canonical_key, canonical_path, display_name, git_remote, git_branch, git_head_sha,
      last_git_activity, last_observed_activity, project_id, ignored,
      first_seen_at, last_seen_at, created_at, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,NULL,0,?,?,?,?)
  `,
    )
    .run(
      id,
      `synthetic:${id}`,
      `/synthetic/workspaces/${id}`,
      displayName,
      `github.com/example/${id}`,
      "main",
      null,
      lastGitActivity,
      lastObservedActivity,
      "2026-09-01T00:00:00.000Z",
      "2026-09-26T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      "2026-09-26T00:00:00.000Z",
    );
}

afterEach(async () => {
  seams.codexCatalog = null;
  seams.catalogLimits.length = 0;
  seams.preview = null;
  seams.importError = null;
  while (apps.length) await apps.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("focused legacy recommendation proofs", () => {
  it("ID3986658316 preserves last_success_at across artifact errors, restart, and catastrophic failure", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    isolatedHomes(t);
    const id = "synthetic-sync-state-session";
    configureCodexCatalog([session(id, null, "2026-09-25T00:00:00.000Z")]);
    const input = {
      connector: "codex" as const,
      dryRun: false,
      mode: "archiveOnly" as const,
      idleMinutes: 60,
      maxArtifacts: 5,
      maxChars: 100_000,
      maxCostUsd: 1,
      allowUnassignedArchive: true,
    };
    const ctx = { actor: "owner:synthetic-review", requestId: null };
    const coordinator = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);

    const first = await coordinator.run(input, ctx);
    expect(first.errors).toEqual([]);
    expect(first.counts.archivedCreated).toBe(1);
    const persistedSuccess = coordinator.status().lastSuccessAt;
    expect(persistedSuccess).toBeTruthy();

    seams.importError = new ApiError(
      409,
      "synthetic_artifact_error",
      "Synthetic manual artifact failure.",
    );
    const later = await coordinator.run(input, ctx);
    expect(later.errors).toHaveLength(1);
    expect(coordinator.status().lastSuccessAt).toBe(persistedSuccess);
    expect(coordinator.status().lastJob?.stage).toBe("completed_with_errors");

    const restarted = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);
    expect(restarted.status().lastSuccessAt).toBe(persistedSuccess);
    const persisted = t.app.ck.handle.sqlite
      .prepare(
        "SELECT last_success_at FROM connector_sync_state WHERE connector='codex'",
      )
      .get() as { last_success_at: string | null };
    expect(persisted.last_success_at).toBe(persistedSuccess);

    const sqlite = t.app.ck.deps.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const failure = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((sql: string) => {
        if (sql.startsWith("INSERT INTO sync_jobs"))
          throw new Error("synthetic catastrophic sync failure");
        return originalPrepare(sql);
      });
    await expect(restarted.run(input, ctx)).rejects.toThrow(
      "synthetic catastrophic sync failure",
    );
    failure.mockRestore();
    expect(restarted.status().lastSuccessAt).toBe(persistedSuccess);
    const afterCatastrophe = t.app.ck.handle.sqlite
      .prepare(
        "SELECT last_success_at FROM connector_sync_state WHERE connector='codex'",
      )
      .get() as { last_success_at: string | null };
    expect(afterCatastrophe.last_success_at).toBe(persistedSuccess);
  });

  it("ID3986685069 requests the complete catalog and plans older executable work beyond 5000 newer sessions", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    isolatedHomes(t);
    const newerAt = new Date(Date.now() - 30_000).toISOString();
    const olderAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const newer = Array.from({ length: 5000 }, (_, index) =>
      session(`synthetic-newer-${index}`, null, newerAt),
    );
    const olderId = "synthetic-older-eligible";
    configureCodexCatalog([...newer, session(olderId, null, olderAt)]);

    const result = await runSyncOnce(
      t.app.ck.deps,
      t.app.ck.config,
      {
        connector: "codex",
        dryRun: true,
        mode: "archiveOnly",
        idleMinutes: 60,
        maxArtifacts: 1,
        maxChars: 100_000,
        maxCostUsd: 1,
        allowUnassignedArchive: true,
      },
      { actor: "owner:synthetic-review", requestId: null },
    );

    expect(seams.catalogLimits).toContain(Number.MAX_SAFE_INTEGER);
    expect(result.plan.discovered).toBe(5001);
    expect(result.plan.eligible).toBe(1);
    expect(result.plan.selected).toBe(1);
    expect(
      result.plan.items.some(
        (item) => item.externalId === olderId && item.action === "archive",
      ),
    ).toBe(true);
  });

  it("ID3987617066 requests all catalog entries so older history for a second workspace is counted", async () => {
    const t = await makeTestApp();
    apps.push(t);
    isolatedHomes(t);
    const firstWorkspace = "11111111-1111-4111-8111-111111111111";
    const secondWorkspace = "22222222-2222-4222-8222-222222222222";
    insertWorkspace(
      t,
      firstWorkspace,
      "first-synthetic-workspace",
      "2026-09-26T00:00:00.000Z",
      "2026-09-26T00:00:00.000Z",
    );
    insertWorkspace(
      t,
      secondWorkspace,
      "second-synthetic-workspace",
      "2026-09-10T00:00:00.000Z",
      "2026-09-10T00:00:00.000Z",
    );
    const sessions = Array.from({ length: 5000 }, (_, index) =>
      session(
        `synthetic-history-${index}`,
        firstWorkspace,
        "2026-09-25T00:00:00.000Z",
      ),
    );
    sessions.push(
      session(
        "synthetic-history-older-second-workspace",
        secondWorkspace,
        "2026-09-01T00:00:00.000Z",
      ),
    );
    configureCodexCatalog(sessions);

    const result = buildWorkspaceReconciliation(
      t.app.ck.deps.db,
      t.app.ck.config,
    );
    const second = result.items.find(
      (item) => item.workspace.id === secondWorkspace,
    );
    expect(seams.catalogLimits).toContain(Number.MAX_SAFE_INTEGER);
    expect(result.total).toBe(2);
    expect(second).toBeDefined();
    expect(second!.history.codexCurrentCount).toBe(1);
    expect(second!.history.lastSessionActivity).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(second!.history.lastAgentActivity).toBe("2026-09-01T00:00:00.000Z");
  });

  it("ID3987681371 orders reconciliation by the maximum of agent and observed Git activity", async () => {
    const t = await makeTestApp();
    apps.push(t);
    isolatedHomes(t);
    const agentFirst = "33333333-3333-4333-8333-333333333333";
    const observedFirst = "44444444-4444-4444-8444-444444444444";
    insertWorkspace(
      t,
      agentFirst,
      "agent-first-if-agent-only",
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    );
    insertWorkspace(
      t,
      observedFirst,
      "observed-first-by-max",
      "2026-09-25T00:00:00.000Z",
      "2026-09-25T00:00:00.000Z",
    );
    configureCodexCatalog([
      session("synthetic-agent-older", agentFirst, "2026-09-24T00:00:00.000Z"),
      session(
        "synthetic-agent-newer",
        observedFirst,
        "2026-09-23T00:00:00.000Z",
      ),
    ]);

    const result = buildWorkspaceReconciliation(
      t.app.ck.deps.db,
      t.app.ck.config,
    );
    expect(result.items.map((item) => item.workspace.id)).toEqual([
      observedFirst,
      agentFirst,
    ]);
    const observedItem = result.items[0]!;
    const agentItem = result.items[1]!;
    expect(observedItem.history.lastAgentActivity).toBe(
      "2026-09-23T00:00:00.000Z",
    );
    expect(observedItem.workspace.lastObservedActivity).toBe(
      "2026-09-25T00:00:00.000Z",
    );
    expect(agentItem.history.lastAgentActivity).toBe(
      "2026-09-24T00:00:00.000Z",
    );
    expect(agentItem.workspace.lastObservedActivity).toBe(
      "2026-09-20T00:00:00.000Z",
    );
  });

  it("ID3986685055 rejects an oversized sparse session before readFileSync", () => {
    const home = temp("ck-legacy-review-sparse-");
    const relativePath = "sessions/2026/09/26/oversized.jsonl";
    const file = path.join(home, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(0));
    truncateSync(file, 64 * 1024 * 1024 + 1);
    const readFile = vi.spyOn(fs, "readFileSync");

    let error: unknown;
    try {
      previewCodexSession(home, {
        relativePath,
        sessionId: "synthetic-oversized-session",
        archiveState: "current",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "codex_session_too_large" });
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRestore();
  });

  it("ID3986685055 still filters visible messages with a large ignored tool line below the raw bound", () => {
    const home = temp("ck-legacy-review-filter-");
    const relativePath = "sessions/2026/09/26/filter.jsonl";
    const file = path.join(home, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    const sessionId = "synthetic-filter-session";
    const lines = [
      JSON.stringify({
        type: "session_meta",
        ordinal: 0,
        timestamp: "2026-09-26T00:00:00.000Z",
        payload: {
          session_id: sessionId,
          timestamp: "2026-09-26T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "response_item",
        ordinal: 1,
        timestamp: "2026-09-26T00:01:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Visible user message" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        ordinal: 2,
        timestamp: "2026-09-26T00:02:00.000Z",
        payload: {
          type: "function_call",
          name: "ignored-tool",
          arguments: "IGNORED-TOOL-DATA-" + "x".repeat(2 * 1024 * 1024),
        },
      }),
      JSON.stringify({
        type: "response_item",
        ordinal: 3,
        timestamp: "2026-09-26T00:03:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Visible assistant message" }],
        },
      }),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`);

    const result = previewCodexSession(home, {
      relativePath,
      sessionId,
      archiveState: "current",
    });
    expect(result.safeItemCount).toBe(2);
    expect(result.text).toContain("Visible user message");
    expect(result.text).toContain("Visible assistant message");
    expect(result.text).not.toContain("IGNORED-TOOL-DATA");
  });
});
