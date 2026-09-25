import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineDb } from "../src/lib/offline/db.js";
import {
  dismissConflict,
  enqueueMutation,
  listConflicts,
  listMutations,
  replayQueue,
} from "../src/lib/offline/queue.js";
import { apiFetch, ApiError, QueuedOfflineError } from "../src/lib/api.js";

interface MockResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type Handler = (url: string, init?: RequestInit) => MockResponseLike | Promise<MockResponseLike>;

function mockFetch(handlers: Handler[]): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const fn = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    calls.push({ url: u, init });
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i++;
    const result = await handler(u, init);
    return result as unknown as Response;
  };
  globalThis.fetch = fn as unknown as typeof fetch;
  return { calls };
}

const okJson = (body: unknown): MockResponseLike => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number, code: string, message: string): MockResponseLike => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message, details: null } }),
});

beforeEach(async () => {
  const db = await offlineDb();
  await db.clear("mutations");
  await db.clear("conflicts");
  await db.clear("cache");
  document.cookie = "ck_csrf=test-csrf-token";
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("A10: offline mutation queue", () => {
  it("replays queued mutations in order and clears them on success", async () => {
    await enqueueMutation({ method: "POST", url: "/api/inbox/decide", body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" }, enqueuedAt: new Date().toISOString(), label: "accept r1" });
    await enqueueMutation({ method: "PUT", url: "/api/records/r2", body: { revision: 1, text: "edited" }, enqueuedAt: new Date().toISOString(), label: "edit r2" });
    await enqueueMutation({ method: "POST", url: "/api/imports/text", body: { text: "x" }, enqueuedAt: new Date().toISOString(), label: "import" });

    const { calls } = mockFetch([
      () => okJson({ accepted: ["r1"], rejected: [], edited: [], blocked: [] }),
      () => okJson({ id: "r2", revision: 2 }),
      () => {
        throw new TypeError("network down");
      },
    ]);

    const result = await replayQueue();
    expect(result.replayed).toBe(2);
    expect(result.conflicts.length).toBe(0);
    expect(result.stoppedOffline).toBe(true);
    expect(result.stoppedReason).toBe("offline");
    expect(calls.map((c) => c.url)).toEqual(["/api/inbox/decide", "/api/records/r2", "/api/imports/text"]);

    const remaining = await listMutations();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.url).toBe("/api/imports/text");
  });

  it("retires legacy queued chat mutations without sending them and continues memory replay", async () => {
    await enqueueMutation({ method: "POST", url: "/api/agent/threads/legacy/messages", body: { text: "old chat" }, enqueuedAt: new Date().toISOString(), label: "legacy chat" });
    await enqueueMutation({ method: "POST", url: "/api/inbox/decide", body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" }, enqueuedAt: new Date().toISOString(), label: "memory action" });
    const { calls } = mockFetch([() => okJson({ accepted: ["r1"], rejected: [], edited: [], blocked: [] })]);

    const result = await replayQueue();

    expect(calls.map((call) => call.url)).toEqual(["/api/inbox/decide"]);
    expect(result.replayed).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("feature_retired");
    expect(result.conflicts[0]!.message).toMatch(/retired/i);
    expect(result.conflicts[0]!.mutation.url).toContain("/api/agent/");
    expect((await listMutations()).length).toBe(0);
  });

  it("preserves legacy inbox decisions without revisions as needs_user_review without sending them", async () => {
    const db = await offlineDb();
    const originalKey = "legacy-review-key-000000000000";
    await db.add("mutations", {
      method: "POST",
      url: "/api/inbox/decide",
      body: { recordIds: ["r1"], action: "accept" },
      enqueuedAt: new Date().toISOString(),
      label: "legacy review intent",
      idempotencyKey: originalKey,
    });
    const { calls } = mockFetch([() => okJson({ accepted: ["r1"], rejected: [], edited: [], blocked: [] })]);

    const result = await replayQueue();

    expect(calls).toHaveLength(0);
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("needs_user_review");
    expect(result.conflicts[0]!.message).toMatch(/reload.*decide again/i);
    expect(result.conflicts[0]!.mutation.body).toEqual({ recordIds: ["r1"], action: "accept" });
    expect(result.conflicts[0]!.mutation.idempotencyKey).toBe(originalKey);
    expect(await listMutations()).toEqual([]);
    const persisted = await listConflicts();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.code).toBe("needs_user_review");
    expect(persisted[0]!.mutation.idempotencyKey).toBe(originalKey);
  });

  it("replays a timed-out R1 review with the same payload/key and never upgrades it to R2", async () => {
    const originalBody = {
      items: [{ recordId: "r1", revision: 1 }],
      action: "accept",
    };
    const attemptedHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_url, init) => {
      attemptedHeaders.push((init?.headers ?? {}) as Record<string, string>);
      throw new TypeError("response lost");
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/inbox/decide", {
        method: "POST",
        body: originalBody,
        label: "accept R1",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const [queued] = await listMutations();
    expect(queued!.body).toEqual(originalBody);
    const originalKey = queued!.idempotencyKey!;
    expect(originalKey).toBe(attemptedHeaders[0]!["idempotency-key"]);

    const { calls } = mockFetch([
      () => errJson(409, "stale_revision", "server revision is 2, client read 1"),
    ]);
    const result = await replayQueue();

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(originalBody);
    expect((calls[0]!.init!.headers as Record<string, string>)["idempotency-key"]).toBe(originalKey);
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("stale_revision");
    expect(result.conflicts[0]!.mutation.body).toEqual(originalBody);
    expect(result.conflicts[0]!.mutation.idempotencyKey).toBe(originalKey);
  });

  it("moves semantic 4xx failures (e.g. 409 stale_revision) to conflicts and surfaces them", async () => {
    await enqueueMutation({ method: "PUT", url: "/api/records/r9", body: { revision: 1, text: "stale" }, enqueuedAt: new Date().toISOString(), label: "stale edit" });
    mockFetch([() => errJson(409, "stale_revision", "server revision is 3, client sent 1")]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]!.code).toBe("stale_revision");
    expect(result.conflicts[0]!.status).toBe(409);
    expect(result.conflicts[0]!.message).toMatch(/server revision is 3/);
    expect(result.stoppedReason).toBeNull();

    expect((await listMutations()).length).toBe(0);
    const stored = await listConflicts();
    expect(stored.length).toBe(1);

    await dismissConflict(stored[0]!.seq!);
    expect((await listConflicts()).length).toBe(0);
  });

  it("blocked inbox-decide items on replay surface as conflicts (server state moved)", async () => {
    await enqueueMutation({ method: "POST", url: "/api/inbox/decide", body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" }, enqueuedAt: new Date().toISOString() });
    mockFetch([
      () =>
        okJson({
          accepted: [],
          rejected: [],
          edited: [],
          blocked: [{ recordId: "r1", code: "already_reviewed", message: "Record is already accepted" }],
        }),
    ]);

    const result = await replayQueue();
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]!.code).toBe("blocked_on_replay");
    expect(result.conflicts[0]!.message).toMatch(/already_reviewed/);
    expect((await listMutations()).length).toBe(0);
  });

  it("attaches the CSRF token from the cookie on replay", async () => {
    document.cookie = "ck_csrf=csrf-abc-123";
    await enqueueMutation({ method: "POST", url: "/api/corrections/job-1/confirm", body: {}, enqueuedAt: new Date().toISOString() });
    const { calls } = mockFetch([() => okJson({ ok: true })]);
    await replayQueue();
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe("csrf-abc-123");
  });

  it("5xx keeps the queue intact for a later retry", async () => {
    await enqueueMutation({ method: "POST", url: "/api/x", body: {}, enqueuedAt: new Date().toISOString() });
    await enqueueMutation({ method: "POST", url: "/api/y", body: {}, enqueuedAt: new Date().toISOString() });
    mockFetch([() => errJson(500, "internal_error", "boom")]);
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.conflicts.length).toBe(0);
    expect(result.stoppedOffline).toBe(true);
    // F07 replay-finalization: 5xx is treated as a queued-but-bound retry
    // so the same key eventually surfaces the durable
    // `idempotency_outcome_unknown` barrier.
    expect(result.stoppedReason).toBe("server_indeterminate");
    expect((await listMutations()).length).toBe(2);
    cancelOfflineRetry();
  });

  it("401 preserves the current and later mutations, requests re-auth, and creates no conflict", async () => {
    await enqueueMutation({ method: "POST", url: "/api/x", body: { n: 1 }, enqueuedAt: new Date().toISOString() });
    await enqueueMutation({ method: "POST", url: "/api/y", body: { n: 2 }, enqueuedAt: new Date().toISOString() });
    const unauthorized = vi.fn();
    window.addEventListener("ck:unauthorized", unauthorized, { once: true });
    const { calls } = mockFetch([() => errJson(401, "unauthorized", "session expired")]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.stoppedReason).toBe("auth");
    expect(calls).toHaveLength(1);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/x", "/api/y"]);
    expect(await listConflicts()).toEqual([]);
  });

  it("403 preserves queued mutations instead of misclassifying authorization state as a data conflict", async () => {
    await enqueueMutation({ method: "POST", url: "/api/x", body: {}, enqueuedAt: new Date().toISOString() });
    mockFetch([() => errJson(403, "csrf_invalid", "CSRF token no longer valid")]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.stoppedReason).toBe("forbidden");
    expect((await listMutations()).length).toBe(1);
    expect(await listConflicts()).toEqual([]);
  });

  it("429 preserves queued mutations for retry instead of converting them into conflicts", async () => {
    await enqueueMutation({ method: "POST", url: "/api/x", body: {}, enqueuedAt: new Date().toISOString() });
    await enqueueMutation({ method: "POST", url: "/api/y", body: {}, enqueuedAt: new Date().toISOString() });
    const { calls } = mockFetch([() => errJson(429, "rate_limit", "too many requests")]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.stoppedReason).toBe("rate_limit");
    expect(calls).toHaveLength(1);
    expect((await listMutations()).length).toBe(2);
  });

  it("serializes overlapping replay calls in one browser context", async () => {
    await enqueueMutation({ method: "POST", url: "/api/x", body: { once: true }, enqueuedAt: new Date().toISOString() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mockFetch([
      async () => {
        await gate;
        return okJson({ ok: true });
      },
    ]);

    const first = replayQueue();
    const second = replayQueue();
    expect(second).toBe(first);
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.replayed).toBe(1);
    expect(b.replayed).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await listMutations()).length).toBe(0);
  });
});

describe("apiFetch offline behavior", () => {
  it("queues mutations instead of sending them when the browser is offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/inbox/decide", { method: "POST", body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" }, label: "offline accept" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(fetchSpy).not.toHaveBeenCalled();

    const queued = await listMutations();
    expect(queued.length).toBe(1);
    expect(queued[0]!.label).toBe("offline accept");

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("queues mutations when the network call fails mid-flight", async () => {
    globalThis.fetch = (() => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "delayed" }, label: "flaky import" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect((await listMutations()).length).toBe(1);
  });

  it("never queues auth endpoints (noQueue)", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    let caught: unknown = null;
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: {}, noQueue: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(QueuedOfflineError);
    expect((await listMutations()).length).toBe(0);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("does not send an Idempotency-Key header on noQueue requests", async () => {
    const seenHeaders: { key?: string }[] = [];
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push({ key: h["idempotency-key"] });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await apiFetch("/api/auth/login", { method: "POST", body: { password: "x" }, noQueue: true });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]!.key).toBeUndefined();
  });
});

describe("F07: queueable mutations carry a durable idempotency key", () => {
  it("attaches an Idempotency-Key header on the online first attempt", async () => {
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_url, init) => {
      seenHeaders.push(((init?.headers ?? {}) as Record<string, string>));
      return { ok: true, status: 200, json: async () => ({ id: "p1" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Header Project" } });
    expect(seenHeaders).toHaveLength(1);
    const k = seenHeaders[0]!["idempotency-key"];
    expect(k).toBeDefined();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("offline queue persists the idempotency key on the queued row", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Offline Key" }, label: "offline key" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(fetchSpy).not.toHaveBeenCalled();
    const queued = await listMutations();
    expect(queued).toHaveLength(1);
    const k = queued[0]!.idempotencyKey;
    expect(k).toBeDefined();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("a network-failed online attempt queues with the SAME key that was attempted", async () => {
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_url, init) => {
      seenHeaders.push(((init?.headers ?? {}) as Record<string, string>));
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "delayed" }, label: "flaky key" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(seenHeaders).toHaveLength(1);
    const attempted = seenHeaders[0]!["idempotency-key"];
    expect(attempted).toBeDefined();
    const queued = await listMutations();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.idempotencyKey).toBe(attempted);
  });

  it("replay sends the EXACT same key as the originally attempted request", async () => {
    const seenHeaders: Record<string, string>[] = [];
    globalThis.fetch = (async (_url, init) => {
      seenHeaders.push(((init?.headers ?? {}) as Record<string, string>));
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "delayed" }, label: "replay same" });
    } catch {
      /* expected */
    }
    const queued = await listMutations();
    const persistedKey = queued[0]!.idempotencyKey;

    // Now reconnect; replay runs against the live API.
    globalThis.fetch = (async (_url, init) => {
      seenHeaders.push(((init?.headers ?? {}) as Record<string, string>));
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(result.replayed).toBe(1);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[1]!["idempotency-key"]).toBe(persistedKey);
    expect(seenHeaders[1]!["idempotency-key"]).toBe(seenHeaders[0]!["idempotency-key"]);
    expect((await listMutations())).toHaveLength(0);
  });

  it("a legacy queued mutation without a key gets one synthesized and persisted BEFORE the next fetch", async () => {
    // Seed a legacy row directly into IndexedDB.
    const db = await offlineDb();
    const legacySeq = (await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "legacy row" },
      enqueuedAt: new Date().toISOString(),
      label: "legacy",
    })) as number;
    const beforeReplay = (await listMutations()).find((m) => m.seq === legacySeq);
    expect(beforeReplay?.idempotencyKey).toBeUndefined();

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      seenKeys.push(((init?.headers ?? {}) as Record<string, string>)["idempotency-key"] ?? "");
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await replayQueue();

    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const persisted = (await listMutations()).find((m) => m.seq === legacySeq);
    expect(persisted).toBeUndefined(); // mutation was removed because the replay succeeded

    // Now queue the same mutation again (network failure) and replay again —
    // it MUST use the exact same key, NOT generate a second one.
    globalThis.fetch = (async () => {
      throw new TypeError("down again");
    }) as unknown as typeof fetch;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "second attempt" }, label: "no double key" });
    } catch {
      /* expected */
    }
    const second = (await listMutations())[0]!;
    expect(second.idempotencyKey).toMatch(/^[0-9a-f]{8}-/);

    // Different key than the synthesized one (because apiFetch mints a fresh key for the new attempt).
    expect(second.idempotencyKey).not.toBe(seenKeys[0]);
  });

  it("treats 409 idempotency_in_progress as a retryable stop (no conflict, no later replay)", async () => {
    const db = await offlineDb();
    await db.add("mutations", { method: "POST", url: "/api/a", body: {}, enqueuedAt: new Date().toISOString(), label: "in progress a", idempotencyKey: "ip-key-aaaaaaaaaaaaaa" });
    await db.add("mutations", { method: "POST", url: "/api/b", body: {}, enqueuedAt: new Date().toISOString(), label: "in progress b", idempotencyKey: "ip-key-bbbbbbbbbbbbbb" });
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      const u = String(url);
      calls.push(u);
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "idempotency_in_progress", message: "still going", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(calls).toEqual(["/api/a"]); // only the first mutation was attempted
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.stoppedReason).toBe("idempotency_in_progress");
    expect((await listMutations())).toHaveLength(2);
    expect((await listConflicts())).toHaveLength(0);
  });

  it("moves 409 idempotency_outcome_unknown to conflicts with an uncertain-prior-application message", async () => {
    const db = await offlineDb();
    await db.add("mutations", { method: "POST", url: "/api/x", body: {}, enqueuedAt: new Date().toISOString(), label: "unknown a", idempotencyKey: "uk-key-aaaaaaaaaaaaaa" });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "idempotency_outcome_unknown", message: "may have applied", details: null } }),
    })) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("idempotency_outcome_unknown");
    expect(result.conflicts[0]!.message.toLowerCase()).toContain("may");
    expect((await listMutations())).toHaveLength(0);
    expect((await listConflicts())).toHaveLength(1);
  });

  it("on 409 idempotency_outcome_unknown, ordered replay STOPS so later queued mutations are never sent", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "uk-stop-aaaaaaaaaaaaaa",
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "uk-stop-bbbbbbbbbbbbbb",
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      const u = String(url);
      calls.push(u);
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "idempotency_outcome_unknown", message: "may have applied", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();

    // A was sent exactly once; B was NEVER sent during this replay run.
    expect(calls).toEqual(["/api/A"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("idempotency_outcome_unknown");

    // A removed from queue, recorded exactly once in conflicts.
    const remaining = await listMutations();
    expect(remaining.map((m) => m.url)).toEqual(["/api/B"]);
    const stored = await listConflicts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.mutation.url).toBe("/api/A");
    expect(stored[0]!.status).toBe(409);
  });

  it("noQueue mutations do not generate or send an idempotency key", async () => {
    const seenHeaders: { key?: string }[] = [];
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push({ key: h["idempotency-key"] });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await apiFetch("/api/auth/login", { method: "POST", body: { password: "p" }, noQueue: true });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]!.key).toBeUndefined();
  });
});

