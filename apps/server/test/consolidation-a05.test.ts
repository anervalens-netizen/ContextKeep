import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyRecordFreshness,
  stateRelationship,
  type FreshnessRecord,
} from "../src/services/memory-freshness.js";
import { projects, records } from "../src/db/schema.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

function row(overrides: Partial<FreshnessRecord> = {}): FreshnessRecord {
  return {
    id: crypto.randomUUID(),
    projectId: "00000000-0000-4000-8000-000000000001",
    type: "fact",
    subject: "backend api",
    predicate: "status",
    valueJson: null,
    text: "Backend API status is healthy.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
    sourceEventAt: "2026-01-01T00:00:00.000Z",
    effectiveFrom: null,
    effectiveTo: null,
    reviewDueAt: null,
    volatile: false,
    ...overrides,
  };
}

async function mcpCall(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { isError?: boolean; structuredContent: any };
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent;
}

describe("CK-A05 pure record freshness semantics", () => {
  const nowIso = "2026-09-23T09:00:00.000Z";

  it("keeps stable old facts, overdue facts, blocked actions and proposals semantically distinct", () => {
    const stable = classifyRecordFreshness(
      row({ sourceEventAt: "2020-01-01T00:00:00.000Z", volatile: false }),
      { nowIso },
    );
    expect(stable).toMatchObject({
      authority: "canonical",
      currentness: "current",
      stale: false,
      requiresReview: false,
    });

    const overdue = classifyRecordFreshness(
      row({
        volatile: true,
        reviewDueAt: "2026-01-01T00:00:00.000Z",
      }),
      { nowIso },
    );
    expect(overdue).toMatchObject({
      authority: "canonical",
      currentness: "review_due",
      stale: true,
      requiresReview: true,
      reasons: ["review_overdue"],
    });

    const blocked = classifyRecordFreshness(
      row({
        type: "action",
        subject: "deploy action",
        predicate: null,
        text: "Deploy only after owner approval.",
        taskStatus: "blocked",
        sourceEventAt: null,
      }),
      { nowIso },
    );
    expect(blocked).toMatchObject({
      authority: "canonical",
      currentness: "not_applicable",
      progress: "blocked",
      stale: false,
      requiresReview: false,
    });

    const proposed = classifyRecordFreshness(
      row({
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
        sourceEventAt: null,
      }),
      { nowIso },
    );
    expect(proposed).toMatchObject({
      authority: "working",
      currentness: "unknown",
      stale: false,
      requiresReview: true,
      reasons: ["unreviewed_proposal"],
    });
  });

  it("distinguishes explicit conflict, future/expired effective intervals and unknown observation time", () => {
    const conflictId = crypto.randomUUID();
    const canonical = row({ id: crypto.randomUUID() });
    const conflict = classifyRecordFreshness(canonical, {
      nowIso,
      conflicts: [{ recordIds: [canonical.id, conflictId] }],
    });
    expect(conflict).toMatchObject({
      currentness: "conflicted",
      stale: true,
      requiresReview: true,
      reasons: ["explicit_conflict"],
      supportRecordIds: [conflictId],
    });

    const future = classifyRecordFreshness(
      row({ effectiveFrom: "2027-01-01T00:00:00.000Z" }),
      { nowIso },
    );
    expect(future).toMatchObject({
      currentness: "future_effective",
      stale: false,
      requiresReview: false,
      reasons: ["effective_not_started"],
    });

    const expired = classifyRecordFreshness(
      row({ effectiveTo: "2026-01-01T00:00:00.000Z" }),
      { nowIso },
    );
    expect(expired).toMatchObject({
      currentness: "expired",
      stale: true,
      requiresReview: false,
      reasons: ["effective_ended"],
    });

    const unknown = classifyRecordFreshness(
      row({ sourceEventAt: null, effectiveFrom: null }),
      { nowIso },
    );
    expect(unknown).toMatchObject({
      currentness: "unknown",
      stale: false,
      reasons: ["observation_time_unknown"],
    });
  });

  it("treats weak newer lexical overlap as possible review signal, not confirmed staleness", () => {
    const accepted = row({
      subject: "serviciu plăți status",
      text: "Serviciul de plăți este activ în producție.",
      sourceEventAt: "2026-01-01T00:00:00.000Z",
    });
    const weak = row({
      id: crypto.randomUUID(),
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      subject: "serviciu email status",
      text: "Serviciul email este activ în producție.",
      sourceEventAt: "2026-02-01T00:00:00.000Z",
    });

    expect(stateRelationship(accepted, weak)).toBe("possibly_related");
    expect(classifyRecordFreshness(accepted, { nowIso, workingRecords: [weak] })).toMatchObject({
      authority: "canonical",
      currentness: "needs_verification",
      stale: false,
      requiresReview: true,
      reasons: ["possibly_newer_observation"],
      supportRecordIds: [],
      possiblyRelatedRecordIds: [weak.id],
    });
  });

  it("treats capture-time-only recency as verification evidence, not confirmed staleness", () => {
    const accepted = row({
      sourceEventAt: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    const working = row({
      id: crypto.randomUUID(),
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      sourceEventAt: null,
      recordedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(classifyRecordFreshness(accepted, { nowIso, workingRecords: [working] })).toMatchObject({
      currentness: "needs_verification",
      stale: false,
      requiresReview: true,
      reasons: ["possibly_newer_observation"],
      supportRecordIds: [],
      possiblyRelatedRecordIds: [working.id],
    });
  });

  it("does not promote generic RO/EN overlap to confirmed same-entity identity", () => {
    const payments = row({
      subject: "serviciu plăți status",
      text: "Serviciul de plăți este activ în producție.",
      sourceEventAt: "2026-01-01T00:00:00.000Z",
    });
    const mail = row({
      id: crypto.randomUUID(),
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      subject: "serviciu email status",
      text: "Serviciul email este activ în producție.",
      sourceEventAt: "2026-02-01T00:00:00.000Z",
    });
    expect(stateRelationship(payments, mail)).not.toBe("same_entity");

    const exact = row({
      id: crypto.randomUUID(),
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      subject: payments.subject,
      text: "Serviciul de plăți are un status nou.",
      sourceEventAt: "2026-02-01T00:00:00.000Z",
    });
    expect(stateRelationship(payments, exact)).toBe("same_entity");
  });
});

describe("CK-A05 context/search/REST parity", () => {
  it("classifies one accepted current-state record identically across all read surfaces", async () => {
    const t = await makeTestApp({ mcpToken: TOKEN });
    tracked.push(t);
    const project = (await t.post("/api/projects", { name: "A05 freshness parity" })).json<{ id: string }>();

    const acceptedId = crypto.randomUUID();
    const workingId = crypto.randomUUID();
    const now = "2026-09-23T09:00:00.000Z";
    const insert = t.app.ck.deps.db.insert(records);

    insert.values({
      id: acceptedId,
      projectId: project.id,
      type: "fact",
      subject: "backend api",
      predicate: "status",
      valueJson: null,
      text: "Backend API status is healthy.",
      reviewStatus: "accepted",
      evidenceBasis: "document",
      taskStatus: null,
      recordDedupHash: crypto.randomUUID(),
      recordedAt: "2026-01-01T00:00:00.000Z",
      sourceEventAt: "2026-01-01T00:00:00.000Z",
      effectiveFrom: null,
      effectiveTo: null,
      reviewedAt: "2026-01-01T00:00:00.000Z",
      reviewDueAt: null,
      volatile: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).run();

    insert.values({
      id: workingId,
      projectId: project.id,
      type: "fact",
      subject: "backend api",
      predicate: "status",
      valueJson: null,
      text: "Backend API status now reports degraded.",
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      taskStatus: null,
      recordDedupHash: crypto.randomUUID(),
      recordedAt: "2026-02-01T00:00:00.000Z",
      sourceEventAt: "2026-02-01T00:00:00.000Z",
      effectiveFrom: null,
      effectiveTo: null,
      reviewedAt: null,
      reviewDueAt: null,
      volatile: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).run();

    t.app.ck.deps.db
      .update(projects)
      .set({ contentVersion: 1, workingMemoryVersion: 1 })
      .where((await import("drizzle-orm")).eq(projects.id, project.id))
      .run();

    const context = await mcpCall(t, "get_work_context", {
      projectId: project.id,
      task: "backend api status",
      limitPerSection: 10,
      totalContextBudgetChars: 30_000,
    });
    const contextRecord = context.facts.items.find((item: any) => item.recordId === acceptedId);
    expect(contextRecord).toBeTruthy();

    const mcpSearch = await mcpCall(t, "search_context", {
      projectId: project.id,
      q: "backend api status",
      scope: "all",
      limit: 10,
    });
    const directRecord = await mcpCall(t, "get_record", {
      recordId: acceptedId,
      includeUnreviewed: false,
      evidenceOffset: 0,
      evidenceLimit: 3,
    });
    const mcpRecord = mcpSearch.records.find((item: any) => item.recordId === acceptedId);
    expect(mcpRecord).toBeTruthy();

    const rest = await t.get(
      `/api/search?q=${encodeURIComponent("backend api status")}&scope=all&projectId=${project.id}&limit=10`,
    );
    expect(rest.statusCode).toBe(200);
    const restRecord = rest.json<any>().records.find((item: any) => item.id === acceptedId);
    expect(restRecord).toBeTruthy();

    expect(contextRecord.freshness).toEqual(mcpRecord.freshness);
    expect(restRecord.freshness).toEqual(mcpRecord.freshness);
    expect(directRecord.freshness).toEqual(mcpRecord.freshness);
    expect(mcpRecord.freshness).toMatchObject({
      authority: "canonical",
      currentness: "needs_verification",
      stale: true,
      requiresReview: true,
      reasons: ["newer_observation"],
      supportRecordIds: [workingId],
    });

    const working = mcpSearch.workingRecords.find((item: any) => item.recordId === workingId);
    expect(working.freshness).toMatchObject({
      authority: "working",
      currentness: "unknown",
      stale: false,
      requiresReview: true,
    });
  });

  it("does not mark a project stale merely because it has an active blocker", async () => {
    const t = await makeTestApp({
      mcpToken: TOKEN,
      mcpDefaultClientId: "chatgpt",
      mcpDelegateWorkingMemory: true,
    });
    tracked.push(t);
    const project = (await t.post("/api/projects", { name: "A05 blocker semantics" })).json<{ id: string }>();

    await mcpCall(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Waiting on an external dependency.",
      checkpoint: {
        summary: "Blocked but canonical truth is not stale.",
        blockers: ["External dependency pending"],
        artifactRefs: [],
      },
      idempotencyKey: crypto.randomUUID(),
    });

    const context = await mcpCall(t, "get_work_context", {
      projectId: project.id,
      totalContextBudgetChars: 20_000,
    });
    expect(context.blockerState.activeCount).toBe(1);
    expect(context.indicators.blocked).toBe(true);
    expect(context.indicators.stale).toBe(false);
  });
});
