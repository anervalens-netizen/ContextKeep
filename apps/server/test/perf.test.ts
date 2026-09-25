import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BriefDto } from "@contextkeep/shared";
import { expectStatus, makeTestApp, reviewCurrent, type TestApp } from "./helpers.js";

const PERF_MCP_TOKEN = "contextkeep-perf-local-token-0123456789abcdef";
const HOT_PATH_TARGET_MS = 75;
const WARMUP_SAMPLES = 5;
const MEASURED_SAMPLES = 40;

function p95(samples: number[]): number {
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length * 0.95) - 1]!;
}

async function callMcp(t: TestApp, name: string, arguments_: Record<string, unknown>): Promise<any> {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${PERF_MCP_TOKEN}`,
      accept: "application/json, text/event-stream",
    },
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: arguments_ },
    },
  });
  if (response.statusCode !== 200) throw new Error(`${name} failed: ${response.statusCode} ${response.body.slice(0, 500)}`);
  const result = response.json().result as { isError?: boolean; structuredContent?: unknown };
  if (result.isError || result.structuredContent === undefined) throw new Error(`${name} returned an MCP error`);
  return result.structuredContent;
}

function deterministicRecordId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function populateAiFirstHotPathFixture(t: TestApp): string {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const sqlite = t.app.ck.deps.sqlite;
  const projectNow = "2026-01-01T00:00:00.000Z";
  sqlite.prepare(
    `INSERT INTO projects (id, name, aliases_json, parent_project_id, description, lifecycle,
      lifecycle_record_id, revision, content_version, working_memory_version, created_at, updated_at)
     VALUES (?, ?, '[]', NULL, ?, 'active', NULL, 1, 1000, 1000, ?, ?)`,
  ).run(
    projectId,
    "AI-first performance fixture",
    "Representative local project for task-aware context and working-memory retrieval.",
    projectNow,
    projectNow,
  );

  const insertRecord = sqlite.prepare(
    `INSERT INTO records (id, project_id, type, subject, predicate, value_json, text,
      review_status, evidence_basis, task_status, record_dedup_hash, recorded_at,
      source_event_at, effective_from, effective_to, reviewed_at, review_due_at,
      volatile, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 1, ?, ?)`,
  );
  const types = ["decision", "fact", "action", "constraint", "question"] as const;
  const populate = sqlite.transaction(() => {
    for (let i = 0; i < 1_000; i++) {
      const type = types[i % types.length]!;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const isCurrentFact = type === "fact" && i % 5 === 1;
      const subject = `${type}-accepted-${i.toString().padStart(4, "0")}`;
      const text = isCurrentFact
        ? `Accepted current release deployment health observation ${i}; verify SQLite backup evidence before handoff.`
        : `Accepted ${type} ${i}; maintain the project release deployment health evidence and owner review trail.`;
      insertRecord.run(
        deterministicRecordId(i + 2),
        projectId,
        type,
        subject,
        isCurrentFact ? "release" : null,
        null,
        text,
        "accepted",
        "document",
        type === "action" ? "open" : null,
        `accepted-dedup-${i}`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
    }
    for (let i = 0; i < 1_000; i++) {
      const timestamp = new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString();
      const checkpoint = i % 10 === 0
        ? JSON.stringify({
            kind: "working_checkpoint",
            summary: `Working release checkpoint ${i}`,
            nextAction: "Verify deployment health and SQLite backup evidence",
            blockers: i % 20 === 0 ? ["Owner review required"] : [],
            artifactRefs: [`perf:working:${i}`],
          })
        : null;
      insertRecord.run(
        deterministicRecordId(i + 1_002),
        projectId,
        "fact",
        `working-release-observation-${i.toString().padStart(4, "0")}`,
        "deployment",
        checkpoint,
        `Working release deployment health observation ${i}; verify SQLite backup evidence and record the next handoff action.`,
        "proposed",
        "agent_report",
        null,
        `working-dedup-${i}`,
        timestamp,
        timestamp,
        null,
        timestamp,
        timestamp,
      );
    }
  });
  populate();

  const counts = sqlite.prepare(
    "SELECT review_status AS status, count(*) AS count FROM records WHERE project_id = ? GROUP BY review_status ORDER BY status",
  ).all(projectId) as Array<{ status: string; count: number }>;
  expect(counts).toEqual([
    { status: "accepted", count: 1_000 },
    { status: "proposed", count: 1_000 },
  ]);
  return projectId;
}

/**
 * §10 backend budget sanity: local API p95 ≤ 50ms for the current-brief route
 * on a 1k-record corpus. (The 100k-record search budget is an M1/FTS5 + M4
 * regression concern — LIKE scanning is explicitly M0-minimal.)
 */
describe("§10: brief route latency on a 1k-record corpus", () => {
  it(
    "stays within p95 ≤ 50ms",
    async () => {
      const t = await makeTestApp();
      try {
        const proj = (await t.post("/api/projects", { name: "Perf Project" })).json<{ id: string }>();
        const topics = [
          "deployment",
          "database",
          "networking",
          "security",
          "monitoring",
          "backups",
          "search",
          "export",
          "auth",
          "pwa",
        ];
        for (let b = 0; b < 10; b++) {
          const topic = topics[b]!;
          const preamble = `# ${topic} corpus batch ${b}\n\nNotes collected for the ${topic} subsystem review.\n\n`;
          const lines = Array.from(
            { length: 100 },
            (_, i) =>
              `fact: ${topic} note ${b}-${i} describing ${topic} behavior for component ${i % 7} in environment ${i % 3}`,
          ).join("\n");
          const imp = await t.post("/api/imports/text", {
            text: preamble + lines,
            adapterId: "faketest",
            projectId: proj.id,
          });
          expectStatus(imp, 201, `import batch ${b}`);
          expect(imp.json<{ candidateCount: number }>().candidateCount).toBe(100);
        }

        const inbox = await t.get(`/api/inbox?projectId=${proj.id}&limit=1000`);
        const ids = inbox.json<{ candidates: { id: string }[] }>().candidates.map((c) => c.id);
        expect(ids.length).toBe(1000);
        // API validation caps one decide call at 500 ids; accept in two batches.
        let acceptedTotal = 0;
        for (let i = 0; i < ids.length; i += 500) {
          const batch = ids.slice(i, i + 500);
          const decide = await reviewCurrent(t, batch, "accept");
          expectStatus(decide, 200, `bulk accept batch ${i / 500}`);
          acceptedTotal += decide.json<{ accepted: string[] }>().accepted.length;
        }
        expect(acceptedTotal).toBe(1000);

        const briefCheck = await t.get(`/api/projects/${proj.id}/brief`);
        expectStatus(briefCheck, 200, "brief with 1000 facts");
        expect(briefCheck.json<BriefDto>().facts.length).toBe(1000);

        // Measure over REAL HTTP (§10 is about the local API, not the inject harness).
        await t.app.listen({ port: 0, host: "127.0.0.1" });
        const addr = t.app.server.address();
        if (addr === null || typeof addr === "string") throw new Error("no ephemeral port");
        const base = `http://127.0.0.1:${addr.port}`;
        const headers = { cookie: t.cookie };

        // §10 measures steady-state brief latency, not first-call latency.
        // Benchmark is run in a DEDICATED Node process (see pnpm test
        // orchestration in root package.json: `pnpm -r test` runs functional
        // suite first; perf.test.ts is excluded from that, then a separate
        // `pnpm --filter @contextkeep/server test:perf` invocation runs only
        // this file in a fresh fork). With no fork-pool competition, 5
        // throwaway requests are enough to warm V8 inline caches for
        // brief.ts, Fastify routing, and better-sqlite3's page cache for
        // this project's records. The 40 measured samples are still real
        // brief responses (status + body validated). Threshold (50 ms),
        // sample count (40), and corpus size (1k accepted records) are
        // unchanged. Warmup = 5 is FIXED (not bumped) for this dedicated
        // process — chosen once and documented here.
        for (let i = 0; i < 5; i++) {
          const warm = await fetch(`${base}/api/projects/${proj.id}/brief`, { headers });
          await warm.arrayBuffer();
          if (warm.status !== 200) throw new Error(`warmup failed: ${warm.status}`);
        }

        const samples: number[] = [];
        for (let i = 0; i < 40; i++) {
          const start = performance.now();
          const res = await fetch(`${base}/api/projects/${proj.id}/brief`, { headers });
          const body = await res.arrayBuffer(); // count serialization + transfer
          samples.push(performance.now() - start);
          if (res.status !== 200 || body.byteLength < 1000) {
            throw new Error(`brief sample failed: ${res.status}, ${body.byteLength} bytes`);
          }
        }
        await t.app.server.close();
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
        // eslint-disable-next-line no-console
        console.log(`[perf] brief p95 = ${p95.toFixed(2)}ms over ${samples.length} samples (1k accepted records)`);
        expect(p95).toBeLessThanOrEqual(50);
      } finally {
        await t.cleanup();
      }
    },
    180_000,
  );
});