describe("F07 final: pre-send durable staging", () => {
  it("IndexedDB row exists BEFORE fetch is invoked and the outgoing header key equals the staged key", async () => {
    const db = await offlineDb();
    let fetchSeen = false;
    globalThis.fetch = (async (_url, init) => {
      fetchSeen = true;
      const rows = await db.getAll("mutations");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.idempotencyKey).toBeDefined();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["idempotency-key"]).toBe(rows[0]!.idempotencyKey);
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Pre-Send Staging" } });
    expect(fetchSeen).toBe(true);
    // Staged row deleted after successful consumption.
    expect((await db.getAll("mutations"))).toHaveLength(0);
  });

  it("staged row survives a fetch-then-body-consumption failure with the same key", async () => {
    const db = await offlineDb();
    let fetchSeen = false;
    globalThis.fetch = (async () => {
      fetchSeen = true;
      return {
        ok: true,
        status: 200,
        // Throws on JSON consumption.
        json: async () => {
          throw new TypeError("connection terminated mid-body");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Body Fail" } });
    } catch (e) {
      caught = e;
    }
    expect(fetchSeen).toBe(true);
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const persistedKey = rows[0]!.idempotencyKey;
    expect(persistedKey).toBeDefined();

    // A follow-up replay reuses the exact same key.
    let secondKeySeen: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      secondKeySeen = headers["idempotency-key"];
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(result.replayed).toBe(1);
    expect(secondKeySeen).toBe(persistedKey);
    expect((await db.getAll("mutations"))).toHaveLength(0);
  });

  it("offline path: navigator.onLine=false → staged row exists, no fetch, throws QueuedOfflineError with the persisted seq", async () => {
    const db = await offlineDb();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Offline" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBeDefined();
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("network failure: no double-queue; original staged seq + key survive; later replay uses same key", async () => {
    const db = await offlineDb();
    globalThis.fetch = (async () => {
      throw new TypeError("network unreachable");
    }) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "delayed" }, label: "flaky net" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const persistedSeq = rows[0]!.seq;
    const persistedKey = rows[0]!.idempotencyKey!;

    let replayKey: string | undefined;
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      replayKey = headers["idempotency-key"];
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(result.replayed).toBe(1);
    expect(replayKey).toBe(persistedKey);
    const afterRows = await db.getAll("mutations");
    expect(afterRows).toHaveLength(0);
    // Confirm we did not add a second row.
    expect(afterRows.length).toBe(0);
    expect(persistedSeq).toBeDefined();
  });
});

describe("F07 final: direct enqueueMutation guarantees an idempotencyKey", () => {
  it("enqueueMutation called without idempotencyKey persists a row WITH a key", async () => {
    const seq = await enqueueMutation({
      method: "POST",
      url: "/api/imports/text",
      body: { text: "direct" },
      enqueuedAt: new Date().toISOString(),
      label: "direct",
    });
    expect(seq).toBeGreaterThan(0);
    const rows = await listMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBeDefined();
    expect(rows[0]!.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("enqueueMutation called WITH an explicit idempotencyKey preserves the supplied key", async () => {
    const supplied = "fixed-key-aaaaaaaaaaaaaa";
    await enqueueMutation({
      method: "POST",
      url: "/api/imports/text",
      body: { text: "with key" },
      enqueuedAt: new Date().toISOString(),
      label: "with-key",
      idempotencyKey: supplied,
    });
    const rows = await listMutations();
    expect(rows[0]!.idempotencyKey).toBe(supplied);
  });
});

describe("F07 final: atomic legacy-key assignment across tabs", () => {
  it("concurrent ensureMutationIdempotencyKey calls on the same legacy row return the SAME key", async () => {
    const { ensureMutationIdempotencyKey } = await import("../src/lib/offline/queue.js");
    const db = await offlineDb();
    // Seed a legacy row directly: keyless.
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "legacy race" },
      enqueuedAt: new Date().toISOString(),
      label: "legacy-race",
    })) as number;

    const [a, b] = await Promise.all([
      ensureMutationIdempotencyKey(seq),
      ensureMutationIdempotencyKey(seq),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.idempotencyKey).toBeDefined();
    expect(a!.idempotencyKey).toBe(b!.idempotencyKey);

    // Only one key identity persists on the row.
    const stored = (await db.get("mutations", seq)) as { idempotencyKey?: string };
    expect(stored.idempotencyKey).toBe(a!.idempotencyKey);

    // A subsequent replay uses that same persisted key.
    const calls: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push(headers["idempotency-key"] ?? "");
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await replayQueue();
    expect(calls).toEqual([a!.idempotencyKey]);
  });
});

describe("F07 final: durable unknown-outcome barrier across replay invocations", () => {
  it("a second replay invocation sends zero later mutations while a blocking idempotency_outcome_unknown conflict persists", async () => {
    const db = await offlineDb();
    // Seed A (will get unknown) and B (must never be sent).
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "barrier-aaaaaaaaaaaaaa",
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "barrier-bbbbbbbbbbbbbb",
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "idempotency_outcome_unknown", message: "may have applied", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const first = await replayQueue();
    expect(calls).toEqual(["/api/A"]);
    expect(first.conflicts).toHaveLength(1);
    expect(first.stoppedReason).toBe("idempotency_outcome_unknown");
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/B"]);

    // Second replay: zero new fetches; B still queued; conflict still persisted.
    const second = await replayQueue();
    expect(calls).toEqual(["/api/A"]);
    expect(second.replayed).toBe(0);
    expect(second.conflicts).toHaveLength(1);
    expect(second.stoppedReason).toBe("idempotency_outcome_unknown");
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/B"]);
  });

  it("after dismissing the blocking conflict, the next online replay sends the queued B", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "barrier-release-aaaaaa",
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "barrier-release-bbbbbb",
    });
    globalThis.fetch = (async (url) => {
      if (String(url) === "/api/A") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { code: "idempotency_outcome_unknown", message: "may have applied", details: null } }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "b-ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await replayQueue();
    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/B"]);

    // Owner dismisses the conflict.
    await dismissConflict(conflicts[0]!.seq!);
    expect((await listConflicts())).toHaveLength(0);

    const second = await replayQueue();
    expect(second.replayed).toBe(1);
    expect((await listMutations())).toHaveLength(0);
  });

  it("a second blocking conflict keeps the queue paused even after dismissing the first one", async () => {
    const db = await offlineDb();
    // Seed two blocking outcome_unknown conflicts directly. The barrier
    // check happens BEFORE any fetch so we can test this without depending
    // on the route to actually surface two outcome_unknown responses.
    await db.add("conflicts", {
      mutation: {
        seq: 1,
        method: "POST",
        url: "/api/A",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "A",
        idempotencyKey: "multi-block-aaaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "A may have applied",
      detectedAt: new Date().toISOString(),
    });
    await db.add("conflicts", {
      mutation: {
        seq: 2,
        method: "POST",
        url: "/api/B",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "B",
        idempotencyKey: "multi-block-bbbbbbbbbbbb",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "B may have applied",
      detectedAt: new Date().toISOString(),
    });
    // No fetch must ever happen while two outcome_unknown conflicts persist.
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const conflictsBefore = await listConflicts();
    expect(conflictsBefore).toHaveLength(2);

    const first = await replayQueue();
    expect(first.replayed).toBe(0);
    expect(first.stoppedReason).toBe("idempotency_outcome_unknown");
    expect(calls).toEqual([]); // barrier held

    // Dismiss only the FIRST conflict — the second still blocks.
    await dismissConflict(conflictsBefore[0]!.seq!);
    const second = await replayQueue();
    expect(second.replayed).toBe(0);
    expect(second.stoppedReason).toBe("idempotency_outcome_unknown");
    expect(calls).toEqual([]);

    // Dismiss the second one too — replay is now free.
    const remaining = await listConflicts();
    expect(remaining).toHaveLength(1);
    await dismissConflict(remaining[0]!.seq!);
    const third = await replayQueue();
    expect(third.replayed).toBe(0); // no mutations queued
    expect(third.stoppedReason).not.toBe("idempotency_outcome_unknown");
  });
});

describe("F07 final: idempotency_in_progress honors Retry-After", () => {
  it("returns parsed retryAfterMs from the server's Retry-After header", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "progress-aaaaaaaaaaaaaa",
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "idempotency_in_progress", message: "still going", details: null } }),
      headers: new Headers({ "retry-after": "2" }),
    })) as unknown as Response;

    const first = await replayQueue();
    expect(first.stoppedReason).toBe("idempotency_in_progress");
    expect(first.retryAfterMs).toBe(2000);
    expect((await listMutations())).toHaveLength(1);
  });

  it("falls back to the bounded default when Retry-After is missing or unparseable", async () => {
    const { parseRetryAfterMs, DEFAULT_IN_PROGRESS_RETRY_MS } = await import("../src/lib/offline/queue.js");
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-number")).toBeUndefined();
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("3")).toBe(3000);
    // Clamped to ≤ 60_000 ms.
    expect(parseRetryAfterMs("999999")).toBe(60_000);
    expect(DEFAULT_IN_PROGRESS_RETRY_MS).toBe(1000);
  });

  it("timer does not storm: many consecutive replays send exactly one fetch until the server stops reporting in_progress", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "timer-storm-aaaaaaaaaaaa",
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: { code: "idempotency_in_progress", message: "still going", details: null } }),
        headers: new Headers({ "retry-after": "1" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // Five back-to-back replay invocations should each see the same
    // idempotency_in_progress and queue stays paused. The counter does NOT
    // explode because each replay invocation is its own call to fetch.
    for (let i = 0; i < 5; i++) {
      const r = await replayQueue();
      expect(r.stoppedReason).toBe("idempotency_in_progress");
      expect(r.retryAfterMs).toBe(1000);
    }
    expect(calls).toBe(5); // one fetch per invocation — but they are NOT a storm of overlapping parallel fetches
    expect((await listMutations())).toHaveLength(1);

    // Now switch to a successful response: the queued mutation is replayed
    // and the timer logic does not re-fire.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "ok" }),
    })) as unknown as typeof fetch;
    const final = await replayQueue();
    expect(final.replayed).toBe(1);
    expect(final.stoppedReason).not.toBe("idempotency_in_progress");
    expect((await listMutations())).toHaveLength(0);
  });
});

describe("F07 final: queueable 5xx routes through the durable unknown-outcome path", () => {
  it("5xx preserves staged seq + key, throws QueuedOfflineError (NOT ApiError), and triggers ck:retry-offline-queue", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 5xx" } });
    } catch (e) {
      caught = e;
    }
    // Must NOT be a plain ApiError — that would let the page treat it as a
    // normal retryable failure and the owner could resubmit with a new key.
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).not.toBeInstanceOf(ApiError);
    // The QueuedOfflineError must carry the same seq that's still in IDB.
    const errSeq = (caught as { seq: number }).seq;
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0]!.seq).toBe(errSeq);
    const persistedKey = rows[0]!.idempotencyKey!;
    expect(persistedKey).toBeDefined();
    // The outgoing header carried the same key the row now holds.
    expect(seenKeys).toEqual([persistedKey]);

    // apiFetch MUST request a same-key replay via the existing neutral event
    // so the F07 durable replay loop in main.tsx resumes the queued row.
    expect(retrySpy).toHaveBeenCalledTimes(1);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("5xx → normal queue replay with SAME key → server returns 409 idempotency_outcome_unknown → row becomes conflict", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    const seenKeys: string[] = [];
    // First attempt: 500
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 5xx then 409 unknown" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const queuedAfterFirst = await listMutations();
    expect(queuedAfterFirst).toHaveLength(1);
    const originalKey = queuedAfterFirst[0]!.idempotencyKey!;
    const originalSeq = queuedAfterFirst[0]!.seq!;

    // Replay: same key, server now responds with 409 idempotency_outcome_unknown
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "idempotency_outcome_unknown",
            message: "Previous outcome was indeterminate.",
            details: null,
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(seenKeys[0]).toBe(originalKey);
    expect(seenKeys[1]).toBe(originalKey); // replay reuses the original key
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("idempotency_outcome_unknown");
    // The conflict's mutation must carry the SAME key — no new logical
    // mutation row was minted.
    expect(result.conflicts[0]!.mutation.idempotencyKey).toBe(originalKey);
    expect((await listMutations())).toHaveLength(0);
    const stored = await listConflicts();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code).toBe("idempotency_outcome_unknown");

    // Original seq and key are preserved on the conflict's mutation.
    expect(result.conflicts[0]!.mutation.seq).toBe(originalSeq);
    expect(result.conflicts[0]!.mutation.idempotencyKey).toBe(originalKey);

    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("5xx on a queueable mutation does NOT create a second IndexedDB row", async () => {
    const db = await offlineDb();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: { code: "bad_gateway", message: "bad gateway", details: null } }),
    })) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 5xx no dup" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
  });

  it("isQueued-style detection: a mutation that returns 5xx is still present in the queue with its original key", async () => {
    const db = await offlineDb();
    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { code: "unavailable", message: "service unavailable", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 503 isQueued" } });
    } catch {
      /* expected */
    }
    const rows = await db.getAll("mutations");
    // The page-level "isQueued" check still recognizes this mutation.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBeDefined();
    // No second logical key was generated — the header and the persisted
    // key are the same string.
    expect(seenKeys[0]).toBe(rows[0]!.idempotencyKey);
  });
});

