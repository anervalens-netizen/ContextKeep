import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry.js";
import { bootstrapDatabase } from "../src/db/bootstrap.js";
import { openDatabase, type DbHandle } from "../src/db/client.js";
import { buildContextManifest, ensureContextCursorBaselines, readContextCursorSnapshot } from "../src/services/context-journal.js";
import { bumpProjectContentVersion } from "../src/services/content-version.js";
import { getContextDelta } from "../src/services/context-delta.js";
import { captureWork } from "../src/services/capture-work.js";
import { getBlockerState, resolveBlocker } from "../src/services/blockers.js";
import type { ActorCtx, ServiceDeps } from "../src/services/import.js";
import { createProject, deleteRecord, requireProject, requireRecord, restoreRecord, reviewRecords } from "../src/services/memory-management.js";
import { editRecord } from "../src/services/review.js";
import { ContextKeepMemoryService } from "../src/services/memory-context.js";
import { verifyBackup } from "../src/services/backup.js";
import { toolResult } from "../src/mcp/safety.js";
import { makeTestApp } from "./helpers.js";

const ctx: ActorCtx = { actor: "test:mcp-first", requestId: null };
const readCtx = { threadId: "test", scope: "all" as const, projectId: null };

function setup(name: string): { handle: DbHandle; deps: ServiceDeps; id: string } {
  const handle = openDatabase(":memory:");
  bootstrapDatabase(handle);
  const deps: ServiceDeps = { ...handle, registry: createAdapterRegistry(["manual"]), costCeilingUsd: 0, volatileReviewIntervalDays: 7 };
  const id = createProject(deps, { name, aliases: [], description: null, parentId: null }, ctx).id;
  return { handle, deps, id };
}
function cap(deps: ServiceDeps, id: string, subject: string, extra: Partial<Parameters<typeof captureWork>[1]> = {}) {
  return captureWork(deps, { projectId: id, subject, outcome: subject, evidenceText: null, title: null, eventAt: null, recordType: "fact", progressUpdates: [], ...extra }, ctx);
}
function curs(deps: ServiceDeps, id: string) {
  const p = requireProject(deps, id);
  return { canonicalCursor: p.contentVersion, workingCursor: p.workingMemoryVersion, projectRevision: p.revision };
}
function journalMatches(deps: ServiceDeps, id: string, scope: "canonical" | "working") {
  const p = requireProject(deps, id);
  const cursor = scope === "canonical" ? p.contentVersion : p.workingMemoryVersion;
  const s = readContextCursorSnapshot(deps.db, id, scope, cursor);
  return !!s && JSON.stringify(JSON.parse(s.manifestJson)) === JSON.stringify(buildContextManifest(deps.db, id, scope));
}

