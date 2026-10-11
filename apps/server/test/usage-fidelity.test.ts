import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
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
it("preserves MCP page concatenation when a redaction marker spans pages", async () => {
  const { t, capture } = await setup();
  const r = await ok(t, "capture_work", capture());
  const raw = "PASSWORD=synthetic-example-credential";
  t.app.ck.handle.sqlite
    .prepare("UPDATE sources SET normalized_text=?,original_text=? WHERE id=?")
    .run(raw, raw, r.source.id);
  const whole = await ok(t, "get_source", { sourceId: r.source.id });
  let joined = "",
    offset: number | null = 0;
  while (offset !== null) {
    const page = await ok(t, "get_source", {
      sourceId: r.source.id,
      offset,
      maxChars: 16,
    });
    joined += page.text;
    offset = page.nextOffset;
  }
  expect(joined).toBe(whole.text);
  expect(joined).not.toContain("synthetic-example-credential");
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

it("replays a legacy trimmed limit receipt without accepting new oversized writes", async () => {
  const { t, capture } = await setup();
  const args = capture({
    outcome: "x".repeat(8000),
    evidenceText: "e".repeat(64000),
  });
  const result = await call(t, "capture_work", args);
  t.app.ck.handle.sqlite
    .prepare("UPDATE idempotency_requests SET request_hash=? WHERE key=?")
    .run(
      requestHash("MCP", "capture_work", args),
      "mcp:" + args.idempotencyKey,
    );
  expect(
    await call(t, "capture_work", {
      ...args,
      outcome: args.outcome + " ",
      evidenceText: " " + args.evidenceText,
    }),
  ).toEqual(result);
  const fresh = {
    ...args,
    idempotencyKey: crypto.randomUUID(),
    outcome: args.outcome + " ",
  };
  expect(
    (await call(t, "capture_work", fresh)).structuredContent.error.code,
  ).toBe("invalid_input");
  expect(
    t.app.ck.handle.sqlite
      .prepare("SELECT key FROM idempotency_requests WHERE key=?")
      .get("mcp:" + fresh.idempotencyKey),
  ).toBeUndefined();
});
it("keeps report pagination separate from execution and blocker pagination", async () => {
  const { t, capture } = await setup();
  const task = await ok(
    t,
    "capture_work",
    capture({ recordType: "action", outcome: "Synthetic task" }),
  );
  const taskId = task.outcome.recordId,
    projectId = capture().projectId;
  for (let i = 0; i < 21; i++)
    await ok(t, "capture_work", capture({ taskId, outcome: "Report " + i }));
  const view = await ok(t, "get_task", { projectId, taskId });
  expect(view.pagination.nextOffset).toBe(20);
  expect(view.pagination.runsBlockersNextOffset).toBeNull();
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

it("attributes a legacy checkpoint summary fallback to reported progress", async () => {
  const { t, capture } = await setup();
  const task = await ok(
    t,
    "capture_work",
    capture({ recordType: "action", outcome: "Legacy task" }),
  );
  const taskId = task.outcome.recordId,
    projectId = capture().projectId;
  const progress = await ok(t, "report_task_progress", {
    projectId,
    taskId,
    taskRevision: 1,
    expectedProgressRecordId: null,
    status: "in_progress",
    summary: "Actual progress summary",
    nextAction: "Explicit progress next",
    ownerAction: null,
    evidenceText: "Synthetic progress evidence",
    clientId: "test",
    sessionId: "fidelity",
    idempotencyKey: crypto.randomUUID(),
  });
  const cp = await ok(
    t,
    "capture_work",
    capture({
      taskId,
      outcome: "Checkpoint free text is not the summary",
      checkpoint: { summary: "remove", nextAction: "Checkpoint next" },
    }),
  );
  t.app.ck.handle.sqlite
    .prepare(
      "UPDATE records SET value_json=json_remove(value_json,'$.summary','$.outcome') WHERE id=?",
    )
    .run(cp.outcome.recordId);
  const resume = await ok(t, "resume_task", {
    projectId,
    taskId,
    depth: "deep",
  });
  expect(resume.dossier.summary).toBe("Actual progress summary");
  expect(resume.dossier.summarySource.recordId).toBe(progress.recordId);
  expect(resume.dossier.nextActionSource.recordId).toBe(cp.outcome.recordId);
});

it("exposes text hashes independently of a salted correction storage identity", async () => {
  const { t, capture } = await setup();
  const raw = "Original correction evidence";
  const r = await ok(t, "capture_work", capture({ evidenceText: raw }));
  t.app.ck.handle.sqlite
    .prepare(
      "UPDATE sources SET kind='owner_correction',content_hash=? WHERE id=?",
    )
    .run(
      crypto
        .createHash("sha256")
        .update(raw + "salt")
        .digest("hex"),
      r.source.id,
    );
  const source = await ok(t, "get_source", {
    sourceId: r.source.id,
    representation: "original",
  });
  expect(source.contentHash).toBe(
    crypto.createHash("sha256").update(raw).digest("hex"),
  );
});
it("does not label a state checkpoint as a separate report", async () => {
  const { t, capture } = await setup();
  const task = await ok(
    t,
    "capture_work",
    capture({ recordType: "action", outcome: "State-bearing fixture" }),
  );
  const taskId = task.outcome.recordId,
    projectId = capture().projectId;
  await ok(
    t,
    "capture_work",
    capture({
      taskId,
      outcome: "Checkpoint",
      checkpoint: {
        summary: "Latest summary",
        nextAction: "New explicit next",
      },
    }),
  );
  const resumed = await ok(t, "resume_task", { projectId, taskId });
  expect(resumed.dossier.lastReported).toBeNull();
  expect(resumed.resumeText).not.toContain("Latest separate report:");
  expect(resumed.dossier.nextAction).toBe("New explicit next");
});
it("redacts complete resume fields before every depth boundary on HTTP and MCP", async () => {
  const { t, capture } = await setup();
  const task = await ok(
    t,
    "capture_work",
    capture({ recordType: "action", outcome: "Secret boundary fixture" }),
  );
  const taskId = task.outcome.recordId,
    projectId = capture().projectId;
  const cp = await ok(
    t,
    "capture_work",
    capture({
      taskId,
      outcome: "Checkpoint",
      checkpoint: { summary: "Fixture", nextAction: "Fixture next" },
    }),
  );
  const report = await ok(
    t,
    "capture_work",
    capture({ taskId, outcome: "Separate report" }),
  );
  for (const [depth, limit] of [
    ["compact", 600],
    ["balanced", 1600],
    ["deep", 4800],
  ] as const) {
    const raw = "a".repeat(limit - 10) + token + " end";
    t.app.ck.handle.sqlite
      .prepare(
        "UPDATE records SET value_json=json_set(value_json,'$.summary',?,'$.nextAction',?) WHERE id=?",
      )
      .run(raw, raw, cp.outcome.recordId);
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET text=? WHERE id=?")
      .run(raw, report.outcome.recordId);
    t.app.ck.handle.sqlite
      .prepare("UPDATE records SET text=? WHERE id=?")
      .run("a".repeat(1590) + token, taskId);
    const result = await ok(t, "resume_task", { projectId, taskId, depth });
    const http = (
      await t.get(
        `/api/projects/${projectId}/tasks/${taskId}/resume?depth=${depth}`,
      )
    ).json();
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 10));
    expect(JSON.stringify(http)).not.toContain(token.slice(0, 10));
    expect(http.resumeText).toBe(result.resumeText);
  }
});

it("reuses bounded source preparation across large pages and invalidates on writes and secrets", async () => {
  const { t, capture } = await setup();
  const r = await ok(t, "capture_work", capture());
  const db = t.app.ck.handle.sqlite;
  const deps = { db: t.app.ck.handle.db, sqlite: db } as any;
  const raw = "a".repeat(4 * 1024 * 1024 - 128) + "😀" + token;
  db.prepare(
    "UPDATE sources SET original_text=?,normalized_text=? WHERE id=?",
  ).run(raw, raw, r.source.id);
  const select = vi.spyOn(deps.db, "select");
  const input = {
    sourceId: r.source.id,
    offset: 0,
    maxChars: 20000,
    excerptOffset: 0,
    excerptLimit: 1,
  };
  try {
    let joined = "",
      offset: number | null = 0;
    while (offset !== null) {
      const page = readSource(deps, { ...input, offset }, [token]);
      joined += page.text;
      offset = page.nextOffset;
    }
    expect(joined).toBe(raw.replace(token, "<REDACTED_CREDENTIAL>"));
    expect(select).toHaveBeenCalledTimes(1);
    const updated = "synthetic-rotated-credential";
    db.prepare(
      "UPDATE sources SET original_text=?,normalized_text=? WHERE id=?",
    ).run(updated, updated, r.source.id);
    expect(readSource(deps, input, [token]).text).toBe(updated);
    expect(select).toHaveBeenCalledTimes(2);
    expect(readSource(deps, input, [token, updated]).text).toBe(
      "<REDACTED_CREDENTIAL>",
    );
    expect(select).toHaveBeenCalledTimes(3);
    const external = new Database(db.name);
    try {
      external
        .prepare(
          "UPDATE sources SET original_text='External update',normalized_text='External update' WHERE id=?",
        )
        .run(r.source.id);
    } finally {
      external.close();
    }
    expect(readSource(deps, input, [token, updated]).text).toBe(
      "External update",
    );
    expect(select).toHaveBeenCalledTimes(4);
  } finally {
    select.mockRestore();
  }
});