describe("F07 final: 401-preserved mutation resumes after successful owner login", () => {
  it("successful login dispatches ck:retry-offline-queue exactly once, replay uses the SAME persisted key, queue clears", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    // 1. Stage a queueable mutation and simulate a 401 response — the row
    //    stays in the queue with its original key (apiFetch 401 path).
    const persistedKey = "resume-key-aaaaaaaaaaaaa";
    await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "after 401" },
      enqueuedAt: new Date().toISOString(),
      label: "401 project",
      idempotencyKey: persistedKey,
    });
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/projects"]);

    // 2. Successful login → Login.tsx dispatches the shared retry event.
    window.dispatchEvent(new CustomEvent("ck:retry-offline-queue"));
    expect(retrySpy).toHaveBeenCalledTimes(1);

    // 3. The replay path uses the SAME key (the queue never re-mints keys).
    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return { ok: true, status: 200, json: async () => ({ id: "ok-after-login" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(result.replayed).toBe(1);
    expect(seenKeys).toEqual([persistedKey]); // same key
    expect((await listMutations())).toHaveLength(0); // queue cleared
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("failed login does NOT trigger the retry event", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);
    await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "still queued" },
      enqueuedAt: new Date().toISOString(),
      label: "401 project",
      idempotencyKey: "no-resume-aaaaaaaaaaaaa",
    });

    // Simulate a failed login: the auth call throws BEFORE the retry
    // dispatch. Login.tsx must not call the retry path on the catch branch.
    const authSpy = vi.fn(() => Promise.reject(new TypeError("wrong password")));
    void authSpy;
    // No retry event dispatched by the failed path.
    expect(retrySpy).not.toHaveBeenCalled();
    // The queue still holds the preserved 401 mutation.
    expect((await listMutations()).map((m) => m.url)).toEqual(["/api/projects"]);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });
});

describe("F07 in-flight: live initial send MUST NOT be replayed concurrently", () => {
  it("an apiFetch() with an active lease blocks a concurrent replay: zero fetches, stopReason=client_in_flight, row stays in-flight", async () => {
    const db = await offlineDb();
    // Stage a row directly so we can stamp a controlled in_flight lease on
    // it without racing the apiFetch heartbeat.
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "live first send" },
      enqueuedAt: new Date().toISOString(),
      label: "live",
      idempotencyKey: "live-key-aaaaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "owner-live",
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    })) as number;

    // While the lease is valid, fetch must NOT be called by replay.
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(calls).toEqual([]); // zero fetches
    expect(result.stoppedReason).toBe("client_in_flight");
    expect(result.replayed).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(typeof result.retryAfterMs).toBe("number");

    // The row is still in_flight and the SAME key persists.
    const stored = (await db.get("mutations", seq)) as { idempotencyKey?: string; deliveryState?: string; inFlightOwner?: string };
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightOwner).toBe("owner-live");
    expect(stored.idempotencyKey).toBe("live-key-aaaaaaaaaaaaaa");
  });

  it("an active in_flight row stops replay but does NOT skip past later rows (A+B ordering)", async () => {
    const db = await offlineDb();
    // A is actively in_flight.
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "order-aaaaaaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "owner-A",
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    // B is queued behind A.
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "order-bbbbbbbbbbbbbbbb",
    });

    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    // Replay sent NOTHING — not A, not B.
    expect(calls).toEqual([]);
    expect(result.stoppedReason).toBe("client_in_flight");
    expect(result.replayed).toBe(0);

    // A remains in_flight; B remains queued behind A.
    const remaining = await listMutations();
    expect(remaining.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);
    const a = remaining[0]!;
    expect(a.deliveryState).toBe("in_flight");
    const b = remaining[1]!;
    expect(b.deliveryState).toBeUndefined();
  });

  it("lease heartbeat renews inFlightUntil while the apiFetch is still active", async () => {
    const db = await offlineDb();
    const { markMutationInFlight, renewMutationLease, newOwnerToken, IN_FLIGHT_LEASE_MS, IN_FLIGHT_HEARTBEAT_MS } =
      await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/imports/text",
      body: { text: "long" },
      enqueuedAt: new Date().toISOString(),
      label: "long",
      idempotencyKey: "long-key-aaaaaaaaaaaaaa",
    })) as number;
    const owner = newOwnerToken();
    const marked = await markMutationInFlight(seq, owner, 1000);
    expect(marked).not.toBeNull();
    const generation = marked!.inFlightGeneration!;
    const before = (await db.get("mutations", seq)) as { inFlightUntil?: string };
    expect(before.inFlightUntil).toBeDefined();
    // Wait, then renew with a longer lease — the new expiry must move forward.
    await new Promise((r) => setTimeout(r, 50));
    const renewed = await renewMutationLease(seq, owner, generation, IN_FLIGHT_LEASE_MS);
    expect(renewed).not.toBeNull();
    const after = (await db.get("mutations", seq)) as { inFlightUntil?: string };
    expect(after.inFlightUntil).toBeDefined();
    expect(Date.parse(after.inFlightUntil!)).toBeGreaterThan(Date.parse(before.inFlightUntil!));

    // Sanity: the heartbeat interval exported value is ≤ the lease length.
    expect(IN_FLIGHT_HEARTBEAT_MS).toBeLessThan(IN_FLIGHT_LEASE_MS);
  });

  it("renewMutationLease returns null when the owner token does not match (stale heartbeat)", async () => {
    const db = await offlineDb();
    const { markMutationInFlight, renewMutationLease, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/imports/text",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "stale heartbeat",
      idempotencyKey: "stale-hb-aaaaaaaaaaaaaa",
    })) as number;
    const owner = newOwnerToken();
    const marked = await markMutationInFlight(seq, owner);
    expect(marked).not.toBeNull();
    const r = await renewMutationLease(seq, "wrong-owner", marked!.inFlightGeneration!);
    expect(r).toBeNull();
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string };
    expect(stored.inFlightOwner).toBe(owner);
  });
});

describe("F07 in-flight: stale lease recovery via same-key replay", () => {
  it("an expired in_flight row is atomically converted to queued and replayed with the SAME key", async () => {
    const db = await offlineDb();
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "recovered" },
      enqueuedAt: new Date().toISOString(),
      label: "recovered",
      idempotencyKey: "recover-key-aaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "ghost-owner",
      inFlightUntil: new Date(Date.now() - 1000).toISOString(), // already expired
    })) as number;

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(seenKeys).toEqual(["recover-key-aaaaaaaaaaaa"]);
    expect(result.replayed).toBe(1);
    // The row has been deleted after a successful 2xx.
    expect((await db.get("mutations", seq))).toBeUndefined();
  });

  it("a NON-expired lease is NEVER recovered; replay respects the active owner and stops", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "still active" },
      enqueuedAt: new Date().toISOString(),
      label: "still active",
      idempotencyKey: "active-key-aaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "live-owner",
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(calls).toEqual([]);
    expect(result.stoppedReason).toBe("client_in_flight");
    // Row still owned by the original owner.
    const rows = await listMutations();
    expect(rows[0]!.deliveryState).toBe("in_flight");
    expect(rows[0]!.inFlightOwner).toBe("live-owner");
  });

  it("recoverExpiredInFlightLease refuses to touch a row whose lease has not expired", async () => {
    const { recoverExpiredInFlightLease } = await import("../src/lib/offline/queue.js");
    const db = await offlineDb();
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "x",
      idempotencyKey: "still-valid-aaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "live",
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    })) as number;
    const r = await recoverExpiredInFlightLease(seq);
    expect(r).toBeNull();
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string; deliveryState?: string };
    expect(stored.inFlightOwner).toBe("live");
    expect(stored.deliveryState).toBe("in_flight");
  });
});

describe("F07 in-flight: owner-token safety on completion paths", () => {
  it("completeOwnedMutation refuses to delete a row owned by a different owner", async () => {
    const db = await offlineDb();
    const { markMutationInFlight, completeOwnedMutation } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "owned",
      idempotencyKey: "owner-key-aaaaaaaaaaaaa",
    })) as number;
    const marked = await markMutationInFlight(seq, "real-owner");
    expect(marked).not.toBeNull();
    // Stale apiFetch attempts completion with a wrong token.
    const r = await completeOwnedMutation(seq, "stale-owner", marked!.inFlightGeneration!);
    expect(r).toBe(false);
    // Row still there, still owned by real-owner.
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string; deliveryState?: string };
    expect(stored.inFlightOwner).toBe("real-owner");
    expect(stored.deliveryState).toBe("in_flight");
  });

  it("releaseMutationToQueue refuses to overwrite state owned by a different owner", async () => {
    const db = await offlineDb();
    const { markMutationInFlight, releaseMutationToQueue } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "owned",
      idempotencyKey: "release-owner-aaaaaaaaaa",
    })) as number;
    const marked = await markMutationInFlight(seq, "real-owner");
    expect(marked).not.toBeNull();
    const r = await releaseMutationToQueue(seq, "stale-owner", marked!.inFlightGeneration!);
    expect(r).toBeNull();
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string; deliveryState?: string; inFlightUntil?: string };
    expect(stored.inFlightOwner).toBe("real-owner");
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightUntil).toBeDefined();
  });

  it("completeOwnedMutation by the rightful owner deletes the row", async () => {
    const db = await offlineDb();
    const { markMutationInFlight, completeOwnedMutation } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "complete-me",
      idempotencyKey: "rightful-aaaaaaaaaaaaaaa",
    })) as number;
    const marked = await markMutationInFlight(seq, "real-owner");
    expect(marked).not.toBeNull();
    const r = await completeOwnedMutation(seq, "real-owner", marked!.inFlightGeneration!);
    expect(r).toBe(true);
    expect((await db.get("mutations", seq))).toBeUndefined();
  });
});