describe("A6.1: AI-first hot-path latency on a deterministic SQLite fixture", () => {
  it(
    "keeps task-aware get_work_context p95 ≤ 75ms with 1k accepted and 1k working records",
    async () => {
      const t = await makeTestApp({ mcpToken: PERF_MCP_TOKEN });
      try {
        const projectId = populateAiFirstHotPathFixture(t);
        const input = {
          projectId,
          task: "Verify the current release deployment health and SQLite backup evidence before handoff",
          limitPerSection: 5,
          totalContextBudgetChars: 60_000,
        };

        for (let i = 0; i < WARMUP_SAMPLES; i++) {
          const warm = await callMcp(t, "get_work_context", input);
          if (warm.project?.id !== projectId || warm.task !== input.task) throw new Error("get_work_context warmup returned an invalid context");
        }

        const samples: number[] = [];
        for (let i = 0; i < MEASURED_SAMPLES; i++) {
          const startedAt = performance.now();
          const context = await callMcp(t, "get_work_context", input);
          samples.push(performance.now() - startedAt);
          if (
            context.project?.id !== projectId ||
            context.freshness?.canonicalCursor !== 1000 ||
            context.freshness?.workingCursor !== 1000 ||
            context.workingMemory?.items?.length === 0
          ) {
            throw new Error("get_work_context sample returned an invalid AI-first context");
          }
        }
        const latencyP95 = p95(samples);
        // eslint-disable-next-line no-console
        console.log(`[perf] get_work_context task-aware p95 = ${latencyP95.toFixed(2)}ms over ${samples.length} samples (1k accepted + 1k working records)`);
        expect(latencyP95).toBeLessThanOrEqual(HOT_PATH_TARGET_MS);
      } finally {
        await t.cleanup();
      }
    },
    180_000,
  );

  it(
    "keeps explicit working-memory search p95 ≤ 75ms with 1k working records",
    async () => {
      const t = await makeTestApp({ mcpToken: PERF_MCP_TOKEN });
      try {
        const projectId = populateAiFirstHotPathFixture(t);
        const input = {
          projectId,
          q: "release deployment health",
          scope: "working",
          match: "terms",
          limit: 15,
        };

        for (let i = 0; i < WARMUP_SAMPLES; i++) {
          const warm = await callMcp(t, "search_context", input);
          if (warm.scope !== "working" || warm.records.length !== 0 || warm.workingRecords.length === 0) {
            throw new Error("search_context warmup returned an invalid working-memory result");
          }
        }

        const samples: number[] = [];
        for (let i = 0; i < MEASURED_SAMPLES; i++) {
          const startedAt = performance.now();
          const result = await callMcp(t, "search_context", input);
          samples.push(performance.now() - startedAt);
          if (
            result.scope !== "working" ||
            result.records.length !== 0 ||
            result.workingRecords.length === 0 ||
            result.workingRecords.some((record: { truthStatus?: string }) => record.truthStatus !== "not_canonical_requires_review")
          ) {
            throw new Error("search_context sample returned an invalid working-memory result");
          }
        }
        const latencyP95 = p95(samples);
        // eslint-disable-next-line no-console
        console.log(`[perf] search_context working p95 = ${latencyP95.toFixed(2)}ms over ${samples.length} samples (1k accepted + 1k working records)`);
        expect(latencyP95).toBeLessThanOrEqual(HOT_PATH_TARGET_MS);
      } finally {
        await t.cleanup();
      }
    },
    180_000,
  );
});