/** MCF-00: desired invariants for audit probes P01-P10. Remove .fails only after the owning remediation is fixed. */
describe("CK-MCP-FIRST P01-P10 regression contracts", () => {
  it("P01 final manifest includes all evidence excerpts", () => {
    const f = setup("p01");
    try {
      const r = cap(f.deps, f.id, "multi", { evidenceText: Array.from({ length: 16 }, (_, i) => "Section " + i + " " + "evidence detail ".repeat(70)).join("\n\n") });
      expect(r.source.excerptIds.length).toBeGreaterThan(1);
      expect(journalMatches(f.deps, f.id, "working")).toBe(true);
    } finally { f.handle.sqlite.close(); }
  });

  it("P02 superseded delete/restore is visible in canonical delta", () => {
    const f = setup("p02");
    try {
      const r = cap(f.deps, f.id, "historical");
      f.deps.sqlite.prepare("UPDATE records SET review_status='superseded' WHERE id=?").run(r.outcome.recordId);
      bumpProjectContentVersion(f.deps.db, [f.id]);
      const before = curs(f.deps, f.id);
      const deleted = deleteRecord(f.deps, { recordId: r.outcome.recordId, revision: 1, reason: "test" }, ctx);
      expect(curs(f.deps, f.id).canonicalCursor).toBeGreaterThan(before.canonicalCursor);
      expect(getContextDelta(f.deps, { projectId: f.id, ...before }).changes.length).toBeGreaterThan(0);
      restoreRecord(f.deps, { recordId: r.outcome.recordId, revision: deleted.revision, deletionId: deleted.deletionId, ownerAction: true }, ctx);
      expect(journalMatches(f.deps, f.id, "canonical")).toBe(true);
    } finally { f.handle.sqlite.close(); }
  });

  it("P03 cross-project move publishes destination working delta", () => {
    const f = setup("p03-origin");
    try {
      const target = createProject(f.deps, { name: "p03-dest", aliases: [], description: null, parentId: null }, ctx);
      const r = cap(f.deps, f.id, "move");
      const before = curs(f.deps, target.id);
      editRecord(f.deps, r.outcome.recordId, { revision: 1, projectId: target.id }, ctx);
      expect(curs(f.deps, target.id).workingCursor).toBeGreaterThan(before.workingCursor);
      expect(getContextDelta(f.deps, { projectId: target.id, ...before }).changes.length).toBeGreaterThan(0);
      expect(journalMatches(f.deps, target.id, "working")).toBe(true);
    } finally { f.handle.sqlite.close(); }
  });

  it("P04 semantic no-op does not bump revision or cursor", () => {
    const f = setup("p04");
    try {
      const r = cap(f.deps, f.id, "accepted");
      reviewRecords(f.deps, { items: [{ recordId: r.outcome.recordId, revision: 1 }], action: "accept", ownerAction: true }, ctx);
      const beforeRecord = requireRecord(f.deps, r.outcome.recordId);
      const before = curs(f.deps, f.id);
      editRecord(f.deps, beforeRecord.id, { revision: beforeRecord.revision }, ctx);
      expect(requireRecord(f.deps, beforeRecord.id).revision).toBe(beforeRecord.revision);
      expect(curs(f.deps, f.id).canonicalCursor).toBe(before.canonicalCursor);
    } finally { f.handle.sqlite.close(); }
  });
  it("P05 reset snapshot is paginated below MCP transport ceiling", () => {
    const f = setup("p05");
    try {
      for (let i = 0; i < 24; i += 1) cap(f.deps, f.id, "large-" + i, { evidenceText: "Unique " + i + "\n" + "bounded source material ".repeat(1500) });
      const current = curs(f.deps, f.id);
      const reset = getContextDelta(f.deps, { projectId: f.id, ...current, canonicalCursor: current.canonicalCursor + 1, limit: 1 });
      expect(() => toolResult(reset, [])).not.toThrow();
      expect(reset.resetRequired).toBe(true);
      expect(reset.fullSnapshotTruncated).toBe(true);
      expect(reset.baselineMode).toBe("changes_from_empty");
      expect(reset.nextPageToken).not.toBeNull();
    } finally { f.handle.sqlite.close(); }
  });

  it("P06 expired and impossible delta page tokens are rejected", () => {
    const f = setup("p06");
    try {
      const before = curs(f.deps, f.id);
      cap(f.deps, f.id, "a");
      cap(f.deps, f.id, "b");
      const first = getContextDelta(f.deps, { projectId: f.id, ...before, limit: 1 });
      expect(first.nextPageToken).toBeTruthy();
      f.deps.sqlite.prepare("UPDATE context_delta_sessions SET created_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", first.sessionId);
      const expired = getContextDelta(f.deps, { projectId: f.id, ...before, limit: 1, pageToken: first.nextPageToken });
      expect(expired.resetRequired).toBe(true);
      expect(expired.resetReason).toBe("page_expired");
      expect(expired.baselineMode).toBe("changes_from_empty");
      expect(() => getContextDelta(f.deps, { projectId: f.id, ...before, limit: 1, pageToken: expired.sessionId + ":9999" })).toThrow(/past the available session data/i);
      expect(() => getContextDelta(f.deps, { projectId: f.id, ...before, limit: 1, pageToken: "not-a-token" })).toThrow(/malformed/i);
    } finally { f.handle.sqlite.close(); }
  });

  it("P07 blocker history remains readable through a bounded response", () => {
    const f = setup("p07");
    try {
      for (let i = 0; i < 24; i += 1) {
        cap(f.deps, f.id, "checkpoint-" + i, { checkpoint: { summary: "batch " + i, blockers: Array.from({ length: 20 }, (_, j) => "block " + i + "-" + j + ": " + "b".repeat(950)) } });
      }
      const state = getBlockerState(f.deps, f.id);
      expect(state.activeCount).toBe(480);
      expect(state.active.length).toBe(25);
      expect(state.history.length).toBe(25);
      expect(state.pagination.activeNextOffset).toBe(25);
      expect(() => toolResult(state, [])).not.toThrow();
      expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(750000);
    } finally { f.handle.sqlite.close(); }
  });

  it("P08 newer related null-predicate working state marks accepted state stale", () => {
    const f = setup("p08");
    try {
      const old = cap(f.deps, f.id, "database-alpha release", { outcome: "database-alpha current version 1", predicate: "version", eventAt: "2026-01-01T00:00:00.000Z" });
      reviewRecords(f.deps, { items: [{ recordId: old.outcome.recordId, revision: 1 }], action: "accept", ownerAction: true }, ctx);
      cap(f.deps, f.id, "database-alpha release", { outcome: "database-alpha current version 2", eventAt: "2026-02-01T00:00:00.000Z" });
      const out = new ContextKeepMemoryService(f.deps).getWorkContext(readCtx, { projectId: f.id, diagnostics: true });
      expect(out.facts.items.find((x) => x.recordId === old.outcome.recordId)?.stale).toBe(true);
    } finally { f.handle.sqlite.close(); }
  });

  it("P09 resolved blocker alone does not keep stale indicator true", () => {
    const f = setup("p09");
    try {
      cap(f.deps, f.id, "checkpoint", { checkpoint: { summary: "checkpoint", blockers: ["wait for dependency"] } });
      const blocker = getBlockerState(f.deps, f.id).active[0]!;
      resolveBlocker(f.deps, { projectId: f.id, blockerId: blocker.blockerId, checkpointRevision: blocker.checkpointRevision, disposition: "resolved", resolution: "available", evidenceText: null, actionRecordId: null }, ctx);
      const out = new ContextKeepMemoryService(f.deps).getWorkContext(readCtx, { projectId: f.id, diagnostics: true });
      expect(out.blockerState.activeCount).toBe(0);
      expect(out.indicators.stale).toBe(false);
    } finally { f.handle.sqlite.close(); }
  });

  it("P10 v15 backup missing cursor/delta tables is rejected before restore", async () => {
    const f = setup("p10");
    const dir = mkdtempSync(path.join(tmpdir(), "ck-p10-"));
    const file = path.join(dir, "broken.sqlite");
    try {
      f.deps.sqlite.exec("DROP TABLE context_cursor_snapshots; DROP TABLE context_delta_sessions;");
      await f.handle.sqlite.backup(file);
      expect(() => verifyBackup(file)).toThrow(/context_cursor_snapshots|context_delta_sessions/i);
      expect(() => ensureContextCursorBaselines(f.deps.db)).toThrow();
    } finally {
      f.handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("CK-MCP-FIRST chat-retirement acceptance guards", () => {
  it("new server exposes no internal AI chat HTTP surface", async () => {
    const t = await makeTestApp();
    try {
      for (const [method, url] of [
        ["GET", "/api/agent/config"],
        ["GET", "/api/agent/threads"],
        ["POST", "/api/agent/threads"],
      ] as const) {
        const response = await t.raw(method, url, method === "POST" ? { scope: "all" } : undefined);
        expect(response.statusCode).toBe(404);
        expect(response.payload).not.toContain("<!doctype html");
      }
    } finally {
      await t.cleanup();
    }
  });

  it("server package no longer depends on dedicated internal-chat SDKs", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).not.toHaveProperty("@openai/agents");
    expect(pkg.dependencies).not.toHaveProperty("@openai/agents-extensions");
    expect(pkg.dependencies).not.toHaveProperty("@openai/codex-sdk");
  });
});