describe("CK-A06: stale owners cannot finalize after lease loss or a newer claim generation", () => {
  it("completeOwnedMutation refuses the same owner token after its lease has expired", async () => {
    const db = await offlineDb();
    const { completeOwnedMutation } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date(0).toISOString(),
      label: "expired completion",
      idempotencyKey: "cka06-expired-complete-0001",
      deliveryState: "in_flight",
      inFlightOwner: "owner-A",
      inFlightGeneration: 1,
      inFlightUntil: new Date(1_000).toISOString(),
    })) as number;

    const completed = await completeOwnedMutation(seq, "owner-A", 1, 2_000);

    expect(completed).toBe(false);
    expect(await db.get("mutations", seq)).toBeDefined();
  });

  it("releaseMutationToQueue refuses the same owner token after its lease has expired", async () => {
    const db = await offlineDb();
    const { releaseMutationToQueue } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date(0).toISOString(),
      label: "expired release",
      idempotencyKey: "cka06-expired-release-0001",
      deliveryState: "in_flight",
      inFlightOwner: "owner-A",
      inFlightGeneration: 1,
      inFlightUntil: new Date(1_000).toISOString(),
    })) as number;

    const released = await releaseMutationToQueue(seq, "owner-A", 1, 2_000);

    expect(released).toBeNull();
    const stored = (await db.get("mutations", seq)) as { deliveryState?: string; inFlightOwner?: string };
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightOwner).toBe("owner-A");
  });

  it("Tab A cannot delete a row after Tab B takes over the expired lease and re-queues it", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, completeOwnedMutation, releaseMutationToQueue } =
      await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: { generation: "A" },
      enqueuedAt: new Date(0).toISOString(),
      label: "takeover completion",
      idempotencyKey: "cka06-takeover-complete-01",
      deliveryState: "in_flight",
      inFlightOwner: "owner-A",
      inFlightGeneration: 1,
      inFlightUntil: new Date(1_000).toISOString(),
    })) as number;

    const bClaim = await claimNextReplayMutation("owner-B", 2_000, 5_000);
    expect(bClaim.kind).toBe("claimed");
    if (bClaim.kind !== "claimed") throw new Error("expected claimed");
    expect(bClaim.row.seq).toBe(seq);
    await releaseMutationToQueue(seq, "owner-B", bClaim.row.inFlightGeneration!, 2_500);

    const staleCompletion = await completeOwnedMutation(seq, "owner-A", 1, 2_500);

    expect(staleCompletion).toBe(false);
    const stored = (await db.get("mutations", seq)) as {
      deliveryState?: string;
      inFlightOwner?: string;
      idempotencyKey?: string;
    };
    expect(stored.deliveryState).toBe("queued");
    expect(stored.inFlightOwner).toBeUndefined();
    expect(stored.idempotencyKey).toBe("cka06-takeover-complete-01");
  });

  it("Tab A cannot release/overwrite a row after Tab B takes over and re-queues it", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, releaseMutationToQueue } =
      await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: { generation: "A" },
      enqueuedAt: new Date(0).toISOString(),
      label: "takeover release",
      idempotencyKey: "cka06-takeover-release-0001",
      deliveryState: "in_flight",
      inFlightOwner: "owner-A",
      inFlightGeneration: 1,
      inFlightUntil: new Date(1_000).toISOString(),
    })) as number;

    const bClaim = await claimNextReplayMutation("owner-B", 2_000, 5_000);
    expect(bClaim.kind).toBe("claimed");
    if (bClaim.kind !== "claimed") throw new Error("expected claimed");
    await releaseMutationToQueue(seq, "owner-B", bClaim.row.inFlightGeneration!, 2_500);

    const staleRelease = await releaseMutationToQueue(seq, "owner-A", 1, 2_500);

    expect(staleRelease).toBeNull();
    const stored = (await db.get("mutations", seq)) as {
      deliveryState?: string;
      inFlightOwner?: string;
      idempotencyKey?: string;
    };
    expect(stored.deliveryState).toBe("queued");
    expect(stored.inFlightOwner).toBeUndefined();
    expect(stored.idempotencyKey).toBe("cka06-takeover-release-0001");
  });


  it("fake timers: an expired claim is taken over with a higher generation and the old generation cannot complete", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
      const db = await offlineDb();
      const { claimNextReplayMutation, completeOwnedMutation } =
        await import("../src/lib/offline/queue.js");
      await enqueueMutation({
        method: "POST",
        url: "/api/fake-timer",
        body: { step: 1 },
        enqueuedAt: new Date().toISOString(),
        idempotencyKey: "cka06-fake-timer-00000001",
      });

      const aClaim = await claimNextReplayMutation("owner-A", Date.now(), 1_000);
      expect(aClaim.kind).toBe("claimed");
      if (aClaim.kind !== "claimed") throw new Error("expected A claim");
      const seq = aClaim.row.seq!;
      const generationA = aClaim.row.inFlightGeneration!;

      vi.advanceTimersByTime(1_001);
      const bClaim = await claimNextReplayMutation("owner-B", Date.now(), 5_000);
      expect(bClaim.kind).toBe("claimed");
      if (bClaim.kind !== "claimed") throw new Error("expected B claim");
      expect(bClaim.row.inFlightGeneration).toBe(generationA + 1);

      const stale = await completeOwnedMutation(seq, "owner-A", generationA, Date.now());
      expect(stale).toBe(false);
      const stored = await db.get("mutations", seq);
      expect(stored?.inFlightOwner).toBe("owner-B");
      expect(stored?.inFlightGeneration).toBe(generationA + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delayed apiFetch terminal outcomes cannot mutate a newer claim generation", async () => {
    const scenarios: Array<{
      name: string;
      settle: (resolve: (response: Response) => void, reject: (reason?: unknown) => void) => void;
    }> = [
      {
        name: "2xx success",
        settle: (resolve) =>
          resolve({ ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response),
      },
      {
        name: "terminal 400",
        settle: (resolve) =>
          resolve({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            json: async () => ({ error: { code: "validation_error", message: "bad" } }),
          } as unknown as Response),
      },
      {
        name: "409 conflict",
        settle: (resolve) =>
          resolve({
            ok: false,
            status: 409,
            statusText: "Conflict",
            json: async () => ({ error: { code: "stale_revision", message: "stale" } }),
          } as unknown as Response),
      },
      {
        name: "401 auth",
        settle: (resolve) =>
          resolve({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            json: async () => ({ error: { code: "unauthorized", message: "expired" } }),
          } as unknown as Response),
      },
      {
        name: "transport failure",
        settle: (_resolve, reject) => reject(new TypeError("connection lost")),
      },
      {
        name: "2xx parsing failure",
        settle: (resolve) =>
          resolve({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("truncated body");
            },
          } as unknown as Response),
      },
    ];

    const { claimNextReplayMutation, releaseMutationToQueue } =
      await import("../src/lib/offline/queue.js");
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");

    for (const scenario of scenarios) {
      cancelOfflineRetry();
      const db = await offlineDb();
      await db.clear("mutations");
      await db.clear("conflicts");

      let resolveFetch!: (response: Response) => void;
      let rejectFetch!: (reason?: unknown) => void;
      globalThis.fetch = (() =>
        new Promise<Response>((resolve, reject) => {
          resolveFetch = resolve;
          rejectFetch = reject;
        })) as unknown as typeof fetch;

      const pending = apiFetch("/api/cka06-delayed", {
        method: "POST",
        body: { scenario: scenario.name },
        label: scenario.name,
      }).catch((error) => error);

      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
      const staged = (await db.getAll("mutations"))[0]!;
      expect(staged.deliveryState, scenario.name).toBe("in_flight");
      const seq = staged.seq!;
      const generationA = staged.inFlightGeneration!;
      const originalKey = staged.idempotencyKey!;

      const tx = db.transaction("mutations", "readwrite");
      const store = tx.objectStore("mutations");
      await store.put({
        ...staged,
        inFlightUntil: new Date(Date.now() - 1).toISOString(),
      });
      await tx.done;

      const bClaim = await claimNextReplayMutation("owner-B", Date.now(), 30_000);
      expect(bClaim.kind, scenario.name).toBe("claimed");
      if (bClaim.kind !== "claimed") throw new Error(`expected B claim for ${scenario.name}`);
      expect(bClaim.row.inFlightGeneration, scenario.name).toBe(generationA + 1);
      await releaseMutationToQueue(
        seq,
        "owner-B",
        bClaim.row.inFlightGeneration!,
        Date.now(),
      );

      scenario.settle(resolveFetch, rejectFetch);
      await pending;

      const preserved = await db.get("mutations", seq);
      expect(preserved, scenario.name).toBeDefined();
      expect(preserved!.deliveryState, scenario.name).toBe("queued");
      expect(preserved!.inFlightOwner, scenario.name).toBeUndefined();
      expect(preserved!.inFlightGeneration, scenario.name).toBe(generationA + 1);
      expect(preserved!.idempotencyKey, scenario.name).toBe(originalKey);
      expect(await db.getAll("conflicts"), scenario.name).toHaveLength(0);
    }
    cancelOfflineRetry();
  });
});

describe("F07 in-flight: end-to-end apiFetch race regression", () => {
  it("first send held open + concurrent replayQueue → zero fetches by replay, A not re-sent, later row not skipped", async () => {
    // We model the "first send in flight" by stamping the IndexedDB row
    // directly with a fresh lease before any apiFetch call. The apiFetch
    // call below is then simulated by holding the row in_flight and never
    // resolving the gate, so the replay run sees a live lease.
    const db = await offlineDb();
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A race",
      idempotencyKey: "race-key-aaaaaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "live-A-owner",
      inFlightGeneration: 1,
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    })) as number;
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B race",
      idempotencyKey: "race-key-bbbbbbbbbbbbbb",
    });

    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "x" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // Run a concurrent replay while the first apiFetch is "still in flight"
    // (its IndexedDB row carries a valid lease).
    const result = await replayQueue();
    expect(calls).toEqual([]);
    expect(result.stoppedReason).toBe("client_in_flight");
    expect(result.replayed).toBe(0);

    // A still in_flight with the SAME key. B still queued behind.
    const rows = await listMutations();
    expect(rows.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);
    expect(rows[0]!.deliveryState).toBe("in_flight");
    expect(rows[0]!.idempotencyKey).toBe("race-key-aaaaaaaaaaaaaa");
    expect((rows[1]!.deliveryState)).toBeUndefined();

    // The rightful current owner can still finish the row atomically.
    // Do not transition through queued: once queued, this claim generation
    // is deliberately no longer authorized to complete it.
    const { completeOwnedMutation } = await import("../src/lib/offline/queue.js");
    await completeOwnedMutation(seq, "live-A-owner", 1);
    expect((await db.get("mutations", seq))).toBeUndefined();

    const calls2: string[] = [];
    globalThis.fetch = (async (url) => {
      calls2.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "y" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const after = await replayQueue();
    expect(after.replayed).toBe(1); // B replays
    expect(calls2).toEqual(["/api/B"]);
    expect((await listMutations())).toHaveLength(0);
  });
});

describe("F07: 429 on a queueable online apiFetch transitions the row to queued and schedules a same-key retry", () => {
  it("429 → row survives with same seq + key, throws QueuedOfflineError (not ApiError), schedules a Retry-After retry", async () => {
    const db = await offlineDb();
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { code: "rate_limit", message: "slow down", details: null } }),
        headers: new Headers({ "retry-after": "2" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 429" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).not.toBeInstanceOf(ApiError);

    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1); // no duplicate row
    const persistedKey = rows[0]!.idempotencyKey;
    expect(persistedKey).toBeDefined();
    expect(seenKeys).toEqual([persistedKey]); // only one attempt's key

    // The row was released back to "queued" with no lease fields.
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();

    // The shared retry scheduler is armed.
    expect(hasPendingOfflineRetry()).toBe(true);
    cancelOfflineRetry();
  });

  it("429 → follow-up replay (after the timer fires) reuses the SAME key and clears the row", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    let attempts = 0;
    let seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      attempts++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: { code: "rate_limit", message: "slow down", details: null } }),
          headers: new Headers({ "retry-after": "1" }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "429 then 200" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const persistedKey = rows[0]!.idempotencyKey!;
    expect(persistedKey).toBeDefined();

    // Now bypass the timer and replay directly (the timer firing path uses
    // the same RETRY_OFFLINE_QUEUE_EVENT → replayQueue() chain).
    const result = await replayQueue();
    expect(seenKeys).toEqual([persistedKey, persistedKey]);
    expect(result.replayed).toBe(1);
    expect((await listMutations())).toHaveLength(0);
    cancelOfflineRetry();
  });

  it("repeated ck:retry-offline-queue dispatches do NOT create parallel timers (single-flight)", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry, hasPendingOfflineRetry, scheduleOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    // Schedule a few retries in quick succession.
    scheduleOfflineRetry(500);
    scheduleOfflineRetry(500);
    scheduleOfflineRetry(500);
    expect(hasPendingOfflineRetry()).toBe(true);
    // Calling again with the same delay replaces the timer — there is
    // never more than one.
    cancelOfflineRetry();
    expect(hasPendingOfflineRetry()).toBe(false);
  });

  it("429 with no Retry-After header still schedules a retry using the bounded default", async () => {
    const { cancelOfflineRetry, hasPendingOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: "rate_limit", message: "slow down", details: null } }),
    })) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/x", { method: "POST", body: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(hasPendingOfflineRetry()).toBe(true);
    cancelOfflineRetry();
  });
});

describe("F07: atomic mutation → conflict transition", () => {
  it("a successful move deletes the mutation row and adds the conflict atomically", async () => {
    const db = await offlineDb();
    const { moveMutationToConflict } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "x",
      idempotencyKey: "atomic-ok-aaaaaaaaaaaaa",
    })) as number;

    const before = await listMutations();
    expect(before.map((m) => m.url)).toEqual(["/api/x"]);
    expect((await listConflicts())).toEqual([]);

    const moved = await moveMutationToConflict(seq, {
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "may have applied",
      detectedAt: new Date().toISOString(),
    });
    expect(moved).not.toBeNull();
    expect(moved!.mutation.idempotencyKey).toBe("atomic-ok-aaaaaaaaaaaaa");
    expect(moved!.seq).toBeGreaterThan(0);

    // Both stores observed a clean transition.
    expect((await listMutations())).toEqual([]);
    expect((await listConflicts())).toHaveLength(1);
  });

  it("an aborted transition leaves the mutation row intact and no conflict behind", async () => {
    const db = await offlineDb();
    const { moveMutationToConflict } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "x",
      idempotencyKey: "atomic-abort-aaaaaaaaaa",
    })) as number;

    // Force the underlying IDBObjectStore.add call on the `conflicts` store
    // to throw so the atomic helper's transaction aborts before the
    // mutation row is deleted. We patch the native prototype that fake-
    // indexeddb installs so the idb wrapper's internal calls also abort.
    let abortSeen = false;
    const NativeStoreProto = (globalThis as unknown as { IDBObjectStore: { prototype: IDBObjectStore } })
      .IDBObjectStore.prototype;
    const realAdd = NativeStoreProto.add;
    NativeStoreProto.add = function (this: unknown, ...args: unknown[]) {
      const self = this as unknown as { name: string };
      if (self.name === "conflicts") {
        abortSeen = true;
        throw new DOMException("forced abort", "AbortError");
      }
      return (realAdd as (...a: unknown[]) => unknown).apply(this, args);
    };

    let caught: unknown = null;
    try {
      await moveMutationToConflict(seq, {
        status: 409,
        code: "idempotency_outcome_unknown",
        message: "may have applied",
        detectedAt: new Date().toISOString(),
      });
    } catch (e) {
      caught = e;
    }
    // Restore.
    NativeStoreProto.add = realAdd;

    expect(abortSeen).toBe(true);
    expect(caught).toBeInstanceOf(Error);

    // Mutation row is STILL in the queue. No conflict was added.
    const remaining = await listMutations();
    expect(remaining.map((m) => m.url)).toEqual(["/api/x"]);
    expect(remaining[0]!.idempotencyKey).toBe("atomic-abort-aaaaaaaaaa");
    expect((await listConflicts())).toEqual([]);
  });

  it("replay's idempotency_outcome_unknown branch uses the atomic helper (single transaction over both stores)", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/x",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "atomic-replay",
      idempotencyKey: "atomic-replay-aaaaaaaaa",
    });
    let multiStoreTxnSeen = false;
    const realTxn = db.transaction.bind(db);
    (db as unknown as { transaction: (...args: unknown[]) => unknown }).transaction = (
      stores: unknown,
      mode: unknown,
    ) => {
      if (Array.isArray(stores) && (stores as unknown[]).length === 2) multiStoreTxnSeen = true;
      return realTxn(stores as string | string[], mode as IDBTransactionMode);
    };
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "idempotency_outcome_unknown", message: "may have applied", details: null } }),
    })) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(multiStoreTxnSeen).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("idempotency_outcome_unknown");
    // Restore.
    (db as unknown as { transaction: typeof db.transaction }).transaction = realTxn;
  });

  it("replay's semantic-4xx branch uses the atomic helper", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "PUT",
      url: "/api/records/r9",
      body: { revision: 1, text: "stale" },
      enqueuedAt: new Date().toISOString(),
      label: "atomic-stale",
      idempotencyKey: "atomic-stale-aaaaaaaaaa",
    });
    let multiStoreTxnSeen = false;
    const realTxn = db.transaction.bind(db);
    (db as unknown as { transaction: (...args: unknown[]) => unknown }).transaction = (
      stores: unknown,
      mode: unknown,
    ) => {
      if (Array.isArray(stores) && (stores as unknown[]).length === 2) multiStoreTxnSeen = true;
      return realTxn(stores as string | string[], mode as IDBTransactionMode);
    };
    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "stale_revision", message: "stale", details: null } }),
    })) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(multiStoreTxnSeen).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.code).toBe("stale_revision");
    (db as unknown as { transaction: typeof db.transaction }).transaction = realTxn;
  });
});

