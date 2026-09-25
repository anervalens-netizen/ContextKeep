import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeTestApp, type TestApp } from "../test/helpers.js";
function deterministicRecordId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function populateLargeFixture(t: TestApp): string {
  const projectId = "00000000-0000-4000-8000-000000000001";
  const sqlite = t.app.ck.deps.sqlite;
  const projectNow = "2026-01-01T00:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, aliases_json, parent_project_id, description, lifecycle,
      lifecycle_record_id, revision, content_version, working_memory_version, created_at, updated_at)
     VALUES (?, ?, '[]', NULL, ?, 'active', NULL, 1, 10000, 10000, ?, ?)`,
    )
    .run(
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
  const types = [
    "decision",
    "fact",
    "action",
    "constraint",
    "question",
  ] as const;
  const populate = sqlite.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
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
    for (let i = 0; i < 10_000; i++) {
      const timestamp = new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString();
      const checkpoint =
        i % 10 === 0
          ? JSON.stringify({
              kind: "working_checkpoint",
              summary: `Working release checkpoint ${i}`,
              nextAction: "Verify deployment health and SQLite backup evidence",
              blockers: i % 20 === 0 ? ["Owner review required"] : [],
              artifactRefs: [`perf:working:${i}`],
            })
          : null;
      insertRecord.run(
        deterministicRecordId(i + 10_002),
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

  const counts = sqlite
    .prepare(
      "SELECT review_status AS status, count(*) AS count FROM records WHERE project_id = ? GROUP BY review_status ORDER BY status",
    )
    .all(projectId) as Array<{ status: string; count: number }>;
  assert.deepEqual(counts, [
    { status: "accepted", count: 10_000 },
    { status: "proposed", count: 10_000 },
  ]);
  return projectId;
}

const token = crypto.randomBytes(32).toString("hex");
const t = await makeTestApp({
  mcpToken: token,
  mcpDefaultClientId: "audit-load",
  adapters: "manual,faketest",
});
try {
  const projectId = populateLargeFixture(t);
  async function call(name: string, args: Record<string, unknown>) {
    const response = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      error?: unknown;
      result: { isError?: boolean; structuredContent: Record<string, unknown> };
    }>();
    assert.equal(body.error, undefined);
    assert.notEqual(body.result.isError, true);
    return body.result.structuredContent;
  }
  const reports = [];
  for (const [tool, args] of [
    [
      "get_work_context",
      {
        projectId,
        task: "verify release deployment health",
        totalContextBudgetChars: 6000,
      },
    ],
    ["list_blockers", { projectId, limit: 20 }],
  ] as const) {
    for (let i = 0; i < 3; i++) await call(tool, args);
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const result = await call(tool, args);
      samples.push(performance.now() - start);
      bytes = JSON.stringify(result).length;
    }
    samples.sort((a, b) => a - b);
    reports.push({
      tool,
      medianMs: samples[5],
      p95Ms: samples[9],
      responseChars: bytes,
      samples: samples.length,
    });
  }
  console.log(
    JSON.stringify(
      {
        corpus: { accepted: 10000, working: 10000, oneProject: true },
        reports,
        rssMiB: process.memoryUsage().rss / 1048576,
        scope:
          "isolated synthetic local MCP inject, not a production latency promise",
      },
      null,
      2,
    ),
  );
} finally {
  await t.cleanup();
}
