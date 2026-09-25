import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { projects, records } from "../src/db/schema.js";
import { runMemoryHousekeeping } from "../src/services/housekeeping.js";
import { applyPortableDump, buildPortableJsonDump, summarizePortableDump } from "../src/services/portable-dump.js";
import { createBackup, verifyBackup } from "../src/services/backup.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTHORIZE = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});

async function call(t: TestApp, name: string, arguments_: Record<string, unknown> = {}): Promise<any> {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTHORIZE,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: arguments_ } },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}

async function createProject(t: TestApp, name: string): Promise<{ id: string }> {
  return call(t, "create_project", { name, idempotencyKey: crypto.randomUUID() });
}

describe("A4 AI-first memory contract", () => {
  it("keeps canonical and working cursors independent across capture, review, archive and restore", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 cursors");

    const firstArgs = {
      projectId: project.id,
      outcome: "Working checkpoint is proposal-only.",
      evidenceText: "A4 cursor evidence",
      checkpoint: { summary: "Checkpoint one", nextAction: "Run the focused tests", blockers: [], artifactRefs: ["test:a4"] },
      clientId: "a4",
      sessionId: "cursor",
      idempotencyKey: crypto.randomUUID(),
    };
    const first = await call(t, "capture_work", firstArgs);
    expect(first.contentVersion).toBe(0);
    expect(first.workingMemoryVersion).toBe(1);
    expect(first.checkpoint).toMatchObject({ summary: "Checkpoint one", nextAction: "Run the focused tests" });

    const projectRow = t.app.ck.deps.db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(projectRow.contentVersion).toBe(0);
    expect(projectRow.workingMemoryVersion).toBe(1);
    const stored = t.app.ck.handle.sqlite.prepare("SELECT value_json AS valueJson FROM records WHERE id=?").get(first.outcome.recordId) as { valueJson: string };
    expect(JSON.parse(stored.valueJson)).toMatchObject({ kind: "working_checkpoint", artifactRefs: ["test:a4"] });

    expect(await call(t, "capture_work", firstArgs)).toEqual(first);
    expect((t.app.ck.handle.sqlite.prepare("SELECT working_memory_version AS v FROM projects WHERE id=?").get(project.id) as { v: number }).v).toBe(1);

    const workingContext = await call(t, "get_work_context", { projectId: project.id });
    expect(workingContext.freshness).toMatchObject({ canonicalCursor: 0, workingCursor: 1 });
    expect(workingContext.project).toMatchObject({ contentVersion: 0, workingMemoryVersion: 1 });

    await call(t, "review_records", {
      items: [{ recordId: first.outcome.recordId, revision: first.outcome.revision }],
      action: "accept",
      idempotencyKey: crypto.randomUUID(),
    });
    const afterAccept = t.app.ck.handle.sqlite.prepare("SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number; workingMemoryVersion: number };
    expect(afterAccept.contentVersion).toBe(1);
    expect(afterAccept.workingMemoryVersion).toBe(2);

    const second = await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Recoverable working archive.",
      evidenceText: "Archive and restore evidence",
      clientId: "a4",
      sessionId: "cursor",
      idempotencyKey: crypto.randomUUID(),
    });
    const deleted = await call(t, "delete_record", {
      recordId: second.outcome.recordId,
      revision: second.outcome.revision,
      reason: "A4 archive test",
      idempotencyKey: crypto.randomUUID(),
    });
    expect((t.app.ck.handle.sqlite.prepare("SELECT working_memory_version AS v FROM projects WHERE id=?").get(project.id) as { v: number }).v).toBe(4);
    await call(t, "restore_record", {
      recordId: second.outcome.recordId,
      revision: deleted.revision,
      deletionId: deleted.deletionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect((t.app.ck.handle.sqlite.prepare("SELECT working_memory_version AS v FROM projects WHERE id=?").get(project.id) as { v: number }).v).toBe(5);
  });

  it("searches working memory explicitly and keeps combined result sets separate", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 search scopes");
    await call(t, "add_owner_note", {
      projectId: project.id,
      statement: "Canonical deployment policy is owner-reviewed.",
      recordType: "decision",
      idempotencyKey: crypto.randomUUID(),
    });
    const captured = await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Working deployment observation needs review.",
      evidenceText: "Working deployment observation evidence",
      clientId: "a4",
      sessionId: "search",
      idempotencyKey: crypto.randomUUID(),
    });

    const canonical = await call(t, "search_context", { projectId: project.id, q: "deployment", limit: 10 });
    expect(canonical.scope).toBe("canonical");
    expect(canonical.records).toHaveLength(1);
    expect(canonical.workingRecords).toEqual([]);

    const working = await call(t, "search_context", { projectId: project.id, q: "deployment", scope: "working", limit: 10 });
    expect(working.records).toEqual([]);
    expect(working.workingRecords).toHaveLength(1);
    expect(working.workingRecords[0]).toMatchObject({
      recordId: captured.outcome.recordId,
      memoryStatus: "unreviewed_working_memory",
      truthStatus: "not_canonical_requires_review",
      reviewStatus: "proposed",
      requiresReview: true,
      projectId: project.id,
    });

    const combined = await call(t, "search_context", { projectId: project.id, q: "deployment", scope: "all", limit: 10 });
    expect(combined.records).toHaveLength(1);
    expect(combined.workingRecords).toHaveLength(1);
    expect(combined.records[0].memoryStatus).toBe("canonical_memory");
    expect(combined.workingRecords[0].memoryStatus).toBe("unreviewed_working_memory");
  });

  it("returns task-ranked context with structured checkpoints, staleness and a strict total budget", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 task context");
    await call(t, "add_owner_note", {
      projectId: project.id,
      statement: "Current release is old-release and needs verification.",
      recordType: "fact",
      idempotencyKey: crypto.randomUUID(),
    });
    await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Current release observation is new-release.",
      evidenceText: "Observed current release new-release in the working environment.",
      eventAt: "2030-01-02T00:00:00.000Z",
      checkpoint: { summary: "New release checkpoint", nextAction: "Review the release evidence", blockers: ["Waiting for owner review"], artifactRefs: ["deploy:2030"] },
      clientId: "a4",
      sessionId: "context",
      idempotencyKey: crypto.randomUUID(),
    });

    const context = await call(t, "get_work_context", {
      projectId: project.id,
      task: "release verification",
      totalContextBudgetChars: 6000,
      limitPerSection: 5,
    });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(6000);
    expect(context.task).toBe("release verification");
    expect(context.freshness.canonicalCursor).toBe(1);
    expect(context.freshness.workingCursor).toBe(1);
    expect(context.workingMemory.items[0]).toMatchObject({ requiresReview: true, truthStatus: "not_canonical_requires_review" });
    expect(context.latestCheckpoint.checkpoint).toMatchObject({ nextAction: "Review the release evidence", blockers: ["Waiting for owner review"] });
    expect(context.latestNextAction).toBe("Review the release evidence");
    expect(context.latestBlockers).toContain("Waiting for owner review");
    expect(context.currentState.items[0]).toMatchObject({ stale: true, requiresReview: true, status: "accepted", provenance: "owner_declaration" });
    expect(context.indicators.stale).toBe(true);
  });

  it("keeps semantic selection stable across diagnostics and the supported resume budgets", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 budget parity");
    for (let i = 0; i < 8; i += 1) {
      await call(t, "add_owner_note", {
        projectId: project.id,
        statement: `Canonical decision ${i} ${"preserve semantic resume evidence ".repeat(4)}`,
        recordType: i % 2 === 0 ? "decision" : "constraint",
        idempotencyKey: crypto.randomUUID(),
      });
    }
    for (let i = 0; i < 4; i += 1) {
      await call(t, "add_owner_note", {
        projectId: project.id,
        statement: `Current state fact ${i} current state`,
        recordType: "fact",
        idempotencyKey: crypto.randomUUID(),
      });
    }
    await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Budget parity checkpoint.",
      evidenceText: "Local deterministic checkpoint evidence.",
      checkpoint: {
        summary: `Latest checkpoint ${"retain the operational summary ".repeat(5)}`,
        nextAction: "Continue the bounded local verification.",
        blockers: ["Owner review remains explicit."],
        artifactRefs: ["fixture:budget"],
      },
      clientId: "a4",
      sessionId: "budget-parity",
      idempotencyKey: crypto.randomUUID(),
    });

    for (const budget of [4000, 6000, 9500]) {
      const plain = await call(t, "get_work_context", {
        projectId: project.id,
        task: "current state",
        limitPerSection: 5,
        totalContextBudgetChars: budget,
        diagnostics: false,
      });
      const diagnostic = await call(t, "get_work_context", {
        projectId: project.id,
        task: "current state",
        limitPerSection: 5,
        totalContextBudgetChars: budget,
        diagnostics: true,
      });
      expect(JSON.stringify(plain).length).toBeLessThanOrEqual(budget);
      expect(JSON.stringify(diagnostic).length).toBeLessThanOrEqual(budget);
      for (const section of ["goals", "actions", "constraints", "openQuestions", "facts", "currentState", "recentWork", "workingMemory"]) {
        const ids = (value: any) => (value?.[section]?.items ?? []).map((item: any) => item.recordId);
        expect(ids(diagnostic), `${section} at ${budget}`).toEqual(ids(plain));
      }
      if (budget === 9500) {
        expect(plain.latestCheckpoint.checkpoint.summary).toContain("Latest checkpoint");
        expect(plain.latestNextAction).toBe("Continue the bounded local verification.");
      }
      if (budget >= 6000) {
        expect(plain.facts.items.some((item: any) => item.text?.includes("Current state fact")), JSON.stringify({ budget, facts: plain.facts, currentState: plain.currentState })).toBe(true);
      }
    }
  });

  it("keeps latestCheckpoint chronological even when task ranking prefers an older checkpoint", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 latest checkpoint chronology");

    const older = await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Legacy alpha remediation PR 141 PR 142 Romanian timezone compatibility.",
      evidenceText: "Legacy alpha remediation evidence.",
      eventAt: "2030-01-01T00:00:00.000Z",
      checkpoint: { summary: "Older alpha checkpoint", artifactRefs: ["legacy-alpha"] },
      clientId: "a4",
      sessionId: "latest-checkpoint",
      idempotencyKey: crypto.randomUUID(),
    });
    const newer = await call(t, "capture_work", {
      projectId: project.id,
      outcome: "Final production state is complete.",
      evidenceText: "Final production state evidence.",
      eventAt: "2030-01-02T00:00:00.000Z",
      checkpoint: { summary: "Newest checkpoint", artifactRefs: ["final-state"] },
      clientId: "a4",
      sessionId: "latest-checkpoint",
      idempotencyKey: crypto.randomUUID(),
    });

    t.app.ck.handle.sqlite.prepare("UPDATE records SET recorded_at=? WHERE id=?").run("2030-01-01T00:00:00.000Z", older.outcome.recordId);
    t.app.ck.handle.sqlite.prepare("UPDATE records SET recorded_at=? WHERE id=?").run("2030-01-02T00:00:00.000Z", newer.outcome.recordId);

    const context = await call(t, "get_work_context", {
      projectId: project.id,
      task: "legacy alpha remediation PR 141 PR 142 Romanian timezone compatibility",
      limitPerSection: 5,
    });

    expect(context.recentWork.items[0].recordId).toBe(older.outcome.recordId);
    expect(context.latestCheckpoint.recordId).toBe(newer.outcome.recordId);
    expect(context.latestCheckpoint.checkpoint.summary).toBe("Newest checkpoint");
  });

  it("retains the latest useful checkpoint and unresolved blockers during age-based housekeeping", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = await createProject(t, "A4 retention");
    const capture = async (outcome: string, checkpoint?: Record<string, unknown>) => call(t, "capture_work", {
      projectId: project.id,
      outcome,
      evidenceText: `${outcome} evidence`,
      ...(checkpoint ? { checkpoint } : {}),
      clientId: "a4",
      sessionId: "retention",
      idempotencyKey: crypto.randomUUID(),
    });
    const redundant = await capture("Redundant old work.");
    const blocker = await capture("Unresolved blocker checkpoint.", { summary: "Blocked", blockers: ["Owner decision required"] });
    const latest = await capture("Latest useful checkpoint.", { summary: "Latest", nextAction: "Continue verification" });
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=?, updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", redundant.outcome.recordId);
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=?, updated_at=? WHERE id=?").run("2020-01-02T00:00:00.000Z", "2020-01-02T00:00:00.000Z", blocker.outcome.recordId);
    t.app.ck.handle.sqlite.prepare("UPDATE records SET created_at=?, updated_at=? WHERE id=?").run("2020-01-03T00:00:00.000Z", "2020-01-03T00:00:00.000Z", latest.outcome.recordId);

    const result = runMemoryHousekeeping(t.app.ck.deps, { housekeepingProposalRetentionDays: 30 }, undefined, Date.parse("2030-01-01T00:00:00.000Z"));
    expect(result.archivedRecordIds).toContain(redundant.outcome.recordId);
    expect(result.archivedRecordIds).not.toContain(blocker.outcome.recordId);
    expect(result.archivedRecordIds).not.toContain(latest.outcome.recordId);
    const statuses = t.app.ck.handle.sqlite.prepare("SELECT id, review_status AS status FROM records WHERE id IN (?,?,?) ORDER BY id").all(redundant.outcome.recordId, blocker.outcome.recordId, latest.outcome.recordId) as Array<{ id: string; status: string }>;
    expect(statuses.find((row) => row.id === redundant.outcome.recordId)?.status).toBe("rejected");
    expect(statuses.find((row) => row.id === blocker.outcome.recordId)?.status).toBe("proposed");
    expect(statuses.find((row) => row.id === latest.outcome.recordId)?.status).toBe("proposed");
  });

  it("carries working freshness through portable v3 and keeps backup/schema contracts explicit", async () => {
    const source = await makeTestApp({ mcpToken: TOKEN });
    const target = await makeTestApp({ mcpToken: TOKEN });
    const legacyTarget = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(source, target, legacyTarget);
    const project = await createProject(source, "A4 portable");
    await call(source, "capture_work", {
      projectId: project.id,
      outcome: "Portable working cursor.",
      evidenceText: "Portable cursor evidence",
      clientId: "a4",
      sessionId: "portable",
      idempotencyKey: crypto.randomUUID(),
    });
    const row = source.app.ck.deps.db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(row.workingMemoryVersion).toBe(1);
    const dump = buildPortableJsonDump(source.app.ck.deps, { actor: "test:a4" });
    expect(dump.version).toBe(3);
    expect((dump.projects[0] as { workingMemoryVersion: number }).workingMemoryVersion).toBe(1);
    expect(summarizePortableDump(dump).ok).toBe(true);
    const counters = applyPortableDump(target.app.ck.deps, { dump, mode: "reset", source: "test:a4" }, { actor: "test:a4" });
    expect(counters.blocked).toBe(0);
    const restored = target.app.ck.deps.db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(restored.workingMemoryVersion).toBe(1);
    const columns = target.app.ck.handle.sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "working_memory_version")).toBe(true);
    expect((target.app.ck.handle.sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(16);
    expect(target.app.ck.deps.db.select().from(records).all()).toHaveLength(1);

    const legacyV2 = { ...dump, version: 2 };
    expect(summarizePortableDump(legacyV2).ok).toBe(true);
    const legacyCounters = applyPortableDump(legacyTarget.app.ck.deps, { dump: legacyV2, mode: "reset", source: "test:a4-v2" }, { actor: "test:a4" });
    expect(legacyCounters.blocked).toBe(0);
    expect(legacyTarget.app.ck.deps.db.select().from(records).all()).toHaveLength(1);

    const backup = await createBackup(target.app.ck.handle, target.app.ck.deps, target.config.backupDir, 2, { actor: "test:a4" });
    expect(verifyBackup(backup.file)).toMatchObject({ ok: true, schemaVersion: 16 });
  });

  it("advertises core MCP contracts and current Remote Control naming", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const response = await t.app.inject({ method: "POST", url: "/mcp", headers: AUTHORIZE, payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/list", params: {} } });
    expect(response.statusCode).toBe(200);
    const tools = response.json().result.tools as Array<{ name: string; outputSchema?: unknown }>;
    expect(tools).toHaveLength(35);
    for (const name of ["get_project", "get_work_context", "get_context_delta", "search_context", "capture_work", "get_capabilities"]) {
      expect(tools.find((tool) => tool.name === name)?.outputSchema).toBeTruthy();
    }
    const init = await t.app.inject({ method: "POST", url: "/mcp", headers: AUTHORIZE, payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "a4", version: "1" } } } });
    expect(init.body).toContain("Remote Control MCP");
    expect(init.body).not.toContain("Remote Desktop Commander");
  });
});