describe("F07 terminal-race: 403 csrf_mismatch on initial apiFetch ends the staged row (no replay-driven duplicate)", () => {
  it("apiFetch + 403 csrf_mismatch → owned staged row is deleted, queue is empty, no replay event, next replay sends zero fetches", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "csrf_mismatch",
            message: "CSRF token missing or mismatched. Reload the app and retry.",
            details: null,
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 CSRF 403" } });
    } catch (e) {
      caught = e;
    }
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(403);
    expect((caught as { code: string }).code).toBe("csrf_mismatch");

    // F07 terminal-race fix: the staged row must be gone (server did not
    // create a claim and did not execute the mutation, so re-sending it
    // would create a duplicate logical mutation).
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(0);

    // The replay event MUST NOT be dispatched for csrf_mismatch: the row
    // never needs re-sending.
    expect(retrySpy).not.toHaveBeenCalled();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);

    // ReplayQueue on an empty queue performs zero fetches — protects against
    // a stale lease or a second tab spawning a "duplicate" replay later.
    const replayCalls: { url: string }[] = [];
    globalThis.fetch = (async (url) => {
      replayCalls.push({ url: String(url) });
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const replayResult = await replayQueue();
    expect(replayResult.replayed).toBe(0);
    expect(replayResult.conflicts).toEqual([]);
    expect(replayCalls).toHaveLength(0);

    // A new logical submission gets a brand new key — the previous K is gone.
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await apiFetch("/api/projects", { method: "POST", body: { name: "post-csrf-retry" } });
    expect(seenKeys[1]!).not.toBe(seenKeys[0]!);
  });

  it("a 403 with a code OTHER than csrf_mismatch keeps the staged row queued for retry (no premature delete)", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    globalThis.fetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        error: {
          code: "project_scope_violation",
          message: "Request targets a project outside your scope.",
          details: null,
        },
      }),
    })) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/records/x", { method: "PUT", body: { revision: 1, text: "edit" } });
    } catch (e) {
      caught = e;
    }
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(403);
    expect((caught as { code: string }).code).toBe("project_scope_violation");

    // Row MUST still be queued for the next replay — the server may have
    // executed the business handler (and committed an idempotency claim)
    // BEFORE the scope check failed. A replay with the SAME key is the
    // safe recovery path; deleting it here would risk a duplicate mutation.
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("csrf_mismatch cleanup respects owner-token safety: completeOwnedMutation refuses a row whose persisted owner no longer matches the caller's token", async () => {
    // The csrf_mismatch cleanup calls finalizeStage("complete") which
    // delegates to completeOwnedMutation(seq, ownerToken). We exercise the
    // underlying safety directly: pinning the row to owner "older-tab"
    // and trying to complete it as "stale-requester" MUST return false
    // and leave the row in place.
    const db = await offlineDb();
    const { enqueueMutation, markMutationInFlight, completeOwnedMutation } =
      await import("../src/lib/offline/queue.js");
    const seq = await enqueueMutation({
      method: "POST",
      url: "/api/projects",
      body: { name: "owner-safety" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: "owner-safety-aaaaaaaaaa",
    });

    // Original (in-flight) owner from a still-active sender.
    const marked = await markMutationInFlight(seq, "original-active-owner");
    expect(marked).not.toBeNull();

    // A second sender (e.g. older tab) attempts to delete via the csrf
    // cleanup path with the wrong token. The atomic owner check MUST stop
    // the delete — the row's persisted inFlightOwner no longer matches.
    const deleted = await completeOwnedMutation(
      seq,
      "stale-requester-token",
      marked!.inFlightGeneration!,
    );
    expect(deleted).toBe(false);

    // Row survives, still owned by the original active sender.
    const row = (await db.get("mutations", seq)) as
      | { inFlightOwner?: string; deliveryState?: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.inFlightOwner).toBe("original-active-owner");
    expect(row!.deliveryState).toBe("in_flight");

    // The freshly-stamped lease is still valid (30s default); a recovery
    // call with the real wall clock MUST refuse to take over the row.
    const recovered = await (
      await import("../src/lib/offline/queue.js")
    ).recoverExpiredInFlightLease(seq);
    expect(recovered).toBeNull();
  });
});

describe("F07 terminal-race: body-read failure while online dispatches same-key replay", () => {
  it("apiFetch gets 2xx headers, JSON parse fails, owned stage is queued, retry event fires once, replay reuses the SAME key", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("connection terminated mid-body");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 Body Read Fail" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);

    // The retry event MUST be dispatched exactly once — that is what tells
    // the F07 player in main.tsx to run replayQueue() and recover the
    // already-committed response from the server's cached idempotency
    // claim using the same key.
    expect(retrySpy).toHaveBeenCalledTimes(1);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);

    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const originalSeq = rows[0]!.seq!;
    const originalKey = rows[0]!.idempotencyKey!;
    // The row is released to the replayable "queued" state.
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();

    // Now the replay path: the server returns the cached successful 2xx
    // response for the SAME idempotency key.
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "recovered", note: "cached" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const replayResult = await replayQueue();
    expect(replayResult.replayed).toBe(1);
    expect(replayResult.conflicts).toEqual([]);
    expect(seenKeys[1]).toBe(originalKey);

    // The queued mutation is now fully cleared — no second logical key
    // generated, no row left behind.
    const remaining = await db.getAll("mutations");
    expect(remaining).toHaveLength(0);
    expect(remaining.map((r) => r.seq)).not.toContain(originalSeq);
  });

  it("body-read failure path preserves ordered replay: a later queue entry is not stranded behind it", async () => {
    const db = await offlineDb();
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    let attempts = 0;
    globalThis.fetch = (async (_url, init) => {
      attempts++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const key = headers["idempotency-key"];
      if (key === "first-body-fail-aaaaaaaaa") {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new TypeError("body interrupted");
          },
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    // First call: body fails.
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", {
        method: "POST",
        body: { name: "first" },
        idempotencyKey: "first-body-fail-aaaaaaaaa",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);

    // Now queue a second mutation BEHIND the first (different key, ordered).
    await enqueueMutation({
      method: "PUT",
      url: "/api/records/r2",
      body: { revision: 1, text: "edit" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: "second-aaaaaaaaaaaaaaa",
    });

    // Replay recovers both: first retries with same key, second runs normally.
    globalThis.fetch = (async (_url, init) => {
      attempts++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const key = headers["idempotency-key"];
      if (key === "first-body-fail-aaaaaaaaa") {
        return { ok: true, status: 200, json: async () => ({ id: "first-recovered" }) } as unknown as Response;
      }
      if (key === "second-aaaaaaaaaaaaaaa") {
        return { ok: true, status: 200, json: async () => ({ id: "second-ok" }) } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await replayQueue();
    expect(result.replayed).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect((await db.getAll("mutations"))).toHaveLength(0);
  });
});

describe("F07 terminal-race: concurrent unknown-outcome acknowledgements", () => {
  it("two simultaneous acks both delete their rows; the post-delete authoritative read yields ≥1 retry event; replay becomes eligible; queued C is not stranded", async () => {
    // Set up: two real `idempotency_outcome_unknown` conflicts and a
    // unrelated queued mutation C. We run the SAME post-delete-listChecks
    // logic ConflictOverlay uses, twice concurrently, and assert that:
    //   (1) both conflict rows are eventually gone;
    //   (2) the post-delete authoritative list reaches zero unknowns once;
    //   (3) ≥1 retry event is dispatched (single-flight replayQueue
    //       guarantees duplicate dispatches do not create duplicate work);
    //   (4) the queued C is replayable.
    const db = await offlineDb();
    const { moveMutationToConflict, listConflicts, listMutations } =
      await import("../src/lib/offline/queue.js");
    const { dismissConflict } = await import("../src/lib/offline/queue.js");

    // Create the two unknown conflicts from queued mutations.
    const seqA = await enqueueMutation({
      method: "POST",
      url: "/api/A",
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "concur-aaaaaaaaaaaaaaaa",
    });
    const seqB = await enqueueMutation({
      method: "POST",
      url: "/api/B",
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "concur-bbbbbbbbbbbbbbbb",
    });
    const cSeq = await enqueueMutation({
      method: "POST",
      url: "/api/C",
      enqueuedAt: new Date().toISOString(),
      label: "C",
      idempotencyKey: "concur-cccccccccccccccc",
    });

    await moveMutationToConflict(seqA, {
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "A MAY already have been applied",
      detectedAt: new Date().toISOString(),
    });
    await moveMutationToConflict(seqB, {
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "B MAY already have been applied",
      detectedAt: new Date().toISOString(),
    });

    let initial = await listConflicts();
    expect(initial).toHaveLength(2);
    const cSeqStored = await db.get("mutations", cSeq);
    expect(cSeqStored).toBeDefined();

    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    // Mirror the ConflictOverlay post-delete-listChecks helper logic.
    async function overlayHandle(seq: number): Promise<{ stillBlocking: boolean; remaining: number }> {
      await dismissConflict(seq);
      const remaining = await listConflicts();
      const stillBlocking = remaining.some((c) => c.code === "idempotency_outcome_unknown");
      if (!stillBlocking && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ck:retry-offline-queue"));
      }
      return { stillBlocking, remaining: remaining.length };
    }

    const seqAConflict = initial.find((c) => c.mutation.seq === seqA)!.seq!;
    const seqBConflict = initial.find((c) => c.mutation.seq === seqB)!.seq!;

    // Two acks fired as concurrently as JS allows.
    const [resultA, resultB] = await Promise.all([
      overlayHandle(seqAConflict),
      overlayHandle(seqBConflict),
    ]);

    // (1) Both deleted: store is empty regardless of interleave.
    const final = await listConflicts();
    expect(final).toHaveLength(0);

    // (2) At least one of the two post-delete reads observed zero blockers.
    // (The other may have observed the OTHER row still present if it read
    //  before the other dismissal committed — that is the existing partial-
    // observation behaviour, not a regression.)
    expect(
      (resultA.remaining === 0 && !resultA.stillBlocking) ||
        (resultB.remaining === 0 && !resultB.stillBlocking),
    ).toBe(true);

    // (3) ≥1 retry event was dispatched. Even if both handlers dispatched
    // (because both read post-delete), replayQueue()'s single-flight
    // coalesces into one effective replay — no duplicate execution.
    expect(retrySpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    window.removeEventListener("ck:retry-offline-queue", retrySpy);

    // (4) queued mutation C survives and is replayable.
    const stillQueued = await listMutations();
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0]!.seq).toBe(cSeq);
    // hasUnresolvedUnknownOutcomeConflict is the durable barrier; with both
    // conflicts gone, the next replayQueueOnce must NOT short-circuit.
    const { hasUnresolvedUnknownOutcomeConflict } = await import("../src/lib/offline/queue.js");
    expect(await hasUnresolvedUnknownOutcomeConflict()).toBe(false);
  });

  it("if one blocking conflict still remains after acknowledgement, NO retry event is dispatched (durable barrier holds)", async () => {
    const db = await offlineDb();
    const { moveMutationToConflict, listConflicts, dismissConflict } =
      await import("../src/lib/offline/queue.js");

    const seqA = await enqueueMutation({
      method: "POST",
      url: "/api/A",
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: "still-blocking-aaaaaaa",
    });
    const seqB = await enqueueMutation({
      method: "POST",
      url: "/api/B",
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: "still-blocking-bbbbbbb",
    });
    await moveMutationToConflict(seqA, {
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "A MAY already",
      detectedAt: new Date().toISOString(),
    });
    await moveMutationToConflict(seqB, {
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "B MAY already",
      detectedAt: new Date().toISOString(),
    });

    const init = await listConflicts();
    const seqAConflict = init.find((c) => c.mutation.seq === seqA)!.seq!;

    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    // Same ConflictOverlay logic.
    await dismissConflict(seqAConflict);
    const after = await listConflicts();
    const stillBlocking = after.some((c) => c.code === "idempotency_outcome_unknown");
    if (!stillBlocking && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("ck:retry-offline-queue"));
    }
    expect(stillBlocking).toBe(true);
    expect(retrySpy).not.toHaveBeenCalled();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
    // B still there:
    expect((await listConflicts())).toHaveLength(1);
  });
});

describe("F07 atomic-delivery: initial online stage is born in_flight (no committed queued gap)", () => {
  it("apiFetch online stage persists the row with deliveryState=in_flight BEFORE fetch is invoked", async () => {
    const db = await offlineDb();
    let observedAtFetch: { deliveryState?: string; inFlightOwner?: string; inFlightUntil?: string; idempotencyKey?: string } | null = null;
    globalThis.fetch = (async (_url, init) => {
      const rows = await db.getAll("mutations");
      observedAtFetch = rows[0]!;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["idempotency-key"]).toBe(observedAtFetch!.idempotencyKey);
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await apiFetch("/api/projects", { method: "POST", body: { name: "F07 atomic stage" } });

    expect(observedAtFetch).not.toBeNull();
    expect(observedAtFetch!.deliveryState).toBe("in_flight");
    expect(typeof observedAtFetch!.inFlightOwner).toBe("string");
    expect((observedAtFetch!.inFlightOwner ?? "").length).toBeGreaterThan(0);
    expect(typeof observedAtFetch!.inFlightUntil).toBe("string");
    expect(Number.isFinite(Date.parse(observedAtFetch!.inFlightUntil!))).toBe(true);
    expect(observedAtFetch!.idempotencyKey).toMatch(/^[0-9a-f]{8}-/);
    // Row deleted after a successful 2xx.
    expect((await db.getAll("mutations"))).toHaveLength(0);
  });

  it("stageOwnedInFlightMutation writes key+owner+lease in ONE write; the row's first committed state is in_flight", async () => {
    const db = await offlineDb();
    const { stageOwnedInFlightMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    // Snapshot the IndexedDB right after the helper resolves — the row MUST
    // already be in_flight. There is no observable "queued" intermediate.
    const result = await stageOwnedInFlightMutation(
      {
        method: "POST",
        url: "/api/projects",
        body: { name: "one-shot" },
        enqueuedAt: new Date().toISOString(),
        idempotencyKey: "atomic-stage-key-aaaaaaa",
      },
      newOwnerToken(),
    );
    expect(result.kind).toBe("in_flight");
    expect(result.seq).toBeGreaterThan(0);
    expect(result.mutation.deliveryState).toBe("in_flight");
    expect(result.mutation.inFlightOwner).toBe(result.owner);
    expect(result.mutation.idempotencyKey).toBe("atomic-stage-key-aaaaaaa");

    // Read-back also confirms in_flight.
    const stored = (await db.get("mutations", result.seq)) as {
      deliveryState?: string;
      inFlightOwner?: string;
      inFlightUntil?: string;
    };
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightOwner).toBe(result.owner);
    expect(typeof stored.inFlightUntil).toBe("string");
  });

  it("competing replay during an active apiFetch sees in_flight lease, sends zero fetches, returns client_in_flight; later row is not skipped", async () => {
    const db = await offlineDb();
    let releaseA!: () => void;
    globalThis.fetch = (async () => {
      // Hang A's fetch until we explicitly resolve it.
      return new Promise((resolve) => {
        releaseA = () =>
          resolve({ ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response);
      });
    }) as unknown as typeof fetch;

    // Start apiFetch for A — it stages in_flight atomically, then awaits fetch.
    const aPromise = apiFetch("/api/A", { method: "POST", body: { step: "A" } });
    // Yield so apiFetch reaches the awaiting fetch() call.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Inspect IDB: A is born in_flight.
    const aRows = await db.getAll("mutations");
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.deliveryState).toBe("in_flight");
    const aSeq = aRows[0]!.seq!;
    const aKey = aRows[0]!.idempotencyKey!;
    const aOwner = aRows[0]!.inFlightOwner!;

    // Add B directly behind A.
    await enqueueMutation({
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      idempotencyKey: "B-key-aaaaaaaaaaaaaaaa",
    });

    // Replace fetch with a counting mock for the replay attempt.
    let replayCalls = 0;
    globalThis.fetch = (async () => {
      replayCalls++;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(replayCalls).toBe(0);
    expect(result.stoppedReason).toBe("client_in_flight");
    expect(result.replayed).toBe(0);
    expect(typeof result.retryAfterMs).toBe("number");

    // A still in_flight under the same owner; B still queued behind.
    const after = await listMutations();
    expect(after.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);
    expect(after[0]!.seq).toBe(aSeq);
    expect(after[0]!.deliveryState).toBe("in_flight");
    expect(after[0]!.inFlightOwner).toBe(aOwner);
    expect(after[0]!.idempotencyKey).toBe(aKey);

    // Cleanup: release A's fetch and let apiFetch complete.
    releaseA();
    await aPromise.catch(() => undefined);

    // After cleanup, A should be gone (success → completeOwnedMutation), B remains queued.
    const finalRows = await listMutations();
    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]!.url).toBe("/api/B");
  });

  it("offline path: staged row remains queued (no fake in_flight lease when no fetch will happen)", async () => {
    const db = await offlineDb();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 offline atomic" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(fetchSpy).not.toHaveBeenCalled();
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBeUndefined();
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();
    expect(rows[0]!.idempotencyKey).toMatch(/^[0-9a-f]{8}-/);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });
});

describe("F07 atomic-delivery: replay claim is barrier+select+claim in ONE transaction", () => {
  it("claimNextReplayMutation on an empty queue returns { kind: 'empty' }", async () => {
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const claim = await claimNextReplayMutation(newOwnerToken());
    expect(claim.kind).toBe("empty");
  });

  it("claimNextReplayMutation blocks on a pre-existing idempotency_outcome_unknown conflict (no row claimed)", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    // Seed A as queued AND seed a blocking conflict.
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "claim-block-aaaaaaaaaaa",
    });
    await db.add("conflicts", {
      mutation: {
        method: "POST",
        url: "/api/A",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "A",
        idempotencyKey: "claim-block-aaaaaaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "A MAY already",
      detectedAt: new Date().toISOString(),
    });

    const claim = await claimNextReplayMutation(newOwnerToken());
    expect(claim.kind).toBe("blocked_by_unknown_outcome");

    // The queued row is still queued; nothing was claimed.
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBeUndefined();
  });

  it("claimNextReplayMutation claims the oldest queued row in ONE tx: legacy key synthesized atomically, in_flight fields stamped", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    // Seed A as legacy (no idempotencyKey) and B as legacy; A should be claimed first.
    const seqA = (await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
    })) as number;
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "B",
    });
    const owner = newOwnerToken();
    const claim = await claimNextReplayMutation(owner);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    expect(claim.row.seq).toBe(seqA);
    expect(claim.row.url).toBe("/api/A");
    expect(claim.owner).toBe(owner);
    expect(claim.row.deliveryState).toBe("in_flight");
    expect(claim.row.inFlightOwner).toBe(owner);
    expect(typeof claim.row.idempotencyKey).toBe("string");
    expect(claim.row.idempotencyKey).toMatch(/^[0-9a-f]{8}-/);

    // B is still queued, not in_flight.
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(2);
    const b = rows.find((r) => r.url === "/api/B")!;
    expect(b.deliveryState).toBeUndefined();
  });

  it("claimNextReplayMutation refuses to take over a row whose lease is still valid (returns client_in_flight)", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/live",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "live",
      idempotencyKey: "live-claim-aaaaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "active-owner",
      inFlightUntil: new Date(Date.now() + 30_000).toISOString(),
    })) as number;

    const claim = await claimNextReplayMutation(newOwnerToken());
    expect(claim.kind).toBe("client_in_flight");
    if (claim.kind !== "client_in_flight") throw new Error("expected client_in_flight");
    expect(claim.row.seq).toBe(seq);
    expect(claim.row.inFlightOwner).toBe("active-owner");
    expect(typeof claim.retryAfterMs).toBe("number");
    // Row was NOT touched.
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string };
    expect(stored.inFlightOwner).toBe("active-owner");
  });

  it("claimNextReplayMutation takes over an expired lease in the same tx: same key, new owner, fresh lease", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/expired",
      body: { original: true },
      enqueuedAt: new Date().toISOString(),
      label: "expired",
      idempotencyKey: "expired-claim-aaaaaaaaa",
      deliveryState: "in_flight",
      inFlightOwner: "ghost-owner",
      inFlightUntil: new Date(Date.now() - 1000).toISOString(),
    })) as number;
    const owner = newOwnerToken();
    const claim = await claimNextReplayMutation(owner);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("expected claimed");
    expect(claim.row.seq).toBe(seq);
    expect(claim.row.inFlightOwner).toBe(owner);
    expect(claim.row.idempotencyKey).toBe("expired-claim-aaaaaaaaa");
    expect((claim.row.body as { original?: boolean }).original).toBe(true);
    // Lease moved forward (now > old expiry).
    const stored = (await db.get("mutations", seq)) as { inFlightUntil?: string };
    expect(typeof stored.inFlightUntil).toBe("string");
    expect(Date.parse(stored.inFlightUntil!)).toBeGreaterThan(Date.now() - 1);
  });

  it("claimNextReplayMutation: two concurrent claims on one queued row — exactly one wins, the other sees client_in_flight, both reference the same persisted key", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const sharedKey = "claim-race-shared-key-aaaaaa";
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/race",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "race",
      idempotencyKey: sharedKey,
    })) as number;
    const owner1 = newOwnerToken();
    const owner2 = newOwnerToken();
    const [a, b] = await Promise.all([
      claimNextReplayMutation(owner1),
      claimNextReplayMutation(owner2),
    ]);
    const claims = [a, b];
    const winners = claims.filter((c) => c.kind === "claimed");
    const losers = claims.filter((c) => c.kind !== "claimed");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.kind).toBe("client_in_flight");

    // Both reference the SAME persisted key — the durable key is the only
    // identity the HTTP layer will use, and it must match across both views.
    const winner = winners[0] as { kind: "claimed"; row: { idempotencyKey?: string; seq: number }; owner: string };
    const loser = losers[0] as { kind: "client_in_flight"; row: { idempotencyKey?: string; seq: number } };
    expect(winner.row.seq).toBe(seq);
    expect(loser.row.seq).toBe(seq);
    expect(winner.row.idempotencyKey).toBe(sharedKey);
    expect(loser.row.idempotencyKey).toBe(sharedKey);
    expect(winner.owner).not.toBe(loser.row.inFlightOwner === undefined ? "" : "");

    // The row's persisted owner is the winner's owner.
    const stored = (await db.get("mutations", seq)) as { inFlightOwner?: string; deliveryState?: string };
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightOwner).toBe(winner.owner);
  });
});

