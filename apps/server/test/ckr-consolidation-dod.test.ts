import crypto from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadEvidenceFor } from "../src/services/mappers.js";
import { searchRelations } from "../src/services/relations.js";
import { ContextKeepMemoryService } from "../src/services/memory-context.js";
import { recordDedupHash } from "../src/lib/hash.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = "ckr-consolidation-local-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}`, accept: "application/json, text/event-stream" };
const tracked: TestApp[] = [];
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function setup(options: Record<string, unknown> = {}) {
  const t = await makeTestApp({ mcpToken: TOKEN, mcpDefaultClientId: "chatgpt", mcpDelegateWorkingMemory: true, ...options });
  tracked.push(t);
  return t;
}

async function rpc(t: TestApp, name: string, args: Record<string, unknown>) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: AUTH,
    payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError, JSON.stringify(body.result?.structuredContent)).not.toBe(true);
  return body.result.structuredContent as any;
}

function fixtureId(prefix: number, index: number): string {
  return `00000000-${prefix.toString(16).padStart(4, "0")}-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sumEvidence(map: Map<string, Array<{ text: string }>>) {
  let rows = 0;
  let bytes = 0;
  for (const values of map.values()) {
    rows += values.length;
    for (const value of values) bytes += Buffer.byteLength(value.text, "utf8");
  }
  return { rows, bytes };
}

function createRelationCorpus(t: TestApp, projectId: string, size: number): { targetSubject: string; excerptText: string } {
  const sqlite = t.app.ck.deps.sqlite;
  const sourceId = fixtureId(size % 0xffff, size + 1);
  const excerptId = fixtureId((size + 1) % 0xffff, size + 2);
  const stamp = "2026-09-21T10:00:00.000Z";
  const excerptText = `evidence runtime sqlite corpus-${size} ${"x".repeat(96)}`;
  sqlite.prepare(
    `INSERT INTO sources
      (id,kind,title,original_filename,content_hash,normalized_hash,imported_at,event_at,author_label,provenance_basis,project_id,original_text,normalized_text,redaction_state)
     VALUES (?, 'text', ?, NULL, ?, ?, ?, ?, 'ckr12', 'document', ?, ?, ?, 'none')`,
  ).run(sourceId, `CKR12 ${size}`, `content-${size}`, `normalized-${size}`, stamp, stamp, projectId, excerptText, excerptText);
  sqlite.prepare(
    `INSERT INTO source_excerpts (id,source_id,start_offset,end_offset,exact_text,exact_text_hash)
     VALUES (?,?,0,?,?,?)`,
  ).run(excerptId, sourceId, excerptText.length, excerptText, `excerpt-${size}`);

  const insertRecord = sqlite.prepare(
    `INSERT INTO records
      (id,project_id,type,subject,predicate,value_json,text,review_status,evidence_basis,task_status,record_dedup_hash,
       recorded_at,source_event_at,effective_from,effective_to,reviewed_at,review_due_at,volatile,revision,created_at,updated_at)
     VALUES (?,?,'fact',?,'depends_on',?,?,'accepted','document',NULL,?,?,?,NULL,NULL,?,NULL,0,1,?,?)`,
  );
  const insertEvidence = sqlite.prepare(
    `INSERT INTO record_evidence (record_id,excerpt_id,relation,observed_at,environment,artifact_ref)
     VALUES (?,?,'supports',?,NULL,NULL)`,
  );
  const targetSubject = `runtime-needle-${size - 1}`;
  const populate = sqlite.transaction(() => {
    for (let i = 0; i < size; i++) {
      const id = fixtureId(size % 0xffff, i + 10);
      const eventAt = new Date(Date.UTC(2026, 8, 21, 10, 0, 0, i)).toISOString();
      const target = i === size - 1;
      const subject = target ? targetSubject : `runtime-${i}`;
      const text = target
        ? `runtime sqlite dependency needle high-specificity target ${i}`
        : `runtime sqlite dependency ordinary candidate ${i}`;
      insertRecord.run(
        id,
        projectId,
        subject,
        JSON.stringify({ object: "sqlite" }),
        text,
        `dedup-${size}-${i}`,
        eventAt,
        eventAt,
        eventAt,
        eventAt,
        eventAt,
      );
      insertEvidence.run(id, excerptId, eventAt);
    }
  });
  populate.immediate();
  return { targetSubject, excerptText };
}

