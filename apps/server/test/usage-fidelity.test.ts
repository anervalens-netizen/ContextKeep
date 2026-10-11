import crypto from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { readSource } from "../src/mcp/reads.js";
import { requestHash } from "../src/services/idempotency.js";
const token = crypto.randomBytes(32).toString("hex");
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) await t.cleanup();
});
async function call(t: TestApp, name: string, args: any) {
  const r = await t.app.inject({
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
  return r.json().result;
}
async function ok(t: TestApp, name: string, args: any) {
  const r = await call(t, name, args);
  expect(r.isError, JSON.stringify(r.structuredContent)).not.toBe(true);
  return r.structuredContent;
}
async function setup() {
  const t = await makeTestApp({ mcpToken: token });
  apps.push(t);
  const p = await ok(t, "create_project", {
    name: "Synthetic text fidelity",
    idempotencyKey: crypto.randomUUID(),
  });
  const capture = (extra: any = {}) => ({
    projectId: p.id,
    outcome: "Verified endpoint.",
    evidenceText: "Synthetic evidence.",
    title: null,
    eventAt: null,
    recordType: "fact",
    subject: "fidelity",
    progressUpdates: [],
    clientId: "codex",
    sessionId: "synthetic-fidelity",
    idempotencyKey: crypto.randomUUID(),
    ...extra,
  });
  return { t, capture };
}
it("preserves exact evidence, outcome case/space and distinct explicit observation times", async () => {
  const { t, capture } = await setup();
  const a = await ok(
    t,
    "capture_work",
    capture({ outcome: " /api/Foo ", evidenceText: '  {"value":"a  b"}  ' }),
  );
  const b = await ok(
    t,
    "capture_work",
    capture({ outcome: " /api/foo ", evidenceText: '  {"value":"a   b"}  ' }),
  );
  expect(a.source.id).not.toBe(b.source.id);
  expect(a.outcome.recordId).not.toBe(b.outcome.recordId);
  expect(
    (
      await ok(t, "get_source", {
        sourceId: b.source.id,
        representation: "original",
      })
    ).text,
  ).toBe('  {"value":"a   b"}  ');
  const c = await ok(
    t,
    "capture_work",
    capture({ outcome: " /api/Foo ", evidenceText: "Additional evidence" }),
  );
  expect(c.outcome.recordId).toBe(a.outcome.recordId);
  const firstArgs = capture({ eventAt: "2026-01-01T00:00:00.000Z" });
  const first = await ok(t, "capture_work", firstArgs);
  const second = await ok(
    t,
    "capture_work",
    capture({ eventAt: "2026-01-02T00:00:00.000Z" }),
  );
  expect(first.source.id).toBe(second.source.id);
  expect(first.outcome.recordId).not.toBe(second.outcome.recordId);
  expect(await ok(t, "capture_work", firstArgs)).toEqual(first);
  expect(
    (
      await ok(t, "get_record", {
        recordId: second.outcome.recordId,
        includeUnreviewed: true,
      })
    ).sourceEventAt,
  ).toBe("2026-01-02T00:00:00.000Z");
  expect(
    (
      await call(t, "capture_work", {
        ...firstArgs,
        evidenceText: " " + firstArgs.evidenceText,
      })
    ).structuredContent.error.code,
  ).toBe("idempotency_key_reused");
});
it("redacts complete source before short pages and masks credentials crossing excerpt boundaries", async () => {
  const { t, capture } = await setup();
  const r = await ok(t, "capture_work", capture());
  // Simulate an existing manual source; no real credentials are involved.
  const synthetic = "Bearer " + "Z".repeat(35);
  const raw = "a".repeat(3990) + "\n" + synthetic + "\nend";
  const db = t.app.ck.handle.sqlite;
  db.prepare(
    "UPDATE sources SET normalized_text=?,original_text=? WHERE id=?",
  ).run(raw, raw, r.source.id);
  db.prepare(
    "UPDATE source_excerpts SET exact_text=?,start_offset=0,end_offset=4000 WHERE source_id=?",
  ).run(raw.slice(0, 4000), r.source.id);
  const whole = await ok(t, "get_source", {
    sourceId: r.source.id,
    maxChars: 20000,
  });
  let joined = "",
    offset: number | null = 0;
  // Read pages around the credential using the same service and boundary secret list.
  const deps = t.app.ck as any;
  const pageSize = 10;
  while (offset !== null) {
    const page = readSource(
      { db: deps.handle.db, sqlite: db } as any,
      {
        sourceId: r.source.id,
        offset,
        maxChars: pageSize,
        excerptOffset: 0,
        excerptLimit: 1,
      },
      [token],
    );
    joined += page.text;
    offset = page.nextOffset;
  }
  expect(joined).toBe(whole.text);
  expect(joined).not.toContain("Z".repeat(10));
  expect(whole.excerpts[0].text).not.toContain("Bearer");
  const record = await ok(t, "get_record", {
    recordId: r.outcome.recordId,
    includeUnreviewed: true,
  });
  expect(record.evidence[0].text).not.toContain("Bearer");
});
it("keeps surrogate pairs through SQLite and rejects NUL before persistence", async () => {
  const { t, capture } = await setup();
  const text = "A".repeat(3999) + "😀" + "B".repeat(100);
  const r = await ok(t, "capture_work", capture({ evidenceText: text }));
  const source = await ok(t, "get_source", { sourceId: r.source.id });
  expect(source.text).toBe(text);
  expect(source.excerpts.map((e: any) => e.text).join("")).toBe(text);
  expect(
    (
      await call(
        t,
        "capture_work",
        capture({ evidenceText: "before\u0000after" }),
      )
    ).structuredContent.error.code,
  ).toBe("unsupported_text_character");
});
it("replays legacy trimmed receipts without replaying a mutation", async () => {
  const { t, capture } = await setup();
  const args = capture({
    outcome: "  legacy outcome  ",
    evidenceText: "  legacy evidence  ",
  });
  const legacy = {
    ...args,
    outcome: args.outcome.trim(),
    evidenceText: args.evidenceText.trim(),
  };
  const result = await call(t, "capture_work", legacy);
  t.app.ck.handle.sqlite
    .prepare("UPDATE idempotency_requests SET request_hash=? WHERE key=?")
    .run(
      requestHash("MCP", "capture_work", legacy),
      "mcp:" + args.idempotencyKey,
    );
  expect(await call(t, "capture_work", args)).toEqual(result);
});

it("renders the same depth-aware context through HTTP and MCP without promoting a later report", async () => {
  const { t, capture } = await setup();
  const task = await ok(
    t,
    "capture_work",
    capture({ recordType: "action", outcome: "Inspect synthetic artifact" }),
  );
  const taskId = task.outcome.recordId,
    projectId = capture().projectId;
  const summary = "Detailed evidence ".repeat(180).trim();
  const cp = await ok(
    t,
    "capture_work",
    capture({
      taskId,
      checkpoint: { summary, nextAction: "Inspect retained receipt" },
      outcome: "Checkpoint",
    }),
  );
  const later = await ok(
    t,
    "capture_work",
    capture({
      taskId,
      outcome: "Later report: repair verified",
      evidenceText: "Newer independent observation",
    }),
  );
  const balanced = await ok(t, "resume_task", {
    projectId,
    taskId,
    depth: "balanced",
  });
  const deep = await ok(t, "resume_task", { projectId, taskId, depth: "deep" });
  expect(deep.dossier.summary).toBe(summary);
  expect(balanced.dossier.summary.length).toBeLessThan(
    deep.dossier.summary.length,
  );
  expect(deep.dossier.summarySource.recordId).toBe(cp.outcome.recordId);
  expect(deep.dossier.nextActionSource.recordId).toBe(cp.outcome.recordId);
  expect(deep.dossier.lastReported.recordId).toBe(later.outcome.recordId);
  expect(deep.resumeText).toContain("Later report: repair verified");
  expect(deep.resumeText).toContain("Continuation:");
  expect(deep.dossier.nextAction).toBe("Inspect retained receipt");
  const http = await t.get(
    `/api/projects/${projectId}/tasks/${taskId}/resume?depth=deep`,
  );
  expect(http.json().resumeText).toBe(deep.resumeText);
});