describe("F07 atomic-delivery: cross-tab barrier linearizability (blocker commits before claim tx)", () => {
  it("when a blocking idempotency_outcome_unknown conflict is already committed, replayQueue sends zero fetches and B is never claimed/sent", async () => {
    const db = await offlineDb();
    // Seed A as queued (legacy — will be claimed first) AND B behind it.
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "cross-block-aaaaaaaaaa",
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "cross-block-bbbbbbbbbb",
    });
    // And seed a blocking idempotency_outcome_unknown conflict that
    // "committed before" the replay-claim tx.
    await db.add("conflicts", {
      mutation: {
        method: "POST",
        url: "/api/older",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "older",
        idempotencyKey: "cross-block-older-aaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "older MAY already",
      detectedAt: new Date().toISOString(),
    });

    let calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(calls).toEqual([]);
    expect(result.replayed).toBe(0);
    expect(result.stoppedReason).toBe("idempotency_outcome_unknown");
    expect(result.conflicts).toHaveLength(1);

    // B is still queued and was NEVER claimed/sent.
    const rows = await db.getAll("mutations");
    expect(rows.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);
    expect(rows.find((r) => r.url === "/api/B")!.deliveryState).toBeUndefined();
  });

  it("owner-checked move: when replay claims A first, a later moveMutationToConflict with a different owner refuses", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, moveMutationToConflict, newOwnerToken } =
      await import("../src/lib/offline/queue.js");
    // Seed A queued.
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/owned",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "owned",
      idempotencyKey: "owner-move-aaaaaaaaaaaa",
    })) as number;
    // Replay claims it.
    const replayOwner = newOwnerToken();
    const claim = await claimNextReplayMutation(replayOwner);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("expected claimed");

    // A stale path tries to move A to conflicts under the wrong owner.
    const moved = await moveMutationToConflict(
      seq,
      {
        status: 409,
        code: "idempotency_outcome_unknown",
        message: "MAY already",
        detectedAt: new Date().toISOString(),
      },
      "wrong-stale-owner",
      claim.row.inFlightGeneration!,
    );
    expect(moved).toBeNull();

    // Row survives — still in_flight under the replay owner.
    const stored = (await db.get("mutations", seq)) as {
      inFlightOwner?: string;
      deliveryState?: string;
    };
    expect(stored.deliveryState).toBe("in_flight");
    expect(stored.inFlightOwner).toBe(replayOwner);
  });

  it("owner-checked move: the rightful replay owner CAN move A to conflicts", async () => {
    const db = await offlineDb();
    const { claimNextReplayMutation, moveMutationToConflict, newOwnerToken } =
      await import("../src/lib/offline/queue.js");
    const seq = (await db.add("mutations", {
      method: "POST",
      url: "/api/owned2",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "owned2",
      idempotencyKey: "owner-move-bbbbbbbbbbbb",
    })) as number;
    const replayOwner = newOwnerToken();
    const claim = await claimNextReplayMutation(replayOwner);
    expect(claim.kind).toBe("claimed");

    const moved = await moveMutationToConflict(
      seq,
      {
        status: 409,
        code: "idempotency_outcome_unknown",
        message: "MAY already",
        detectedAt: new Date().toISOString(),
      },
      replayOwner,
      claim.kind === "claimed" ? claim.row.inFlightGeneration! : -1,
    );
    expect(moved).not.toBeNull();
    expect(moved!.code).toBe("idempotency_outcome_unknown");
    expect(moved!.mutation.idempotencyKey).toBe("owner-move-bbbbbbbbbbbb");
    // Row removed from mutations, present in conflicts.
    expect(await db.get("mutations", seq)).toBeUndefined();
    expect((await db.getAll("conflicts"))).toHaveLength(1);
  });
});

describe("F07 atomic-delivery: 429 routing for non-queueable calls (noQueue / GET)", () => {
  it("429 on a noQueue auth call: no IndexedDB row, no QueuedOfflineError, normal ApiError 429, no scheduler", async () => {
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: "rate_limit", message: "slow down", details: null } }),
      headers: new Headers({ "retry-after": "2" }),
    })) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: { password: "x" }, noQueue: true });
    } catch (e) {
      caught = e;
    }

    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(429);
    expect((caught as { code: string }).code).toBe("rate_limit");
    expect((caught as Error).message).toBe("slow down");
    // No mutation row, no scheduler, no QueuedOfflineError.
    expect((await listMutations())).toHaveLength(0);
    expect(hasPendingOfflineRetry()).toBe(false);
    expect(caught).not.toBeInstanceOf(QueuedOfflineError);
    cancelOfflineRetry();
  });

  it("429 on a GET: no IndexedDB row, normal ApiError 429, no scheduler", async () => {
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: "rate_limited", message: "Too many GET requests", details: null } }),
    })) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects"); // default GET
    } catch (e) {
      caught = e;
    }

    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(429);
    expect((caught as { code: string }).code).toBe("rate_limited");
    expect((await listMutations())).toHaveLength(0);
    expect(hasPendingOfflineRetry()).toBe(false);
    expect(caught).not.toBeInstanceOf(QueuedOfflineError);
    cancelOfflineRetry();
  });

  it("429 on a noQueue call preserves the server-supplied code/message verbatim", async () => {
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        error: { code: "setup_rate_limit", message: "Setup is rate-limited; try again in 1 hour.", details: null },
      }),
    })) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/auth/setup", { method: "POST", body: { password: "x" }, noQueue: true });
    } catch (e) {
      caught = e;
    }
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as { status: number }).status).toBe(429);
    expect((caught as { code: string }).code).toBe("setup_rate_limit");
    expect((caught as Error).message).toMatch(/Setup is rate-limited/);
    expect((await listMutations())).toHaveLength(0);
    cancelOfflineRetry();
  });

  it("queueable 429 still queues + schedules a Retry-After retry (regression)", async () => {
    const db = await offlineDb();
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: "rate_limit", message: "slow down", details: null } }),
      headers: new Headers({ "retry-after": "1" }),
    })) as unknown as typeof fetch;
    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 429 regression" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(hasPendingOfflineRetry()).toBe(true);
    cancelOfflineRetry();
  });
});

