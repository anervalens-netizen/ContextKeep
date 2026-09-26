import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { SyncCoordinator } from "../src/services/sync.js";

vi.mock("../src/services/codex.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/codex.js")
  >("../src/services/codex.js");
  return {
    ...actual,
    catalogCodexSessions: () => ({
      currentCount: 0,
      archivedCount: 1,
      unreadableCount: 0,
      sessions: [
        {
          sessionId: "synthetic-failed-artifact",
          archiveState: "archived",
          relativePath: "archived_sessions/synthetic.jsonl",
          updatedAt: "2026-01-01T00:00:00.000Z",
          workspaceBindingId: null,
          projectId: null,
        },
      ],
    }),
    importCodexSession: async () => {
      throw new Error("Synthetic per-artifact import failure");
    },
  };
});
vi.mock("../src/services/sync-preview.js", async () => ({
  ...(await vi.importActual<typeof import("../src/services/sync-preview.js")>(
    "../src/services/sync-preview.js",
  )),
  previewCodexSession: () => ({
    connector: "codex",
    kind: "session",
    externalId: "synthetic-failed-artifact",
    externalPart: "snapshot:synthetic",
    externalRevision: "1",
    archiveState: "archived",
    externalUpdatedAt: "2026-01-01T00:00:00.000Z",
    eventAt: "2026-01-01T00:00:00.000Z",
    authorLabel: "synthetic",
    text: "Synthetic user evidence",
    safeItemCount: 1,
    safeCharCount: 23,
    redactionCount: 0,
  }),
}));
const apps: TestApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.cleanup();
});

describe("a failed connector cannot borrow another connector's successful timestamp", () => {
  it.each([
    { label: "an earlier success", prior: "2026-01-01T00:00:00.000Z" },
    { label: "no successful runs", prior: null },
    { label: "no prior state row", prior: undefined },
  ])("preserves $label during an artifact-error run", async ({ prior }) => {
    const t = await makeTestApp({ adapters: "manual" });
    apps.push(t);
    t.app.ck.config.codexHome = path.join(t.dataDir, "synthetic-codex-home");
    t.app.ck.config.dshHome = path.join(t.dataDir, "synthetic-dsh-home");
    mkdirSync(t.app.ck.config.codexHome);
    mkdirSync(t.app.ck.config.dshHome);
    const otherSuccess = "2026-01-02T00:00:00.000Z";
    const insert = t.app.ck.deps.sqlite.prepare(
      "INSERT INTO connector_sync_state(connector,last_success_at,updated_at) VALUES(?,?,?)",
    );
    if (prior !== undefined)
      insert.run("codex", prior, "2026-01-01T00:00:00.000Z");
    insert.run("dsh", otherSuccess, otherSuccess);
    const coordinator = new SyncCoordinator(t.app.ck.deps, t.app.ck.config);
    expect(coordinator.status().lastSuccessAt).toBe(otherSuccess);
    const result = await coordinator.run(
      {
        connector: "codex",
        dryRun: false,
        mode: "archiveOnly",
        idleMinutes: 1,
        maxArtifacts: 1,
        maxChars: 100_000,
        maxCostUsd: 1,
        allowUnassignedArchive: true,
      },
      { actor: "synthetic-review" },
    );
    expect(result.errors).toHaveLength(1);
    const state = t.app.ck.deps.sqlite
      .prepare(
        "SELECT connector,last_success_at,last_error FROM connector_sync_state ORDER BY connector",
      )
      .all() as Array<{
      connector: string;
      last_success_at: string | null;
      last_error: string | null;
    }>;
    expect(state[0]!.last_error).toBeTruthy();
    expect(state[0]!.last_success_at).toBe(prior ?? null);
    expect(state[1]!.last_success_at).toBe(otherSuccess);
    expect(
      new SyncCoordinator(t.app.ck.deps, t.app.ck.config).status()
        .lastSuccessAt,
    ).toBe(otherSuccess);
  });
});
