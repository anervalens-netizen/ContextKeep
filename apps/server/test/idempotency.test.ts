/**
 * F07: durable server-side mutation idempotency.
 *
 * Each test below is wired through the FULL Fastify stack (buildApp /
 * makeTestApp) so the preHandler + onSend hooks are exercised the same way
 * the production server exercises them. Helpers assert directly against the
 * SQLite durable state to prove the concurrency authority is the PK column,
 * not an in-memory lock.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { InjectResult, TestApp } from "./helpers.js";
import { makeTestApp } from "./helpers.js";
import {
  _testDeleteClaim,
  canonicalJson,
  finalizeClaim,
  isValidIdempotencyKey,
  recoverInterruptedIdempotencyClaims,
  pruneTerminalIdempotencyClaims,
  requestHash,
  tryClaim,
} from "../src/services/idempotency.js";

let current: TestApp | null = null;
afterEach(async () => {
  if (current) await current.cleanup();
  current = null;
});

async function injectIdempotent(
  t: TestApp,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload: unknown,
  key: string,
): Promise<InjectResult> {
  const res = await t.app.inject({
    method,
    url,
    headers: {
      cookie: t.cookie,
      "x-csrf-token": t.csrf,
      "idempotency-key": key,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: payload as never,
  });
  return {
    statusCode: res.statusCode,
    payload: res.payload,
    headers: res.headers as Record<string, string | string[] | undefined>,
    cookies: res.cookies.map((c) => ({ name: c.name, value: c.value })),
    json<T = unknown>(): T {
      return JSON.parse(res.payload) as T;
    },
  };
}

function nowIsoForTest(): string {
  return new Date().toISOString();
}

describe("F07: idem-key validation helpers", () => {
  it("accepts canonical UUID v4 and rejects empty / malformed / oversized keys", () => {
    expect(isValidIdempotencyKey("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isValidIdempotencyKey("ck:local:1234-5678")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("short")).toBe(false); // < 8 chars
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(123)).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(201))).toBe(false);
  });

  it("canonical JSON is key-order independent and array-order preserving", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({})).toBe("{}"); // F07 remediation: empty object stays "{}"
    expect(canonicalJson("s")).toBe('"s"');
  });

  it("requestHash differs by method / url / body and ignores property order", () => {
    const a = requestHash("POST", "/api/projects", { name: "x" });
    const b = requestHash("POST", "/api/projects", { name: "x" });
    expect(a).toBe(b);
    const reordered = requestHash("POST", "/api/projects", { name: "x" });
    expect(reordered).toBe(a);
    const different = requestHash("POST", "/api/projects", { name: "y" });
    expect(different).not.toBe(a);
    const differentMethod = requestHash("PUT", "/api/projects", { name: "x" });
    expect(differentMethod).not.toBe(a);
    const differentUrl = requestHash("POST", "/api/projects?x=1", { name: "x" });
    expect(differentUrl).not.toBe(a);
    // F07 remediation: undefined / null are both "no body" and hash identically,
    // but `{}` is a real JSON body and must NOT collapse to the same hash.
    const bodylessUndef = requestHash("DELETE", "/api/projects/p1", undefined);
    const bodylessNull = requestHash("DELETE", "/api/projects/p1", null);
    expect(bodylessUndef).toBe(bodylessNull);
    const emptyObject = requestHash("DELETE", "/api/projects/p1", {});
    expect(emptyObject).not.toBe(bodylessUndef);
    expect(emptyObject).not.toBe(bodylessNull);
  });
});

describe("F07: durable SQLite claim state machine", () => {
  it("tryClaim inserts a fresh pending row and a second concurrent tryClaim observes it", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const key = "test-key-1-aaaaaaaaaaaa";
    const a = tryClaim(sqlite, { key, method: "POST", url: "/api/x", requestHash: "h" });
    expect(a.fresh).toBe(true);
    expect(a.claim.state).toBe("pending");

    const b = tryClaim(sqlite, { key, method: "POST", url: "/api/x", requestHash: "h" });
    expect(b.fresh).toBe(false);
    expect(b.claim.state).toBe("pending");
    expect(b.claim.requestHash).toBe("h");

    // Assert there is exactly ONE durable row for this key.
    const count = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests WHERE key = ?").get(key) as { n: number }).n;
    expect(count).toBe(1);

    finalizeClaim(sqlite, {
      key,
      state: "completed",
      responseStatus: 201,
      responseBody: '{"ok":true}',
      responseContentType: "application/json; charset=utf-8",
    });

    const after = (sqlite.prepare("SELECT state, response_status AS s, response_body AS b FROM idempotency_requests WHERE key = ?").get(key) as {
      state: string;
      s: number;
      b: string;
    });
    expect(after.state).toBe("completed");
    expect(after.s).toBe(201);
    expect(after.b).toBe('{"ok":true}');
  });

  it("recoverInterruptedIdempotencyClaims converts every pending row to indeterminate and is idempotent", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const stamps = [nowIsoForTest(), nowIsoForTest()];
    sqlite.prepare(
      `INSERT INTO idempotency_requests
         (key, method, url, request_hash, state, response_status, response_body, response_content_type, created_at, updated_at)
       VALUES (?, 'POST', '/api/x', 'h1', 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run("pending-key-aaaaaaaaaa", stamps[0]!, stamps[0]!);
    sqlite.prepare(
      `INSERT INTO idempotency_requests
         (key, method, url, request_hash, state, response_status, response_body, response_content_type, created_at, updated_at)
       VALUES (?, 'POST', '/api/x', 'h2', 'completed', 200, '{"ok":1}', 'application/json', ?, ?)`,
    ).run("completed-key-aaaaaaaa", stamps[1]!, stamps[1]!);

    expect(recoverInterruptedIdempotencyClaims(sqlite)).toBe(1);
    // A second recovery pass is a no-op (no pending rows left).
    expect(recoverInterruptedIdempotencyClaims(sqlite)).toBe(0);

    const pending = (sqlite.prepare("SELECT state FROM idempotency_requests WHERE key = ?").get("pending-key-aaaaaaaaaa") as { state: string });
    expect(pending.state).toBe("indeterminate");
    const completed = (sqlite.prepare("SELECT state FROM idempotency_requests WHERE key = ?").get("completed-key-aaaaaaaa") as { state: string });
    expect(completed.state).toBe("completed");
  });

  it("prunes only terminal claims older than retention and preserves recent replay plus pending work", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const nowMs = Date.parse("2026-09-20T00:00:00.000Z");
    const old = "2026-08-01T00:00:00.000Z";
    const recent = "2026-09-10T00:00:00.000Z";
    const insert = sqlite.prepare(
      `INSERT INTO idempotency_requests
         (key, method, url, request_hash, state, response_status, response_body, response_content_type, created_at, updated_at)
       VALUES (?, 'POST', '/api/x', ?, ?, ?, ?, 'application/json', ?, ?)`,
    );
    insert.run("old-completed-aaaaaaaa", "old-completed-hash", "completed", 200, '{"old":1}', old, old);
    insert.run("old-indeterminate-aaaa", "old-indeterminate-hash", "indeterminate", 500, "", old, old);
    insert.run("recent-completed-aaaaaa", "recent-hash", "completed", 200, '{"recent":1}', recent, recent);
    insert.run("old-pending-aaaaaaaa", "old-pending-hash", "pending", null, null, old, old);

    expect(pruneTerminalIdempotencyClaims(sqlite, 30, nowMs)).toBe(2);
    expect((sqlite.prepare("SELECT count(*) AS n FROM idempotency_requests").get() as { n: number }).n).toBe(2);
    expect((sqlite.prepare("SELECT state FROM idempotency_requests WHERE key=?").get("old-pending-aaaaaaaa") as { state: string }).state).toBe("pending");

    const replay = tryClaim(sqlite, {
      key: "recent-completed-aaaaaa",
      method: "POST",
      url: "/api/x",
      requestHash: "recent-hash",
    });
    expect(replay.fresh).toBe(false);
    expect(replay.claim.state).toBe("completed");
    expect(replay.claim.responseBody).toBe('{"recent":1}');
  });
});

describe("F07: HTTP integration — replay after response loss", () => {
  it("same key + same request returns the original response with X-Idempotent-Replay: true and runs the handler exactly once", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const key = "replay-key-aaaaaaaaaaaaaa";

    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;

    const first = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Replay Project" }, key);
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ id: string; name: string }>();
    expect(firstBody.name).toBe("F07 Replay Project");
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();

    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before + 1);

    const auditBefore = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.created'")
      .get() as { n: number }).n;

    const second = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Replay Project" }, key);
    expect(second.statusCode).toBe(200);
    const secondBody = second.json<{ id: string; name: string }>();
    expect(secondBody.id).toBe(firstBody.id);
    expect(second.headers["x-idempotent-replay"]).toBe("true");

    const afterReplay = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(afterReplay).toBe(after); // handler did NOT execute again
    const auditAfter = (sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.created'")
      .get() as { n: number }).n;
    expect(auditAfter).toBe(auditBefore); // no duplicate audit side-effect either

    // The replay path stores the already-serialized response body and replays
    // it byte-for-byte. This is the F07 durable-replay contract: a retry
    // observes the SAME payload the original attempt returned, not a fresh
    // serialization that might (in theory) reorder keys, add whitespace, or
    // change numeric precision.
    expect(second.payload).toBe(first.payload);
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
  });
  it("same-key review retry replays the original decision without duplicate review or cursor mutation", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const project = (await t.post("/api/projects", { name: "F07 review replay" })).json<{ id: string }>();
    const imported = await t.post("/api/imports/text", {
      projectId: project.id,
      adapterId: "faketest",
      text: "fact: revision-bound review retry",
    });
    expect(imported.statusCode).toBe(201);
    const record = sqlite.prepare(
      "SELECT id, revision FROM records WHERE project_id=? AND review_status='proposed' ORDER BY created_at DESC LIMIT 1",
    ).get(project.id) as { id: string; revision: number };
    const payload = {
      items: [{ recordId: record.id, revision: record.revision }],
      action: "accept",
    };
    const key = "review-replay-key-aaaaaaaa";

    const first = await injectIdempotent(t, "POST", "/api/inbox/decide", payload, key);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ accepted: string[] }>().accepted).toEqual([record.id]);
    const snapshot = () => ({
      record: sqlite.prepare(
        "SELECT review_status AS reviewStatus, revision FROM records WHERE id=?",
      ).get(record.id),
      acceptedAudits: (sqlite.prepare(
        "SELECT count(*) AS n FROM audit_events WHERE action='record.accepted' AND target_id=?",
      ).get(record.id) as { n: number }).n,
      project: sqlite.prepare(
        "SELECT content_version AS contentVersion, working_memory_version AS workingMemoryVersion FROM projects WHERE id=?",
      ).get(project.id),
    });
    const afterFirst = snapshot();

    const second = await injectIdempotent(t, "POST", "/api/inbox/decide", payload, key);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    expect(second.payload).toBe(first.payload);
    expect(snapshot()).toEqual(afterFirst);
  });
});

describe("F07: HTTP integration — same key, different request", () => {
  it("rejects the second request with 409 idempotency_key_reused without executing the handler", async () => {
    const t = (current = await makeTestApp());
    const key = "reuse-key-aaaaaaaaaaaaaa";
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;

    const first = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Original" }, key);
    expect(first.statusCode).toBe(200);

    const reuse = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Reused" }, key);
    expect(reuse.statusCode).toBe(409);
    const body = reuse.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("idempotency_key_reused");

    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before + 1); // only the original committed
    const names = (sqlite.prepare("SELECT name FROM projects WHERE name LIKE 'F07 %' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(["F07 Original"]);
  });

  it("rejects a same-key request that differs only in URL with 409 idempotency_key_reused", async () => {
    const t = (current = await makeTestApp());
    const key = "reuse-url-key-aaaaaaaaaaaa";
    const created = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 URL Original" }, key);
    expect(created.statusCode).toBe(200);

    // Same method, same body, different URL → request hash differs.
    const different = await injectIdempotent(t, "POST", "/api/projects?force=1", { name: "F07 URL Original" }, key);
    expect(different.statusCode).toBe(409);
    const body = different.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("idempotency_key_reused");
  });
});

describe("F07: HTTP integration — concurrent pending", () => {
  it("a second identical request while the first is still pending is rejected with 409 idempotency_in_progress", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const key = "progress-key-aaaaaaaaaaaa";

    // Inject a pending claim directly so we test the in-progress branch
    // without trying to deterministically wedge the Fastify handler.
    sqlite.prepare(
      `INSERT INTO idempotency_requests
         (key, method, url, request_hash, state, response_status, response_body, response_content_type, created_at, updated_at)
       VALUES (?, 'POST', '/api/projects', ?, 'pending', NULL, NULL, NULL, ?, ?)`,
    ).run(key, requestHash("POST", "/api/projects", { name: "F07 Progress" }), nowIsoForTest(), nowIsoForTest());

    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    const res = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Progress" }, key);
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("idempotency_in_progress");
    expect(res.headers["retry-after"]).toBeDefined();
    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("F07: HTTP integration — auth before claim", () => {
  it("unauthenticated request with Idempotency-Key returns 401 and creates no claim", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        "idempotency-key": "unauth-key-aaaaaaaaaaa",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "unauth" }),
    });
    expect(res.statusCode).toBe(401);
    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("authenticated request with bad CSRF and Idempotency-Key returns 403 and creates no claim", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: t.cookie,
        "idempotency-key": "csrf-key-aaaaaaaaaaaaa",
        "x-csrf-token": "wrong-token",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "csrf" }),
    });
    expect(res.statusCode).toBe(403);
    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("after a rejected auth/CSRF request the same key still works for a valid request", async () => {
    const t = (current = await makeTestApp());
    const key = "post-csrf-key-aaaaaaaaaaa";
    const badCsrf = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: t.cookie,
        "idempotency-key": key,
        "x-csrf-token": "wrong-token",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 After Csrf" }),
    });
    expect(badCsrf.statusCode).toBe(403);

    const good = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 After Csrf" }, key);
    expect(good.statusCode).toBe(200);
  });
});

describe("F07: HTTP integration — indeterminate outcome", () => {
  it("a finalized-indeterminate claim surfaces 409 idempotency_outcome_unknown without executing the handler", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const key = "outcome-key-aaaaaaaaaaaaa";

    // Direct injection: simulate "handler crashed between commit and finalize".
    tryClaim(sqlite, {
      key,
      method: "POST",
      url: "/api/projects",
      requestHash: requestHash("POST", "/api/projects", { name: "F07 Unknown" }),
    });
    finalizeClaim(sqlite, {
      key,
      state: "indeterminate",
      responseStatus: 500,
      responseBody: "",
      responseContentType: "",
    });
    const stored = (sqlite.prepare("SELECT state, response_status AS s FROM idempotency_requests WHERE key = ?").get(key) as {
      state: string;
      s: number | null;
    });
    expect(stored.state).toBe("indeterminate");
    expect(stored.s).toBe(500);

    const res = await injectIdempotent(t, "POST", "/api/projects", { name: "F07 Unknown" }, key);
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("idempotency_outcome_unknown");
    expect(body.error.message).toMatch(/may have already been applied/i);

    // The retry did NOT create a project row.
    const cnt = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects WHERE name = 'F07 Unknown'").get() as { n: number }).n;
    expect(cnt).toBe(0);
  });
});

describe("F07: HTTP integration — completed survives restart", () => {
  it("a completed claim on a temp on-disk DB is replayed exactly across app close/reopen", async () => {
    const first = await makeTestApp();
    const key = "restart-key-aaaaaaaaaaaaa";
    const send = await first.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: first.cookie,
        "x-csrf-token": first.csrf,
        "idempotency-key": key,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 Restart Project" }),
    });
    expect(send.statusCode).toBe(200);
    const firstBody = JSON.parse(send.payload) as { id: string; name: string };
    const dataDir = first.config.dataDir;
    await first.app.close();

    // Build a brand-new app over the SAME on-disk DB. buildApp opens it,
    // bootstrap runs the migration idempotently, and a fresh in-memory
    // runtime is constructed. No in-memory state should leak.
    const { buildApp } = await import("../src/app.js");
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig({
      NODE_ENV: "test",
      CK_DATA_DIR: dataDir,
      CK_SESSION_SECRET: "test-secret-0123456789abcdef",
    });
    const second = await buildApp({ config, logger: false });
    // Login again — fresh in-memory session state.
    const login = await second.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: ["ck", "test", "owner", "0123456789"].join("-") },
    });
    const sessionCookie = login.cookies.find((c) => c.name === "ck_session");
    const csrfCookie = login.cookies.find((c) => c.name === "ck_csrf");
    if (!sessionCookie || !csrfCookie) throw new Error("missing cookies on second login");
    const cookieHeader = `ck_session=${sessionCookie.value}; ck_csrf=${csrfCookie.value}`;

    const replay = await second.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": csrfCookie.value,
        "idempotency-key": key,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 Restart Project" }),
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.payload) as { id: string; name: string };
    expect(replayBody.id).toBe(firstBody.id);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");

    await second.close();
  });
});

describe("F07: HTTP integration — no header means no claim", () => {
  it("a mutation without Idempotency-Key still works (legacy behavior)", async () => {
    const t = (current = await makeTestApp());
    const res = await t.post("/api/projects", { name: "F07 Legacy No Key" });
    expect(res.statusCode).toBe(200);
    const sqlite = t.app.ck.deps.sqlite;
    const cnt = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(cnt).toBe(0);
  });
});

describe("F07 final: retired routes and multipart eligibility", () => {
  it("retired internal-chat routes return 404 and never create an idempotency claim", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const beforeClaims = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;

    const res = await t.app.inject({
      method: "POST",
      url: "/api/agent/threads/retired/messages",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "idempotency-key": "retired-route-key-aaaaaa",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ text: "retired" }),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.payload) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    const afterClaims = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(afterClaims).toBe(beforeClaims);
  });

  it("POST /api/imports/file with Idempotency-Key returns 400 idempotency_not_supported and creates no claim + no source/job", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const project = (await t.post("/api/projects", { name: "F07 Multipart Excluded" })).json<{ id: string }>();
    const beforeClaims = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    const beforeSources = (sqlite.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n;
    const beforeJobs = (sqlite.prepare("SELECT COUNT(*) AS n FROM import_jobs").get() as { n: number }).n;

    const form = new FormData();
    form.append("projectId", project.id);
    form.append("adapterId", "faketest");
    form.append("file", new Blob(["hello content"]), "notes.md");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/imports/file",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "idempotency-key": "multipart-key-aaaaaaaaaaaa",
        "content-type": `multipart/form-data; boundary=${(form as unknown as { _boundary?: string })._boundary ?? ""}`,
      },
      payload: form as unknown as never,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: { code: string; message: string; details: unknown } };
    expect(body.error.code).toBe("idempotency_not_supported");
    expect(body.error.message).toMatch(/not supported/i);
    expect(body.error.details).toEqual({ route: "/api/imports/file" });

    const afterClaims = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(afterClaims).toBe(beforeClaims);
    const afterSources = (sqlite.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n;
    expect(afterSources).toBe(beforeSources);
    const afterJobs = (sqlite.prepare("SELECT COUNT(*) AS n FROM import_jobs").get() as { n: number }).n;
    expect(afterJobs).toBe(beforeJobs);
  });

  it("POST /api/imports/file WITHOUT Idempotency-Key still imports (legacy multipart behavior)", async () => {
    const t = (current = await makeTestApp());
    const project = (await t.post("/api/projects", { name: "F07 Multipart Legacy" })).json<{ id: string }>();
    const form = new FormData();
    form.append("projectId", project.id);
    form.append("adapterId", "faketest");
    form.append("file", new Blob(["a fact: hello world"]), "notes.md");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/imports/file",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "content-type": `multipart/form-data; boundary=${(form as unknown as { _boundary?: string })._boundary ?? ""}`,
      },
      payload: form as unknown as never,
    });
    // 201 (created) or 200 (accepted); either way the legacy upload runs.
    expect([200, 201]).toContain(res.statusCode);
  });
});

describe("F07 (remediation): malformed Idempotency-Key fails closed", () => {
  it("too-short key returns 400 idempotency_key_invalid and does NOT execute the handler", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    const claimsBefore = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "idempotency-key": "abc", // < 8 chars
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 Short Key" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("idempotency_key_invalid");

    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before); // handler NOT executed
    const claimsAfter = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(claimsAfter).toBe(claimsBefore); // NO durable row created
  });

  it("illegal-character key returns 400 idempotency_key_invalid and does NOT execute the handler", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    const claimsBefore = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;

    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "idempotency-key": "has spaces and slashes / and ?",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 Illegal Key" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("idempotency_key_invalid");

    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before);
    const claimsAfter = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(claimsAfter).toBe(claimsBefore);
  });

  it("multi-value (array) Idempotency-Key header fails closed with 400 idempotency_key_invalid", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;

    // Inject with an array header — Fastify exposes raw Node headers here
    // when the test does so explicitly. isValidIdempotencyKey only accepts
    // single canonical strings, so the duplicate-array form must be rejected
    // rather than silently treated as absent.
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: {
        cookie: t.cookie,
        "x-csrf-token": t.csrf,
        "idempotency-key": ["abc", "def"],
        "content-type": "application/json",
      },
      payload: JSON.stringify({ name: "F07 Multi Key" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_invalid");
    const after = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("absent Idempotency-Key still falls through to legacy behavior (no 400)", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const claimsBefore = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    const res = await t.post("/api/projects", { name: "F07 Absent Key Legacy" });
    expect(res.statusCode).toBe(200);
    const claimsAfter = (sqlite.prepare("SELECT COUNT(*) AS n FROM idempotency_requests").get() as { n: number }).n;
    expect(claimsAfter).toBe(claimsBefore);
  });
});

describe("F07 (remediation): real Fastify 5xx → indeterminate via the production hooks", () => {
  it("a genuine 5xx through the real error handler and onSend hook leaves the claim `indeterminate`; retry is 409 idempotency_outcome_unknown", async () => {
    const t = (current = await makeTestApp());
    const sqlite = t.app.ck.deps.sqlite;
    const key = "five-x-real-key-aaaaaaaaa";

    // Monkey-patch the Drizzle insert for the `projects` table so the FIRST
    // authenticated POST /api/projects throws a generic Error after the
    // preHandler has claimed a pending row. The raw better-sqlite3 handle
    // (`deps.sqlite`) is left untouched so the onSend hook can still persist
    // the `indeterminate` finalization against it.
    const dbAny = t.app.ck.deps.db as unknown as { insert: (...args: unknown[]) => unknown };
    const projectsAny = (await import("../src/db/schema.js")).projects as unknown;
    const originalInsert = dbAny.insert.bind(t.app.ck.deps.db);
    let insertedOnce = false;
    dbAny.insert = ((...args: unknown[]) => {
      const first = args[0];
      if (!insertedOnce && first === projectsAny) {
        insertedOnce = true;
        throw new Error("simulated internal failure for F07 5xx test");
      }
      return (originalInsert as (...a: unknown[]) => unknown)(...args);
    }) as typeof dbAny.insert;

    try {
      const beforeProjects = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
      const auditBefore = (sqlite
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.created'")
        .get() as { n: number }).n;

      const first = await t.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: {
          cookie: t.cookie,
          "x-csrf-token": t.csrf,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "F07 Real 5xx" }),
      });
      // Real production error handler — generic Error becomes 500 internal_error.
      expect(first.statusCode).toBe(500);
      const firstBody = JSON.parse(first.payload) as { error: { code: string } };
      expect(firstBody.error.code).toBe("internal_error");

      // No project row was committed.
      const afterProjects = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
      expect(afterProjects).toBe(beforeProjects);
      const auditAfter = (sqlite
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.created'")
        .get() as { n: number }).n;
      expect(auditAfter).toBe(auditBefore);

      // The durable claim row exists, was finalized by the real onSend hook,
      // and is now `indeterminate`.
      const row = sqlite
        .prepare("SELECT state, response_status AS s FROM idempotency_requests WHERE key = ?")
        .get(key) as { state: string; s: number | null };
      expect(row.state).toBe("indeterminate");
      expect(row.s).toBe(500);

      // Retry the exact same request — must hit 409 idempotency_outcome_unknown
      // and MUST NOT execute the handler a second time (projects count and
      // audit count are unchanged).
      const retry = await t.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: {
          cookie: t.cookie,
          "x-csrf-token": t.csrf,
          "idempotency-key": key,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: "F07 Real 5xx" }),
      });
      expect(retry.statusCode).toBe(409);
      const retryBody = JSON.parse(retry.payload) as { error: { code: string; message: string } };
      expect(retryBody.error.code).toBe("idempotency_outcome_unknown");
      expect(retryBody.error.message).toMatch(/may have already been applied/i);

      const finalProjects = (sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
      expect(finalProjects).toBe(afterProjects);
      const finalAudit = (sqlite
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'project.created'")
        .get() as { n: number }).n;
      expect(finalAudit).toBe(auditAfter);
    } finally {
      dbAny.insert = originalInsert as typeof dbAny.insert;
    }
  });
});

// Silence unused-warning for the test-only helper; kept for future drill-in.
void _testDeleteClaim;