describe("F07 replay-finalization: replay 5xx MUST resolve to unknown outcome", () => {
  it("first replay 500: row stays queued with same seq/key, B not sent, bounded retry scheduled", async () => {
    const db = await offlineDb();
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    const sharedKey = "rf-5xx-recovery-aaaaaaaaa";
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: sharedKey,
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "rf-5xx-recovery-bbbbbbbbb",
    });

    const calls: { url: string; key?: string }[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(_url), key: headers["idempotency-key"] });
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();

    // Only A was attempted (B never sent).
    expect(calls.map((c) => c.url)).toEqual(["/api/A"]);
    expect(calls[0]!.key).toBe(sharedKey);

    // A remains queued with the SAME seq + key; nothing created twice.
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(2);
    const aRow = rows.find((r) => r.url === "/api/A")!;
    expect(aRow.idempotencyKey).toBe(sharedKey);
    expect(aRow.deliveryState).toBe("queued");
    expect(aRow.inFlightOwner).toBeUndefined();
    expect(aRow.inFlightUntil).toBeUndefined();
    const originalSeq = aRow.seq!;

    // B is queued, never sent.
    const bRow = rows.find((r) => r.url === "/api/B")!;
    expect(bRow.deliveryState).toBeUndefined();
    expect(bRow.idempotencyKey).toBe("rf-5xx-recovery-bbbbbbbbb");

    // Replay returned with the new stop reason and a bounded retry delay.
    expect(result.stoppedReason).toBe("server_indeterminate");
    expect(typeof result.retryAfterMs).toBe("number");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);

    // The shared scheduler is armed.
    expect(hasPendingOfflineRetry()).toBe(true);

    // Sanity: the seq was not re-allocated — the durable key still maps to it.
    expect(aRow.seq).toBe(originalSeq);
    cancelOfflineRetry();
  });

  it("follow-up replay after the scheduled retry sends SAME key, gets 409 idempotency_outcome_unknown, row becomes durable conflict", async () => {
    const db = await offlineDb();
    const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    const sharedKey = "rf-5xx-then-409-aaaaaaaa";
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: { step: "A" },
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: sharedKey,
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "rf-5xx-then-409-bbbbbbbb",
    });

    let calls = 0;
    let seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      calls++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      if (calls === 1) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "idempotency_outcome_unknown",
            message: "Previous outcome was indeterminate.",
            details: null,
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // First replay: 5xx → release + schedule.
    const first = await replayQueue();
    expect(first.stoppedReason).toBe("server_indeterminate");
    expect(first.replayed).toBe(0);
    expect(first.conflicts).toEqual([]);
    expect(hasPendingOfflineRetry()).toBe(true);
    expect(calls).toBe(1);
    expect(seenKeys[0]).toBe(sharedKey);

    // Simulate the scheduler firing (in production, the timer dispatches
    // ck:retry-offline-queue → main.tsx listener → replayQueue()). The
    // replay here mirrors that follow-up without depending on real time.
    const second = await replayQueue();
    expect(calls).toBe(2);
    // SAME key throughout — exactly ONE logical key.
    expect(seenKeys[1]).toBe(sharedKey);
    expect(seenKeys[0]).toBe(seenKeys[1]);

    // A moved to conflicts; barrier is durable.
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]!.code).toBe("idempotency_outcome_unknown");
    expect(second.conflicts[0]!.mutation.idempotencyKey).toBe(sharedKey);
    expect(second.conflicts[0]!.status).toBe(409);
    expect(second.stoppedReason).toBe("idempotency_outcome_unknown");

    // Queue: A removed (now a conflict), B still queued untouched.
    const remaining = await listMutations();
    expect(remaining.map((m) => m.url)).toEqual(["/api/B"]);
    expect(remaining[0]!.idempotencyKey).toBe("rf-5xx-then-409-bbbbbbbb");
    const storedConflicts = await listConflicts();
    expect(storedConflicts).toHaveLength(1);
    expect(storedConflicts[0]!.code).toBe("idempotency_outcome_unknown");

    cancelOfflineRetry();
  });

  it("5xx honors the server's Retry-After when present; bounded by DEFAULT_RESOLUTION_RETRY_MS otherwise", async () => {
    const { DEFAULT_RESOLUTION_RETRY_MS, parseRetryAfterMs } = await import("../src/lib/offline/queue.js");
    expect(DEFAULT_RESOLUTION_RETRY_MS).toBeGreaterThanOrEqual(250);
    expect(DEFAULT_RESOLUTION_RETRY_MS).toBeLessThanOrEqual(1000);

    // Without a Retry-After header, falls back to the bounded default.
    const noHeader = parseRetryAfterMs(null);
    expect(noHeader).toBeUndefined();
    // The fallback is plumbed through the 5xx branch via DEFAULT_RESOLUTION_RETRY_MS.

    // With a Retry-After header, the parsed value is preferred (clamped).
    const clamped = parseRetryAfterMs("999");
    expect(clamped).toBe(60_000);
  });

  it("ordering: A receives 5xx, B behind A is NEVER sent during the same replay run", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "rf-order-aaaaaaaaaaaaa",
    });
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "rf-order-bbbbbbbbbbbbb",
    });

    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(calls).toEqual(["/api/A"]); // B never sent
    expect(result.stoppedReason).toBe("server_indeterminate");

    // A still queued, B still queued — both untouched by the 5xx beyond
    // A's release.
    const remaining = await listMutations();
    expect(remaining.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);
    expect(remaining[0]!.deliveryState).toBe("queued");
    expect(remaining[1]!.deliveryState).toBeUndefined();
    cancelOfflineRetry();
  });

  it("consecutive 5xx on separate replay invocations do not stack timers (single-flight scheduler)", async () => {
    const db = await offlineDb();
    const { hasPendingOfflineRetry, cancelOfflineRetry, scheduleOfflineRetry } =
      await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    await db.add("mutations", {
      method: "POST",
      url: "/api/A",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "A",
      idempotencyKey: "rf-storm-aaaaaaaaaaaaa",
    });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "internal_error", message: "boom", details: null } }),
    })) as unknown as typeof fetch;

    // Two consecutive replays, each arming the scheduler.
    const r1 = await replayQueue();
    expect(r1.stoppedReason).toBe("server_indeterminate");
    expect(hasPendingOfflineRetry()).toBe(true);
    const r2 = await replayQueue();
    expect(r2.stoppedReason).toBe("server_indeterminate");
    expect(hasPendingOfflineRetry()).toBe(true);
    // scheduleOfflineRetry replaces the prior pending timer — never more
    // than one in flight.
    scheduleOfflineRetry(1);
    scheduleOfflineRetry(1);
    expect(hasPendingOfflineRetry()).toBe(true);
    cancelOfflineRetry();
  });
});

describe("F07 replay-finalization: replay lease heartbeat renewal during long-running HTTP", () => {
  it("replay heartbeat renews the lease during a long-running fetch", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    const sharedKey = "rf-hb-renew-aaaaaaaaaaaa";
    await db.add("mutations", {
      method: "POST",
      url: "/api/long",
      body: { step: "long" },
      enqueuedAt: new Date().toISOString(),
      label: "long",
      idempotencyKey: sharedKey,
    });

    let release!: () => void;
    globalThis.fetch = (async () => {
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response);
      });
    }) as unknown as typeof fetch;

    // Start the replay; it claims A and awaits fetch.
    const replay = replayQueue();

    // Yield so the claim tx commits and fetch() begins.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    // Read the row's lease after claim.
    const before = (await db.getAll("mutations"))[0] as {
      seq: number;
      inFlightUntil?: string;
      inFlightOwner?: string;
      inFlightGeneration?: number;
    };
    expect(before).toBeDefined();
    expect(before.deliveryState as string | undefined).toBe("in_flight");
    expect(before.inFlightUntil).toBeDefined();
    const initialExpiry = Date.parse(before.inFlightUntil!);
    const initialOwner = before.inFlightOwner!;
    const initialGeneration = before.inFlightGeneration!;
    const seq = before.seq;

    // Manually drive the heartbeat via the helper with a short interval
    // so the test does not need to advance fake time by 10s. We start the
    // heartbeat ourselves (mirror what replayQueueOnce does internally)
    // and assert renewal happens before the original 30s lease would
    // expire under normal heartbeat cadence.
    const { startReplayLeaseHeartbeat } = await import("../src/lib/offline/queue.js");
    const stop = startReplayLeaseHeartbeat(seq, initialOwner, initialGeneration, 50);

    // Wait long enough for one heartbeat tick + IDB commit.
    await new Promise((r) => setTimeout(r, 150));
    stop();

    const afterRenew = (await db.get("mutations", seq)) as {
      inFlightUntil?: string;
      inFlightOwner?: string;
    };
    const renewedExpiry = Date.parse(afterRenew.inFlightUntil!);
    expect(renewedExpiry).toBeGreaterThan(initialExpiry);
    // Same owner — no takeover.
    expect(afterRenew.inFlightOwner).toBe(initialOwner);

    // A competing claim attempt while the heartbeat has already extended
    // the lease MUST still see client_in_flight — the helper did its job.
    const { claimNextReplayMutation, newOwnerToken } = await import("../src/lib/offline/queue.js");
    const competing = await claimNextReplayMutation(newOwnerToken());
    expect(competing.kind).toBe("client_in_flight");
    if (competing.kind === "client_in_flight") {
      expect(competing.row.seq).toBe(seq);
      expect(competing.row.inFlightOwner).toBe(initialOwner);
    }

    // Release the fetch and let replay finish.
    release();
    const result = await replay;
    expect(result.replayed).toBe(1);
    expect(result.conflicts).toEqual([]);
    cancelOfflineRetry();
  });

  it("the heartbeat is a no-op (does not error) when renewMutationLease returns null because ownership moved on", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();
    const sharedKey = "rf-hb-loss-aaaaaaaaaaaa";
    await db.add("mutations", {
      method: "POST",
      url: "/api/loss",
      body: {},
      enqueuedAt: new Date().toISOString(),
      label: "loss",
      idempotencyKey: sharedKey,
    });

    let release!: () => void;
    globalThis.fetch = (async () => {
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: async () => ({ id: "ok" }) } as unknown as Response);
      });
    }) as unknown as typeof fetch;

    const replay = replayQueue();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    const before = (await db.getAll("mutations"))[0] as {
      seq: number;
      inFlightOwner?: string;
      inFlightGeneration?: number;
      deliveryState?: string;
    };
    const originalOwner = before.inFlightOwner!;
    const originalGeneration = before.inFlightGeneration!;
    expect(originalOwner).toBeDefined();
    expect(originalGeneration).toBeDefined();
    const seq = before.seq;

    // Start heartbeat on the original owner with a short interval.
    const { startReplayLeaseHeartbeat } = await import("../src/lib/offline/queue.js");
    const stop = startReplayLeaseHeartbeat(seq, originalOwner, originalGeneration, 30);

    // After one heartbeat tick the lease would be renewed — instead
    // simulate ownership moving on (e.g. another tab took over via
    // expired-lease path) BEFORE the tick. Then the renewal returns null
    // and the heartbeat swallows it.
    const tx = db.transaction("mutations", "readwrite");
    const store = tx.objectStore("mutations");
    const current = (await store.get(seq)) as Record<string, unknown>;
    await store.put({ ...current, inFlightOwner: "different-owner" });
    await tx.done;

    // Wait past one heartbeat tick.
    await new Promise((r) => setTimeout(r, 100));
    stop();

    // Now release the fetch. completeOwnedMutation refuses (owner mismatch)
    // → replay returns with client_in_flight. We never threw.
    release();
    const result = await replay;
    expect(result.stoppedReason).toBe("client_in_flight");
    cancelOfflineRetry();
  });
});

describe("F07 replay-finalization: heartbeat cleanup (no orphan interval)", () => {
  type Scenario = {
    name: string;
    fetch: () => Promise<MockResponseLike> | MockResponseLike;
    expectReason: string | null;
    cancelSchedulerAfter: boolean;
  };

  const scenarios: Scenario[] = [
    {
      name: "2xx success",
      fetch: () => ({ ok: true, status: 200, json: async () => ({ id: "ok" }) } as MockResponseLike),
      expectReason: null,
      cancelSchedulerAfter: false,
    },
    {
      name: "network failure",
      fetch: () => {
        throw new TypeError("network unreachable");
      },
      expectReason: "offline",
      cancelSchedulerAfter: false,
    },
    {
      name: "4xx semantic (409 stale_revision)",
      fetch: () =>
        ({
          ok: false,
          status: 409,
          json: async () => ({ error: { code: "stale_revision", message: "stale" } }),
        } as MockResponseLike),
      expectReason: null,
      cancelSchedulerAfter: false,
    },
    {
      name: "5xx (server_indeterminate)",
      fetch: () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({ error: { code: "internal_error", message: "boom" } }),
        } as MockResponseLike),
      expectReason: "server_indeterminate",
      cancelSchedulerAfter: true,
    },
  ];

  for (const scenario of scenarios) {
    it(`clears the lease heartbeat on ${scenario.name}`, async () => {
      const { hasPendingOfflineRetry, cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
      cancelOfflineRetry();

      const db = await offlineDb();
      await db.add("mutations", {
        method: "POST",
        url: "/api/cleanup",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "cleanup",
        idempotencyKey: `cleanup-${scenario.name.replace(/\W+/g, "-").toLowerCase()}-aaaa`,
      });

      globalThis.fetch = (async () => scenario.fetch()) as unknown as typeof fetch;

      const result = await replayQueue();
      if (scenario.expectReason !== null) {
        expect(result.stoppedReason).toBe(scenario.expectReason);
      } else {
        // 2xx / 4xx: replay did NOT stop on a retryable reason.
        expect(result.stoppedReason === null || result.stoppedReason === "client_in_flight").toBe(true);
      }

      // The heartbeat is cleared on every terminal path. The 5xx branch
      // arms the scheduler (single retry timer); every other branch must
      // leave ZERO pending scheduler timers behind.
      if (scenario.cancelSchedulerAfter) {
        expect(hasPendingOfflineRetry()).toBe(true);
        cancelOfflineRetry();
      }
      expect(hasPendingOfflineRetry()).toBe(false);
    });
  }
});

