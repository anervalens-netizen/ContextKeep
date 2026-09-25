import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ensureContextCursorBaselines } from "../src/services/context-journal.js";
import { bumpProjectWorkingMemoryVersion } from "../src/services/content-version.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const AUTH = { authorization: "Bearer " + TOKEN, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];

afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function setup(name: string, adapters = "manual,faketest") {
  const t = await makeTestApp({
    mcpToken: TOKEN,
    mcpDefaultClientId: "chatgpt",
    mcpDelegateWorkingMemory: true,
    adapters,
  });
  tracked.push(t);
  const project = (await t.post("/api/projects", { name })).json<{ id: string }>();
  return { t, projectId: project.id };
}

async function callApp(app: TestApp["app"], name: string, args: Record<string, unknown>, expectError = false) {
  const response = await app.inject({
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
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  if (!expectError) expect(body.result?.isError, JSON.stringify(body.result?.structuredContent)).not.toBe(true);
  return body.result as { isError?: boolean; structuredContent: any };
}

async function call(t: TestApp, name: string, args: Record<string, unknown>) {
  return (await callApp(t.app, name, args)).structuredContent;
}

async function cursor(t: TestApp, projectId: string) {
  const context = await call(t, "get_work_context", { projectId });
  return {
    canonicalCursor: context.freshness.canonical.cursor as number,
    workingCursor: context.freshness.working.cursor as number,
    projectRevision: context.project.revision as number,
  };
}

async function delta(
  t: TestApp,
  projectId: string,
  from: { canonicalCursor: number; workingCursor: number; projectRevision: number },
  extra: Record<string, unknown> = {},
) {
  return call(t, "get_context_delta", { projectId, ...from, ...extra });
}

async function resetSnapshot(t: TestApp, projectId: string) {
  const current = await cursor(t, projectId);
  const reset = await delta(t, projectId, {
    canonicalCursor: current.canonicalCursor + 1,
    workingCursor: current.workingCursor,
    projectRevision: current.projectRevision,
  });
  expect(reset.resetRequired).toBe(true);
  expect(reset.resetReason).toBe("cursor_ahead");
  expect(reset.fullSnapshotRequired).toBe(true);
  expect(reset.fullSnapshot).toBeTruthy();
  return { current, snapshot: reset.fullSnapshot };
}

function stableRecord(record: any) {
  const copy = structuredClone(record);
  if (Array.isArray(copy.evidence)) {
    copy.evidence.sort((a: any, b: any) =>
      String(a.excerptId).localeCompare(String(b.excerptId)) ||
      String(a.relation).localeCompare(String(b.relation))
    );
  }
  return copy;
}

function stateFromSnapshot(snapshot: any) {
  return {
    project: structuredClone(snapshot.project),
    canonical: new Map<string, any>(
      snapshot.canonicalRecords.map((record: any) => [record.id, stableRecord(record)]),
    ),
    working: new Map<string, any>(
      snapshot.workingRecords.map((record: any) => [record.id, stableRecord(record)]),
    ),
  };
}

function applyDelta(state: ReturnType<typeof stateFromSnapshot>, page: any) {
  if (page.project) state.project = structuredClone(page.project);
  for (const change of page.changes as any[]) {
    const target = change.scope === "canonical" ? state.canonical : state.working;
    if (change.kind === "remove") target.delete(change.recordId);
    else target.set(change.recordId, stableRecord(change.record));
  }
}

function normalizedState(state: ReturnType<typeof stateFromSnapshot>) {
  const sortMap = (map: Map<string, any>) =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  return {
    project: state.project,
    canonicalRecords: sortMap(state.canonical),
    workingRecords: sortMap(state.working),
  };
}

async function capture(
  t: TestApp,
  projectId: string,
  outcome: string,
  subject: string,
  recordType: "fact" | "action" | "decision" = "fact",
  evidenceText?: string,
  idempotencyKey = crypto.randomUUID(),
) {
  return call(t, "capture_working_memory", {
    projectId,
    outcome,
    subject,
    recordType,
    ...(evidenceText ? { evidenceText } : {}),
    idempotencyKey,
  });
}

async function accept(t: TestApp, recordId: string) {
  const detail = await call(t, "get_record", {
    recordId,
    includeUnreviewed: true,
    evidenceOffset: 0,
    evidenceLimit: 3,
  });
  await call(t, "review_records", {
    items: [{ recordId, revision: detail.revision }],
    action: "accept",
    ownerAction: true,
    idempotencyKey: crypto.randomUUID(),
  });
}

describe("CKR-19 durable context delta", () => {
  it("represents evidence/edit/review/progress/delete/restore/supersede/metadata and converges to the new snapshot", async () => {
    const { t, projectId } = await setup("CKR19 sequence");
    const initial = await resetSnapshot(t, projectId);
    const base = initial.current;
    const applied = stateFromSnapshot(initial.snapshot);

    const created = await capture(t, projectId, "delta working alpha", "delta-main", "fact", "evidence one");
    const mainId = created.outcome.recordId as string;
    const afterCreate = await cursor(t, projectId);

    await capture(t, projectId, "delta working alpha", "delta-main", "fact", "evidence two");
    const afterEvidence = await cursor(t, projectId);
    expect(afterEvidence.workingCursor).toBe(afterCreate.workingCursor + 1);
    const evidenceDelta = await delta(t, projectId, afterCreate);
    expect(evidenceDelta.changes).toHaveLength(1);
    expect(evidenceDelta.changes[0]).toMatchObject({ scope: "working", kind: "upsert", recordId: mainId });
    expect(evidenceDelta.changes[0].record.evidence).toHaveLength(2);

    const detail = await call(t, "get_record", {
      recordId: mainId,
      includeUnreviewed: true,
      evidenceOffset: 0,
      evidenceLimit: 10,
    });
    await call(t, "edit_record", {
      recordId: mainId,
      revision: detail.revision,
      text: "delta working beta",
      idempotencyKey: crypto.randomUUID(),
    });
    const afterEdit = await cursor(t, projectId);
    const editDelta = await delta(t, projectId, afterEvidence);
    expect(editDelta.changes).toHaveLength(1);
    expect(editDelta.changes[0].record.text).toBe("delta working beta");

    await accept(t, mainId);
    const afterAccept = await cursor(t, projectId);
    const acceptDelta = await delta(t, projectId, afterEdit);
    expect(acceptDelta.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "canonical", kind: "upsert", recordId: mainId }),
      expect.objectContaining({ scope: "working", kind: "remove", recordId: mainId }),
    ]));

    const rejected = await capture(t, projectId, "reject this working item", "delta-rejected");
    const rejectedId = rejected.outcome.recordId as string;
    const beforeReject = await cursor(t, projectId);
    await call(t, "review_records", {
      items: [{ recordId: rejectedId, revision: rejected.outcome.revision }],
      action: "reject",
      ownerAction: true,
      idempotencyKey: crypto.randomUUID(),
    });
    const rejectDelta = await delta(t, projectId, beforeReject);
    expect(rejectDelta.changes).toContainEqual(expect.objectContaining({
      scope: "working", kind: "remove", recordId: rejectedId,
    }));

    const action = await capture(t, projectId, "follow delta action", "delta-action", "action");
    const actionId = action.outcome.recordId as string;
    await accept(t, actionId);
    const beforeProgress = await cursor(t, projectId);
    const actionDetail = await call(t, "get_record", {
      recordId: actionId,
      evidenceOffset: 0,
      evidenceLimit: 3,
    });
    await call(t, "edit_record", {
      recordId: actionId,
      revision: actionDetail.revision,
      taskStatus: "done",
      idempotencyKey: crypto.randomUUID(),
    });
    const progressDelta = await delta(t, projectId, beforeProgress);
    const actionChange = progressDelta.changes.find((change: any) => change.recordId === actionId);
    expect(actionChange).toMatchObject({ scope: "canonical", kind: "upsert" });
    expect(actionChange.record.taskStatus).toBe("done");

    const beforeDelete = await cursor(t, projectId);
    const canonicalDetail = await call(t, "get_record", {
      recordId: mainId,
      evidenceOffset: 0,
      evidenceLimit: 3,
    });
    const deleted = await call(t, "delete_record", {
      recordId: mainId,
      revision: canonicalDetail.revision,
      reason: "CKR19 delete probe",
      idempotencyKey: crypto.randomUUID(),
    });
    const deleteDelta = await delta(t, projectId, beforeDelete);
    expect(deleteDelta.changes).toContainEqual(expect.objectContaining({
      scope: "canonical", kind: "remove", recordId: mainId,
    }));

    const beforeRestore = await cursor(t, projectId);
    await call(t, "restore_record", {
      recordId: mainId,
      revision: deleted.revision,
      deletionId: deleted.deletionId,
      ownerAction: true,
      idempotencyKey: crypto.randomUUID(),
    });
    const restoreDelta = await delta(t, projectId, beforeRestore);
    expect(restoreDelta.changes).toContainEqual(expect.objectContaining({
      scope: "canonical", kind: "upsert", recordId: mainId,
    }));

    const beforeCorrection = await cursor(t, projectId);
    const proposal = await call(t, "propose_correction", {
      projectId,
      statement: "delta canonical replacement",
      recordType: "fact",
      subject: "delta-main-v2",
      predicate: null,
      relationObject: null,
      supersedesRecordIds: [mainId],
      idempotencyKey: crypto.randomUUID(),
    });
    await call(t, "confirm_correction", {
      jobId: proposal.jobId,
      idempotencyKey: crypto.randomUUID(),
    });
    const correctionDelta = await delta(t, projectId, beforeCorrection);
    expect(correctionDelta.changes.filter((change: any) => change.scope === "canonical").length).toBeGreaterThanOrEqual(2);
    expect(correctionDelta.changes).toContainEqual(expect.objectContaining({
      scope: "canonical", kind: "upsert", recordId: mainId,
      record: expect.objectContaining({ reviewStatus: "superseded" }),
    }));

    const beforeMetadata = await cursor(t, projectId);
    const project = await call(t, "get_project", { projectId, limit: 1 });
    await call(t, "update_project", {
      projectId,
      revision: project.project.revision,
      description: "CKR19 project metadata delta",
      idempotencyKey: crypto.randomUUID(),
    });
    const metadataDelta = await delta(t, projectId, beforeMetadata);
    expect(metadataDelta.changes).toHaveLength(0);
    expect(metadataDelta.project).toMatchObject({
      id: projectId,
      description: "CKR19 project metadata delta",
    });
    expect(metadataDelta.highWatermark.projectRevision).toBeGreaterThan(beforeMetadata.projectRevision);

    let page = await delta(t, projectId, base, { limit: 2, requestKey: crypto.randomUUID() });
    const allChangeIds = new Set<string>();
    while (true) {
      applyDelta(applied, page);
      for (const change of page.changes) {
        expect(allChangeIds.has(change.changeId)).toBe(false);
        allChangeIds.add(change.changeId);
      }
      if (!page.nextPageToken) break;
      page = await delta(t, projectId, base, { limit: 2, pageToken: page.nextPageToken });
    }

    const target = await resetSnapshot(t, projectId);
    expect(normalizedState(applied)).toEqual({
      project: target.snapshot.project,
      canonicalRecords: target.snapshot.canonicalRecords.map(stableRecord).sort((a: any, b: any) => a.id.localeCompare(b.id)),
      workingRecords: target.snapshot.workingRecords.map(stableRecord).sort((a: any, b: any) => a.id.localeCompare(b.id)),
    });
    expect(page.highWatermark).toEqual(target.current);
  }, 30000);

  it("pins pagination high-watermark across concurrent writes and makes requestKey/page retries exact", async () => {
    const { t, projectId } = await setup("CKR19 pagination");
    const base = await cursor(t, projectId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const captured = await capture(t, projectId, "page item " + i, "page-" + i);
      ids.push(captured.outcome.recordId as string);
    }

    const requestKey = crypto.randomUUID();
    const first = await delta(t, projectId, base, { limit: 1, requestKey });
    expect(first.changes).toHaveLength(1);
    expect(first.nextPageToken).toBeTruthy();
    const pinned = structuredClone(first.highWatermark);

    const concurrent = await capture(t, projectId, "concurrent item", "page-concurrent");
    const concurrentId = concurrent.outcome.recordId as string;

    const replay = await delta(t, projectId, base, { limit: 1, requestKey });
    expect(replay.sessionId).toBe(first.sessionId);
    expect(replay.highWatermark).toEqual(pinned);
    expect(replay.changes).toEqual(first.changes);

    const collected = [...first.changes];
    const seen = new Set(first.changes.map((change: any) => change.changeId));
    let token = first.nextPageToken;
    while (token) {
      const page = await delta(t, projectId, base, { limit: 1, pageToken: token });
      const retry = await delta(t, projectId, base, { limit: 1, pageToken: token });
      expect(retry.changes).toEqual(page.changes);
      expect(retry.highWatermark).toEqual(pinned);
      for (const change of page.changes) {
        expect(seen.has(change.changeId)).toBe(false);
        seen.add(change.changeId);
        collected.push(change);
      }
      token = page.nextPageToken;
    }
    expect(new Set(collected.map((change: any) => change.recordId))).toEqual(new Set(ids));
    expect(collected.some((change: any) => change.recordId === concurrentId)).toBe(false);

    const fresh = await delta(t, projectId, pinned, { limit: 10, requestKey: crypto.randomUUID() });
    expect(fresh.changes).toHaveLength(1);
    expect(fresh.changes[0]).toMatchObject({ scope: "working", kind: "upsert", recordId: concurrentId });

    const keyReuse = await callApp(t.app, "get_context_delta", {
      projectId,
      canonicalCursor: base.canonicalCursor,
      workingCursor: base.workingCursor + 1,
      projectRevision: base.projectRevision,
      limit: 1,
      requestKey,
    }, true);
    expect(keyReuse.isError).toBe(true);
    expect(keyReuse.structuredContent.error.code).toBe("context_delta_request_key_reused");
  });

  it("survives restart, rolls mutation+journal+cursor back together and does not duplicate idempotent writes", async () => {
    const { t, projectId } = await setup("CKR19 restart rollback");
    const base = await cursor(t, projectId);
    const key = crypto.randomUUID();
    const firstCapture = await capture(t, projectId, "idempotent delta", "idem-delta", "fact", "idem evidence", key);
    const afterFirst = await cursor(t, projectId);
    const replayCapture = await capture(t, projectId, "idempotent delta", "idem-delta", "fact", "idem evidence", key);
    const afterReplay = await cursor(t, projectId);
    expect(replayCapture.outcome.recordId).toBe(firstCapture.outcome.recordId);
    expect(afterReplay).toEqual(afterFirst);

    await capture(t, projectId, "second restart item", "restart-second");
    const firstPage = await delta(t, projectId, base, { limit: 1, requestKey: crypto.randomUUID() });
    expect(firstPage.nextPageToken).toBeTruthy();

    const beforeRollback = await cursor(t, projectId);
    const snapshotCountBefore = (t.app.ck.deps.sqlite.prepare(
      "SELECT count(*) AS n FROM context_cursor_snapshots WHERE project_id=?",
    ).get(projectId) as { n: number }).n;
    const doomedId = crypto.randomUUID();
    const transaction = t.app.ck.deps.sqlite.transaction(() => {
      const now = "2026-09-21T20:00:00.000Z";
      t.app.ck.deps.sqlite.prepare(
        "INSERT INTO records(id,project_id,type,subject,text,review_status,evidence_basis,record_dedup_hash,recorded_at,volatile,revision,created_at,updated_at) VALUES(?,?,?,?,?,'proposed','agent_report',?,?,0,1,?,?)",
      ).run(doomedId, projectId, "fact", "rollback", "rollback", "rollback-hash-" + doomedId, now, now, now);
      bumpProjectWorkingMemoryVersion(t.app.ck.deps.db, [projectId]);
      throw new Error("rollback probe");
    });
    expect(() => transaction()).toThrow("rollback probe");
    expect(t.app.ck.deps.sqlite.prepare("SELECT 1 FROM records WHERE id=?").get(doomedId)).toBeUndefined();
    expect(await cursor(t, projectId)).toEqual(beforeRollback);
    const snapshotCountAfter = (t.app.ck.deps.sqlite.prepare(
      "SELECT count(*) AS n FROM context_cursor_snapshots WHERE project_id=?",
    ).get(projectId) as { n: number }).n;
    expect(snapshotCountAfter).toBe(snapshotCountBefore);

    await t.app.close();
    const restarted = await buildApp({ config: t.config, logger: false });
    try {
      const page = (await callApp(restarted, "get_context_delta", {
        projectId,
        canonicalCursor: base.canonicalCursor,
        workingCursor: base.workingCursor,
        projectRevision: base.projectRevision,
        limit: 1,
        pageToken: firstPage.nextPageToken,
      })).structuredContent;
      expect(page.resetRequired).toBe(false);
      expect(page.sessionId).toBe(firstPage.sessionId);
    } finally {
      await restarted.close();
    }
  }, 30000);

  it("returns explicit resets for history gaps, expired pages and restored older stores", async () => {
    const { t, projectId } = await setup("CKR19 resets");
    const base = await cursor(t, projectId);
    await capture(t, projectId, "reset one", "reset-one");
    const afterOne = await cursor(t, projectId);
    await capture(t, projectId, "reset two", "reset-two");
    const afterTwo = await cursor(t, projectId);

    t.app.ck.deps.sqlite.prepare(
      "DELETE FROM context_cursor_snapshots WHERE project_id=? AND scope='working' AND cursor=?",
    ).run(projectId, afterOne.workingCursor);
    const expired = await delta(t, projectId, afterOne);
    expect(expired).toMatchObject({
      resetRequired: true,
      fullSnapshotRequired: true,
      resetReason: "cursor_expired",
    });
    expect(expired.fullSnapshot.workingRecords.length).toBe(2);

    t.app.ck.deps.sqlite.prepare("DELETE FROM context_cursor_snapshots WHERE project_id=?").run(projectId);
    ensureContextCursorBaselines(t.app.ck.deps.db);
    const unavailable = await delta(t, projectId, base);
    expect(unavailable).toMatchObject({
      resetRequired: true,
      fullSnapshotRequired: true,
      resetReason: "history_unavailable",
    });

    const pageBase = await cursor(t, projectId);
    await capture(t, projectId, "page expired one", "page-expired-one");
    await capture(t, projectId, "page expired two", "page-expired-two");
    const paged = await delta(t, projectId, pageBase, { limit: 1, requestKey: crypto.randomUUID() });
    expect(paged.nextPageToken).toBeTruthy();
    t.app.ck.deps.sqlite.prepare("DELETE FROM context_delta_sessions WHERE id=?").run(paged.sessionId);
    const pageExpired = await delta(t, projectId, pageBase, { limit: 1, pageToken: paged.nextPageToken });
    expect(pageExpired).toMatchObject({
      resetRequired: true,
      fullSnapshotRequired: true,
      resetReason: "page_expired",
    });

    const oldPath = path.join(path.dirname(t.config.dbPath), "old-store.sqlite");
    await t.app.ck.deps.sqlite.backup(oldPath);
    await capture(t, projectId, "newer than backup", "newer-than-backup");
    const newerClient = await cursor(t, projectId);
    const oldApp = await buildApp({ config: t.config, dbPath: oldPath, logger: false });
    try {
      const restoredOlder = (await callApp(oldApp, "get_context_delta", {
        projectId,
        canonicalCursor: newerClient.canonicalCursor,
        workingCursor: newerClient.workingCursor,
        projectRevision: newerClient.projectRevision,
        limit: 10,
        pageToken: null,
        requestKey: null,
      })).structuredContent;
      expect(restoredOlder).toMatchObject({
        resetRequired: true,
        fullSnapshotRequired: true,
        resetReason: "cursor_ahead",
      });
    } finally {
      await oldApp.close();
    }

    expect(afterTwo.workingCursor).toBeGreaterThan(afterOne.workingCursor);
  }, 30000);

  it("advances working cursor for existing-source agent extraction and materially reduces incremental bytes", async () => {
    const { t, projectId } = await setup("CKR19 extraction bytes");

    const seedIds: Array<{ recordId: string; revision: number }> = [];
    for (let i = 0; i < 10; i += 1) {
      const captured = await capture(
        t,
        projectId,
        "long canonical seed " + i + " " + "x".repeat(500),
        "seed-" + i,
      );
      seedIds.push({ recordId: captured.outcome.recordId, revision: captured.outcome.revision });
    }
    await call(t, "review_records", {
      items: seedIds,
      action: "accept",
      ownerAction: true,
      idempotencyKey: crypto.randomUUID(),
    });
    const baseline = await cursor(t, projectId);

    const imported = await t.post("/api/imports/text", {
      text: "decision: extracted working delta",
      kind: "paste",
      title: "CKR19 extraction source",
      projectId,
      adapterId: "manual",
      eventAt: "2026-09-21T18:00:00.000Z",
      authorLabel: "ckr19",
      confirmNearDuplicateOf: null,
    });
    expect(imported.statusCode).toBe(201);
    const sourceId = imported.json<any>().source.id as string;
    const beforeExtraction = await cursor(t, projectId);
    const extracted = await t.post("/api/sources/" + sourceId + "/extract", { adapterId: "faketest" });
    expect(extracted.statusCode).toBe(200);
    const afterExtraction = await cursor(t, projectId);
    expect(afterExtraction.workingCursor).toBe(beforeExtraction.workingCursor + 1);

    const extractionDelta = await delta(t, projectId, beforeExtraction);
    expect(extractionDelta.changes).toHaveLength(1);
    expect(extractionDelta.changes[0]).toMatchObject({
      scope: "working",
      kind: "upsert",
      record: expect.objectContaining({ subject: "faketest-decision", evidenceBasis: "agent_report" }),
    });

    const incremental = await delta(t, projectId, baseline, { limit: 100, requestKey: crypto.randomUUID() });
    const target = await resetSnapshot(t, projectId);
    const deltaBytes = JSON.stringify(incremental).length;
    const snapshotBytes = JSON.stringify(target.snapshot).length;
    console.log("CKR19_BYTES " + JSON.stringify({ deltaBytes, snapshotBytes, ratio: deltaBytes / snapshotBytes }));
    expect(deltaBytes).toBeLessThan(snapshotBytes * 0.5);
  }, 30000);
});