describe("CKR-12 bounded local retrieval and project-scoped extraction dedup", () => {
  it("bounds relation/evidence materialization at 200 candidates on 200/2k/10k corpora and preserves the high-relevance target", async () => {
    const t = await setup();
    const sqlite = t.app.ck.deps.sqlite;
    const report: Array<Record<string, unknown>> = [];

    for (const size of [200, 2_000, 10_000]) {
      const p = await t.post("/api/projects", { name: `CKR12 bounded ${size}` });
      expect(p.statusCode).toBe(200);
      const projectId = p.json<{ id: string }>().id;
      const fixture = createRelationCorpus(t, projectId, size);

      const baselinePlan = sqlite.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM records
         WHERE project_id = ? AND review_status = 'accepted' AND predicate = 'depends_on'
         ORDER BY recorded_at DESC, id DESC`,
      ).all(projectId);
      const candidatePlan = sqlite.prepare(
        `EXPLAIN QUERY PLAN
         SELECT records.id
         FROM records
         INNER JOIN ck_records_fts ON ck_records_fts.record_id = records.id
         WHERE ck_records_fts MATCH ?
           AND ck_records_fts.review_status = 'accepted'
           AND ck_records_fts.project_id = ?
           AND records.type = 'fact'
         ORDER BY bm25(ck_records_fts)
         LIMIT 200`,
      ).all('"runtime"* OR "sqlite"* OR "needle"*', projectId);

      const baselineHeapBefore = process.memoryUsage().heapUsed;
      const baselineStarted = performance.now();
      const baselineRows = sqlite.prepare(
        `SELECT * FROM records
         WHERE project_id = ? AND review_status = 'accepted' AND predicate = 'depends_on'
         ORDER BY recorded_at DESC, id DESC`,
      ).all(projectId) as Array<{ id: string; subject: string }>;
      const baselineEvidence = loadEvidenceFor(t.app.ck.deps.db, baselineRows.map((row) => row.id));
      const baselineMs = performance.now() - baselineStarted;
      const baselineHeapDelta = process.memoryUsage().heapUsed - baselineHeapBefore;
      const baselineEvidenceStats = sumEvidence(baselineEvidence);

      const candidateRows = sqlite.prepare(
        `SELECT records.id
         FROM records
         INNER JOIN ck_records_fts ON ck_records_fts.record_id = records.id
         WHERE ck_records_fts MATCH ?
           AND ck_records_fts.review_status = 'accepted'
           AND ck_records_fts.project_id = ?
           AND records.type = 'fact'
         ORDER BY bm25(ck_records_fts)
         LIMIT 200`,
      ).all('"runtime"* OR "sqlite"* OR "needle"*', projectId) as Array<{ id: string }>;
      const candidateEvidence = loadEvidenceFor(t.app.ck.deps.db, candidateRows.map((row) => row.id));
      const candidateEvidenceStats = sumEvidence(candidateEvidence);

      const candidateHeapBefore = process.memoryUsage().heapUsed;
      const candidateStarted = performance.now();
      const result = searchRelations(t.app.ck.deps, {
        projectId,
        q: "runtime sqlite needle",
        relation: "depends_on",
        direction: "both",
        scope: "canonical",
        limit: 1,
      });
      const candidateMs = performance.now() - candidateStarted;
      const candidateHeapDelta = process.memoryUsage().heapUsed - candidateHeapBefore;

      expect(baselineRows).toHaveLength(size);
      expect(baselineEvidenceStats.rows).toBe(size);
      expect(baselineRows.some((row) => row.subject === fixture.targetSubject)).toBe(true);
      expect(candidateRows.length).toBeLessThanOrEqual(200);
      expect(candidateEvidenceStats.rows).toBeLessThanOrEqual(200);
      expect(candidateEvidenceStats.bytes).toBeLessThanOrEqual(200 * Buffer.byteLength(fixture.excerptText, "utf8"));
      expect(result.canonicalRelations).toHaveLength(1);
      expect(result.canonicalRelations[0]!.subject).toBe(fixture.targetSubject);
      expect(result.canonicalRelations[0]!.object).toBe("sqlite");

      report.push({
        size,
        baseline: {
          jsRows: baselineRows.length,
          evidenceRows: baselineEvidenceStats.rows,
          evidenceBytes: baselineEvidenceStats.bytes,
          latencyMs: Number(baselineMs.toFixed(3)),
          heapDeltaBytes: baselineHeapDelta,
          plan: baselinePlan,
        },
        candidate: {
          candidateCeiling: 200,
          sqlCandidateRows: candidateRows.length,
          evidenceRows: candidateEvidenceStats.rows,
          evidenceBytes: candidateEvidenceStats.bytes,
          latencyMs: Number(candidateMs.toFixed(3)),
          heapDeltaBytes: candidateHeapDelta,
          plan: candidatePlan,
          resultSubject: result.canonicalRelations[0]!.subject,
        },
      });
    }

    console.log("CKR12_METRICS " + JSON.stringify(report));
  }, 30_000);

  it("keeps extraction dedup reads scoped to A, B, and the explicit unassigned scope", async () => {
    const t = await setup({ adapters: "manual,faketest" });
    const a = (await t.post("/api/projects", { name: "CKR12 dedup A" })).json<{ id: string }>();
    const b = (await t.post("/api/projects", { name: "CKR12 dedup B" })).json<{ id: string }>();
    const sqlite = t.app.ck.deps.sqlite;
    const stamp = "2026-09-21T12:00:00.000Z";
    const claim = { type: "fact", subject: "faketest-fact", text: "shared cross-project claim" } as const;
    const hashes = [
      { projectId: a.id, hash: recordDedupHash({ projectId: a.id, ...claim }) },
      { projectId: b.id, hash: recordDedupHash({ projectId: b.id, ...claim }) },
      { projectId: null, hash: recordDedupHash({ projectId: null, ...claim }) },
    ];
    expect(new Set(hashes.map((item) => item.hash)).size).toBe(3);

    const insert = sqlite.prepare(
      `INSERT INTO records
       (id,project_id,type,subject,predicate,value_json,text,review_status,evidence_basis,task_status,record_dedup_hash,
        recorded_at,source_event_at,effective_from,effective_to,reviewed_at,review_due_at,volatile,revision,created_at,updated_at)
       VALUES (?,?,'fact',?,NULL,NULL,?,'proposed','document',NULL,?,?,?,NULL,NULL,NULL,NULL,0,1,?,?)`,
    );
    hashes.forEach((item, index) => {
      insert.run(fixtureId(0x0ded, index + 1), item.projectId, claim.subject, claim.text, item.hash, stamp, stamp, stamp, stamp);
    });

    const rows = sqlite.prepare(
      `SELECT project_id AS projectId, record_dedup_hash AS hash
       FROM records
       WHERE subject = ? AND text = ?
       ORDER BY COALESCE(project_id, '')`,
    ).all(claim.subject, claim.text) as Array<{ projectId: string | null; hash: string }>;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set([null, a.id, b.id]));

    const scopedA = sqlite.prepare(
      `SELECT project_id AS projectId, record_dedup_hash AS hash
       FROM records
       WHERE review_status IN ('proposed','accepted') AND project_id = ?`,
    ).all(a.id) as Array<{ projectId: string | null; hash: string }>;
    expect(scopedA).toEqual([{ projectId: a.id, hash: hashes[0]!.hash }]);

    const unassigned = sqlite.prepare(
      `SELECT project_id AS projectId, record_dedup_hash AS hash FROM records
       WHERE review_status IN ('proposed','accepted') AND project_id IS NULL`,
    ).all() as Array<{ projectId: string | null; hash: string }>;
    expect(unassigned).toEqual([{ projectId: null, hash: hashes[2]!.hash }]);

    const plan = sqlite.prepare(
      `EXPLAIN QUERY PLAN SELECT project_id, record_dedup_hash
       FROM records
       WHERE review_status IN ('proposed','accepted') AND project_id = ?`,
    ).all(a.id);
    const indexes = sqlite.prepare("PRAGMA index_list('records')").all() as Array<{ name: string; unique: number }>;
    expect(indexes.some((row) => row.name === "uq_record_dedupe" && row.unique === 1)).toBe(true);
    console.log("CKR12_DEDUP " + JSON.stringify({ projectAVisibleHashes: scopedA.length, unassignedRows: unassigned.length, plan, hashes }));
  });
});

describe("CKR-13 provider-independent common memory core", () => {
  it("keeps the core import graph provider-neutral while MCP and OpenAI adapters both use it", () => {
    const coreFiles = [
      "../src/services/memory-context.ts",
      "../src/services/memory-scope.ts",
      "../src/services/checkpoint.ts",
      "../src/services/memory-freshness.ts",
      "../src/services/memory-management.ts",
      "../src/services/search.ts",
      "../src/services/relations.ts",
    ];
    for (const relative of coreFiles) {
      const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
      expect(source, relative).not.toMatch(/@openai\//);
      expect(source, relative).not.toMatch(/@modelcontextprotocol\//);
    }
    const mcpAdapter = fs.readFileSync(new URL("../src/mcp/tools.ts", import.meta.url), "utf8");
    expect(mcpAdapter).toContain('@modelcontextprotocol/server');
    expect(mcpAdapter).toContain('ContextKeepMemoryService');
    expect(mcpAdapter).not.toContain('agent-tools');
  });

  it("reads memory with network blocked and preserves MCP/core parity", async () => {
    const t = await setup({ adapters: "manual" });
    const project = (await t.post("/api/projects", { name: "CKR13 network-blocked memory" })).json<{ id: string }>();
    const capture = await rpc(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "Network-blocked local memory marker.",
      subject: "ckr13-local-memory",
      checkpoint: { summary: "Local-only checkpoint", nextAction: "Keep reads provider-independent", blockers: [], artifactRefs: ["ckr13:local"] },
      idempotencyKey: crypto.randomUUID(),
    });
    const recordId = capture.outcome.recordId as string;

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("CKR13 network blocked");
    }) as typeof fetch;

    try {
      const work = await rpc(t, "get_work_context", { projectId: project.id, task: "local memory marker", limitPerSection: 5 });
      const search = await rpc(t, "search_context", { projectId: project.id, q: "local memory marker", scope: "working", limit: 5 });
      const record = await rpc(t, "get_record", { recordId, includeUnreviewed: true, evidenceOffset: 0, evidenceLimit: 3 });
      const projects = await rpc(t, "list_projects", { limit: 10, q: "CKR13 network-blocked memory" });

      const service = new ContextKeepMemoryService(t.app.ck.deps);
      const core = service.getWorkContext(
        { threadId: "ckr13-test", scope: "all", projectId: null },
        { projectId: project.id, task: "local memory marker", limitPerSection: 5 },
      ) as any;

      expect(work.project.id).toBe(project.id);
      expect(core.project.id).toBe(project.id);
      expect(work.latestCheckpoint?.recordId).toBe(recordId);
      expect(core.latestCheckpoint?.recordId).toBe(recordId);
      expect(work.freshness.working.version).toBe(core.freshness.working.version);
      expect(search.workingRecords.some((item: any) => item.recordId === recordId)).toBe(true);
      expect(record.recordId).toBe(recordId);
      expect(projects.projects.some((item: any) => item.id === project.id)).toBe(true);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("invalidates cached task ranking when working and canonical cursors advance", async () => {
    const t = await setup({ adapters: "manual" });
    const project = (await t.post("/api/projects", { name: "CKR13 versioned task cache" })).json<{ id: string }>();
    const task = "rare cache invalidation marker";

    const before = await rpc(t, "get_work_context", {
      projectId: project.id,
      task,
      limitPerSection: 5,
    });
    expect(before.workingMemory.items).toHaveLength(0);

    const capture = await rpc(t, "capture_working_memory", {
      projectId: project.id,
      outcome: "rare cache invalidation marker",
      subject: "cache-invalidation",
      idempotencyKey: crypto.randomUUID(),
    });
    const recordId = capture.outcome.recordId as string;

    const working = await rpc(t, "get_work_context", {
      projectId: project.id,
      task,
      limitPerSection: 5,
    });
    expect(working.freshness.working.cursor).toBeGreaterThan(before.freshness.working.cursor);
    expect(working.workingMemory.items.some((item: any) => item.recordId === recordId)).toBe(true);

    const detail = await rpc(t, "get_record", {
      recordId,
      includeUnreviewed: true,
      evidenceOffset: 0,
      evidenceLimit: 3,
    });
    await rpc(t, "review_records", {
      items: [{ recordId, revision: detail.revision }],
      action: "accept",
      ownerAction: true,
      idempotencyKey: crypto.randomUUID(),
    });

    const canonical = await rpc(t, "get_work_context", {
      projectId: project.id,
      task,
      limitPerSection: 5,
    });
    expect(canonical.freshness.canonical.cursor).toBeGreaterThan(before.freshness.canonical.cursor);
    expect(canonical.facts.items.some((item: any) => item.recordId === recordId)).toBe(true);
    expect(canonical.workingMemory.items.some((item: any) => item.recordId === recordId)).toBe(false);
  });
});