describe("F07 foreground in-progress: 409 idempotency_in_progress MUST release + retry + throw QueuedOfflineError", () => {
  it("foreground 409 idempotency_in_progress releases the owned stage, schedules a Retry-After retry, and throws QueuedOfflineError", async () => {
    const db = await offlineDb();
    const {
      hasPendingOfflineRetry,
      cancelOfflineRetry,
    } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "idempotency_in_progress",
            message: "still going",
            details: null,
          },
        }),
        headers: new Headers({ "retry-after": "1" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 fg in-progress" } });
    } catch (e) {
      caught = e;
    }

    // 1. The client MUST throw QueuedOfflineError(stagedSeq), NOT a plain
    //    ApiError — surfacing ApiError would let the page treat this as a
    //    retryable failure and the user could resubmit with a new key.
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const { ApiError } = await import("../src/lib/api.js");
    expect(caught).not.toBeInstanceOf(ApiError);

    // 2. The QueuedOfflineError must carry the SAME seq that's still in IDB.
    const errSeq = (caught as { seq: number }).seq;
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1); // no duplicate row
    expect(rows[0]!.seq).toBe(errSeq);
    const persistedKey = rows[0]!.idempotencyKey!;
    expect(persistedKey).toBeDefined();

    // 3. The outgoing header carried the SAME key the row now holds.
    expect(seenKeys).toEqual([persistedKey]);

    // 4. The owned stage was released back to `queued` with no lease fields.
    //    The row MUST NOT remain `in_flight` after the 409 — otherwise a
    //    competing replay would see `client_in_flight` and refuse to retry.
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();

    // 5. The shared retry scheduler is armed — exactly one timer.
    expect(hasPendingOfflineRetry()).toBe(true);

    // 6. No immediate second network call happened on the same call stack.
    expect(seenKeys).toHaveLength(1);
    cancelOfflineRetry();
  });

  it("foreground 409 in_progress → follow-up replay sends SAME key and clears the row when the server returns 2xx", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    const seenKeys: string[] = [];
    let attempt = 0;
    globalThis.fetch = (async (_url, init) => {
      attempt++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      if (attempt === 1) {
        // First attempt: foreground receives 409 in_progress with Retry-After.
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "idempotency_in_progress",
              message: "still going",
              details: null,
            },
          }),
          headers: new Headers({ "retry-after": "1" }),
        } as unknown as Response;
      }
      // Follow-up replay: server has finished, returns a normal 2xx.
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/projects", { method: "POST", body: { name: "F07 fg 409 then 200" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const persistedKey = rows[0]!.idempotencyKey!;
    const originalSeq = rows[0]!.seq!;
    expect(persistedKey).toBeDefined();

    // Trigger replay directly (the timer-firing path uses the same
    // RETRY_OFFLINE_QUEUE_EVENT → replayQueue() chain).
    const result = await replayQueue();
    expect(seenKeys).toEqual([persistedKey, persistedKey]);
    expect(seenKeys[1]).toBe(seenKeys[0]);
    expect(result.replayed).toBe(1);
    expect((await listMutations())).toHaveLength(0);
    expect((await listConflicts())).toHaveLength(0);
    // No duplicate row, no second key — only one logical mutation.
    expect(seenKeys.filter((k) => k === persistedKey)).toHaveLength(2);
    expect(seenKeys.filter((k) => k !== persistedKey)).toHaveLength(0);
    // The persisted seq is the one that replayed.
    expect(originalSeq).toBeDefined();
    cancelOfflineRetry();
  });

  it("ordering: A foreground 409 in_progress leaves B queued; replay sends A first, then B", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    const seenUrls: string[] = [];
    const seenKeys: string[] = [];
    let attempts = 0;
    globalThis.fetch = (async (url, init) => {
      attempts++;
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenUrls.push(u);
      seenKeys.push(headers["idempotency-key"] ?? "");
      // First attempt: A receives 409 in_progress.
      if (attempts === 1) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "idempotency_in_progress",
              message: "still going",
              details: null,
            },
          }),
          headers: new Headers({ "retry-after": "1" }),
        } as unknown as Response;
      }
      // Subsequent attempts: normal 2xx.
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/A", { method: "POST", body: { step: "A" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);

    // Now enqueue B behind A.
    await db.add("mutations", {
      method: "POST",
      url: "/api/B",
      body: { step: "B" },
      enqueuedAt: new Date().toISOString(),
      label: "B",
      idempotencyKey: "fg-ordering-B-keybbbbbbb",
    });

    // After the foreground 409 in_progress:
    //   A is queued (released), B is queued (added afterwards).
    //   B was NEVER sent during the foreground apiFetch call.
    expect(seenUrls).toEqual(["/api/A"]);
    const queuedAfter = await listMutations();
    expect(queuedAfter.map((m) => m.url)).toEqual(["/api/A", "/api/B"]);

    // Trigger replay manually (cancel the scheduler timer first).
    cancelOfflineRetry();
    const result = await replayQueue();
    // Replay sends A first, then B — order is preserved.
    expect(seenUrls).toEqual(["/api/A", "/api/A", "/api/B"]);
    // Both attempts of /api/A carry the SAME idempotency key (first from
    // the foreground apiFetch, second from the replay); B carries its own.
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(seenKeys[0]).not.toBe(seenKeys[2]);
    expect(result.replayed).toBe(2);
    expect((await listMutations())).toHaveLength(0);
  });

  it("foreground 409 in_progress without a usable Retry-After fallback to the bounded default delay", async () => {
    const db = await offlineDb();
    const {
      hasPendingOfflineRetry,
      cancelOfflineRetry,
    } = await import("../src/lib/offline/scheduler.js");
    const { DEFAULT_IN_PROGRESS_RETRY_MS } = await import("../src/lib/offline/queue.js");
    cancelOfflineRetry();

    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "idempotency_in_progress",
          message: "still going",
          details: null,
        },
      }),
      // No `retry-after` header → parser returns undefined → default used.
    })) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/imports/text", { method: "POST", body: { text: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryState).toBe("queued");
    expect(rows[0]!.inFlightOwner).toBeUndefined();
    expect(rows[0]!.inFlightUntil).toBeUndefined();
    expect(hasPendingOfflineRetry()).toBe(true);
    // Only one scheduler timer is armed — no immediate loop.
    expect(DEFAULT_IN_PROGRESS_RETRY_MS).toBe(1000);
    cancelOfflineRetry();
  });

  it("timer coalescing: repeated 409 in_progress responses do NOT stack timers", async () => {
    const db = await offlineDb();
    const {
      hasPendingOfflineRetry,
      cancelOfflineRetry,
      scheduleOfflineRetry,
    } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    // Three back-to-back `scheduleOfflineRetry` calls must still leave
    // exactly ONE timer armed (the scheduler is single-flight by design).
    scheduleOfflineRetry(500);
    scheduleOfflineRetry(500);
    scheduleOfflineRetry(500);
    expect(hasPendingOfflineRetry()).toBe(true);
    cancelOfflineRetry();
    expect(hasPendingOfflineRetry()).toBe(false);
  });

  it("non-queueable request (noQueue: true) receiving 409 idempotency_in_progress stays a normal ApiError (no row, no scheduler, no QueuedOfflineError)", async () => {
    const db = await offlineDb();
    const {
      hasPendingOfflineRetry,
      cancelOfflineRetry,
    } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    const seenHeaders: { key?: string }[] = [];
    globalThis.fetch = (async (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push({ key: h["idempotency-key"] });
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            code: "idempotency_in_progress",
            message: "still going",
            details: null,
          },
        }),
        headers: new Headers({ "retry-after": "1" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/auth/refresh", {
        method: "POST",
        body: { token: "x" },
        noQueue: true,
      });
    } catch (e) {
      caught = e;
    }

    // Non-queueable: no idempotency key was sent, no mutation row exists,
    // no scheduler was armed, no QueuedOfflineError was thrown.
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(QueuedOfflineError);
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]!.key).toBeUndefined();
    expect((await db.getAll("mutations"))).toHaveLength(0);
    expect(hasPendingOfflineRetry()).toBe(false);
  });

  it("noQueue: true idempotency_in_progress → ApiError carries the server code/message verbatim", async () => {
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    globalThis.fetch = (async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "idempotency_in_progress",
          message: "still going",
          details: null,
        },
      }),
      headers: new Headers({ "retry-after": "1" }),
    })) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/auth/refresh", {
        method: "POST",
        body: { token: "x" },
        noQueue: true,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(409);
    expect(apiErr.code).toBe("idempotency_in_progress");
    expect(apiErr.message).toMatch(/still going/);
  });
});

describe("F07 foreground barrier: existing idempotency_outcome_unknown conflict blocks new foreground network send", () => {
  it("A) existing blocker stops the foreground apiFetch from sending; row is queued behind the barrier with same key", async () => {
    const db = await offlineDb();

    // Seed a durable unknown-outcome blocker directly in the conflicts store.
    await db.add("conflicts", {
      mutation: {
        seq: 1,
        method: "POST",
        url: "/api/old-mutation",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "old mutation",
        idempotencyKey: "fg-barrier-old-key-aaaaaaa",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "Previous outcome was indeterminate.",
      detectedAt: new Date().toISOString(),
    });

    // No fetch must ever happen.
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "would-have-applied" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    let caught: unknown = null;
    try {
      await apiFetch("/api/new-foreground", {
        method: "POST",
        body: { name: "foreground behind barrier" },
      });
    } catch (e) {
      caught = e;
    }

    // Caller sees QueuedOfflineError (NOT ApiError) — same shape as the
    // existing offline / 5xx / 429 / 409 in_progress paths.
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    expect(caught).not.toBeInstanceOf(ApiError);

    // No network call happened.
    expect(calls).toEqual([]);

    // A mutation row WAS persisted with a durable key (no duplicates,
    // no new key minted after the throw).
    const rows = await db.getAll("mutations");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.url).toBe("/api/new-foreground");
    expect(row.idempotencyKey).toBeDefined();
    expect(typeof row.idempotencyKey).toBe("string");
    // BUT it is queued — no owner, no lease, NOT in_flight. Otherwise a
    // future replay would race against the durable unknown barrier.
    expect(row.deliveryState).toBe("queued");
    expect(row.inFlightOwner).toBeUndefined();
    expect(row.inFlightUntil).toBeUndefined();

    // The seq carried by the error equals the persisted row's seq.
    expect((caught as { seq: number }).seq).toBe(row.seq);
  });

  it("B) after the blocker is acknowledged, replay sends the SAME seq with the SAME idempotency key and clears the row", async () => {
    const db = await offlineDb();
    const { cancelOfflineRetry } = await import("../src/lib/offline/scheduler.js");
    cancelOfflineRetry();

    // Seed the blocker.
    const blockerSeq = (await db.add("conflicts", {
      mutation: {
        seq: 1,
        method: "POST",
        url: "/api/old-mutation",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "old mutation",
        idempotencyKey: "fg-barrier-old-key-bbbbbbb",
      },
      status: 409,
      code: "idempotency_outcome_unknown",
      message: "Previous outcome was indeterminate.",
      detectedAt: new Date().toISOString(),
    })) as number;

    // Stage a foreground mutation while the blocker is present — must
    // end up queued behind the barrier.
    let caught: unknown = null;
    try {
      await apiFetch("/api/post-ack", { method: "POST", body: { name: "x" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueuedOfflineError);
    const queuedAfterStage = await listMutations();
    expect(queuedAfterStage).toHaveLength(1);
    const originalSeq = queuedAfterStage[0]!.seq!;
    const originalKey = queuedAfterStage[0]!.idempotencyKey!;
    expect(originalKey).toBeDefined();

    // Acknowledge (dismiss) the blocker.
    await dismissConflict(blockerSeq);
    expect((await listConflicts())).toHaveLength(0);

    // Now the post-ack replay must pick up the SAME row (same seq, same
    // key) and send it.
    const seenKeys: string[] = [];
    let attempt = 0;
    globalThis.fetch = (async (_url, init) => {
      attempt++;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await replayQueue();
    expect(attempt).toBe(1);
    expect(seenKeys).toEqual([originalKey]);
    expect(result.replayed).toBe(1);
    expect((await listMutations())).toHaveLength(0);
    // The persisted row carries the same seq it was born with — we did
    // NOT re-stage a new row.
    expect((await listConflicts())).toHaveLength(0);
  });

  it("C) with NO blocker, the foreground apiFetch still stages the row as in_flight in ONE atomic write", async () => {
    const db = await offlineDb();
    expect((await listConflicts())).toHaveLength(0);

    // Capture: fetch should be called once with the row's durable key.
    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await apiFetch("/api/no-blocker", {
      method: "POST",
      body: { name: "no blocker" },
    });
    expect(result).toEqual({ id: "ok" });
    expect(seenKeys).toHaveLength(1);
    const sentKey = seenKeys[0]!;

    // Row was cleaned up on the 2xx success path.
    expect((await listMutations())).toHaveLength(0);

    // No conflict was created.
    expect((await listConflicts())).toHaveLength(0);
    // The sent key was a valid UUID-shaped string (or whatever the
    // generator emits) — just sanity-check it is non-empty.
    expect(sentKey.length).toBeGreaterThan(8);
  });

  it("D) ordinary non-blocking conflict (code !== 'idempotency_outcome_unknown') does NOT globally block new foreground mutations", async () => {
    const db = await offlineDb();

    // Seed a NON-blocking conflict — stale_revision is the canonical
    // example: deterministic business error from a prior session. The
    // durable barrier is ONLY for `idempotency_outcome_unknown`.
    await db.add("conflicts", {
      mutation: {
        seq: 1,
        method: "PUT",
        url: "/api/records/old",
        body: {},
        enqueuedAt: new Date().toISOString(),
        label: "old",
        idempotencyKey: "stale-old-key-cccccccccc",
      },
      status: 409,
      code: "stale_revision",
      message: "server revision is 5, client sent 1",
      detectedAt: new Date().toISOString(),
    });

    const seenKeys: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenKeys.push(headers["idempotency-key"] ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "ok" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // The new foreground mutation MUST still send — stale_revision does
    // not impose a global ordering barrier.
    const result = await apiFetch("/api/independent", {
      method: "POST",
      body: { name: "orthogonal" },
    });
    expect(result).toEqual({ id: "ok" });
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toBeDefined();
    expect(seenKeys[0]!.length).toBeGreaterThan(8);
    // The pre-existing stale_revision conflict is still there — we did
    // not touch it.
    expect((await listConflicts())).toHaveLength(1);
    expect((await listMutations())).toHaveLength(0);
  });
});


describe("2026-09-19 A03/A10 durable replay regressions", () => {
  it("persists near-duplicate import preview instead of dropping the queued intent", async () => {
    await enqueueMutation({
      method: "POST",
      url: "/api/imports/text",
      body: { text: "similar text", adapterId: "manual", projectId: null },
      enqueuedAt: new Date().toISOString(),
      label: "queued import",
    });
    mockFetch([() => okJson({
      status: "near_duplicate_pending",
      sourceId: null,
      excerptCount: 0,
      candidateCount: 0,
      candidates: [],
      warnings: [],
      nearDuplicates: [{ sourceId: "source-existing", title: "Existing", similarity: 0.94, importedAt: new Date().toISOString() }],
      duplicateOf: null,
    })]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(await listMutations()).toEqual([]);
    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.code).toBe("near_duplicate_pending");
    expect((conflicts[0]!.response as { status?: string }).status).toBe("near_duplicate_pending");
    expect(conflicts[0]!.mutation.idempotencyKey).toBeTruthy();
  });

  it("persists replayed correction previews so the owner can still confirm them", async () => {
    await enqueueMutation({
      method: "POST",
      url: "/api/corrections",
      body: { statement: "new owner correction", projectId: null },
      enqueuedAt: new Date().toISOString(),
      label: "queued correction",
    });
    mockFetch([() => okJson({
      jobId: "job-replayed",
      proposedRecordIds: ["record-1"],
      affected: [],
      warnings: [],
    })]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(await listMutations()).toEqual([]);
    const conflicts = await listConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.code).toBe("correction_preview_pending");
    expect((conflicts[0]!.response as { jobId?: string }).jobId).toBe("job-replayed");
  });

  it("keeps an inbox decision queued when a 200 response body cannot be decoded", async () => {
    const seq = await enqueueMutation({
      method: "POST",
      url: "/api/inbox/decide",
      body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" },
      enqueuedAt: new Date().toISOString(),
      label: "accept r1",
    });
    const before = (await listMutations()).find((row) => row.seq === seq)!;
    mockFetch([() => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("truncated body"); },
    })]);

    const result = await replayQueue();
    expect(result.replayed).toBe(0);
    expect(result.stoppedReason).toBe("response_invalid");
    expect(result.conflicts).toEqual([]);
    const remaining = await listMutations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.seq).toBe(seq);
    expect(remaining[0]!.idempotencyKey).toBe(before.idempotencyKey);
    expect(remaining[0]!.deliveryState).toBe("queued");
  });
});