describe("CK-A09 delta byte paging", () => {
  it("bounds serialized change pages and still converges across a large evidence corpus", async () => {
    const { t, projectId } = await setup("CK-A09 delta bytes");
    const base = await cursor(t, projectId);
    const ids: string[] = [];
    const evidenceText = "e".repeat(32_000);

    for (let i = 0; i < 20; i++) {
      const created = await capture(
        t,
        projectId,
        `large delta outcome ${i}`,
        `a09-large-${i}`,
        "fact",
        `${evidenceText}-${i}`,
      );
      ids.push(created.outcome.recordId as string);
    }

    const seen = new Set<string>();
    let page = await delta(t, projectId, base, { limit: 100 });
    let pages = 0;
    while (true) {
      pages += 1;
      expect(Buffer.byteLength(JSON.stringify(page.changes), "utf8")).toBeLessThanOrEqual(425_000);
      for (const change of page.changes as any[]) seen.add(change.recordId);
      if (!page.nextPageToken) break;
      page = await delta(t, projectId, base, { limit: 100, pageToken: page.nextPageToken });
    }

    expect(pages).toBeGreaterThan(1);
    expect([...seen].sort()).toEqual([...ids].sort());
  }, 30_000);

  it("never drops a single oversized change even when it exceeds the normal page byte budget", async () => {
    const { t, projectId } = await setup("CK-A09 delta oversized");
    const base = await cursor(t, projectId);
    const created = await capture(
      t,
      projectId,
      "oversized delta outcome",
      "a09-oversized",
      "fact",
      "x".repeat(63_000),
    );

    const page = await delta(t, projectId, base, { limit: 100 });
    expect(page.changes.some((change: any) => change.recordId === created.outcome.recordId)).toBe(true);
  });
});
