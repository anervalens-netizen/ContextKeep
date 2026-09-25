import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  CallerAbortedError,
  UnverifiedDataResponseError,
  apiFetch,
  isNetworkUnavailableError,
  setPrivateReadsPausedForAuthTransition,
} from "../src/lib/api.js";
import { offlineDb } from "../src/lib/offline/db.js";
import { purgeLegacyContextKeepApiCaches } from "../src/lib/offline/sw-data-cache.js";

const originalFetch = globalThis.fetch;

beforeEach(async () => {
  setPrivateReadsPausedForAuthTransition(false);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  const db = await offlineDb();
  await db.clear("mutations");
  await db.clear("cache");
  await db.clear("conflicts");
});

afterEach(() => {
  setPrivateReadsPausedForAuthTransition(false);
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("auth-transition private read barrier", () => {
  it("blocks private reads without blocking public auth bootstrap", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: false, needsSetup: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setPrivateReadsPausedForAuthTransition(true);

    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(CallerAbortedError);
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(apiFetch("/api/auth/status", { noQueue: true })).resolves.toEqual({
      authenticated: false,
      needsSetup: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("CK-A04 API provenance handshake", () => {
  it("rejects a legacy service-worker 200 without the live-network marker", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "old" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await apiFetch("/api/projects");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnverifiedDataResponseError);
    expect(isNetworkUnavailableError(thrown)).toBe(true);
  });

  it("accepts a marked live server response only when it echoes this request nonce", async () => {
    let observedRequestId: string | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      observedRequestId = headers["x-contextkeep-request-id"];
      return new Response(JSON.stringify([{ id: "fresh" }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-contextkeep-data-source": "network-v1",
          "x-contextkeep-fetched-at": "2026-09-23T09:00:00.000Z",
          "x-contextkeep-response-id": observedRequestId!,
        },
      });
    }) as unknown as typeof fetch;

    const provenance: Array<{ fetchedAt: string; requestId: string }> = [];
    await expect(apiFetch<Array<{ id: string }>>("/api/projects", {
      onDataProvenance: (meta) => provenance.push(meta),
    })).resolves.toEqual([{ id: "fresh" }]);
    expect(observedRequestId).toBeTruthy();
    expect(provenance).toEqual([{
      fetchedAt: "2026-09-23T09:00:00.000Z",
      requestId: observedRequestId!,
    }]);
  });

  it("rejects a previously marked response replayed by an old service worker with the wrong nonce", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: "stale-but-marked" }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-contextkeep-data-source": "network-v1",
          "x-contextkeep-fetched-at": "2026-09-22T09:00:00.000Z",
          "x-contextkeep-response-id": "old-request-id-12345678",
        },
      }),
    ) as unknown as typeof fetch;

    await expect(apiFetch("/api/projects")).rejects.toBeInstanceOf(UnverifiedDataResponseError);
  });

  it("keeps 401 distinct from offline/cache fallback even without a provenance marker", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await apiFetch("/api/projects");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(401);
    expect(isNetworkUnavailableError(thrown)).toBe(false);
  });
});

describe("CK-A04 legacy SW cache migration", () => {
  it("deletes only ContextKeep legacy API caches and leaves IndexedDB mutations intact", async () => {
    const db = await offlineDb();
    await db.add("mutations", {
      method: "POST",
      url: "/api/projects",
      body: { name: "offline project" },
      enqueuedAt: "2026-09-23T08:00:00.000Z",
      idempotencyKey: "stable-key-12345678",
    });

    const deleted: string[] = [];
    const storage = {
      keys: vi.fn(async () => [
        "ck-brief",
        "ck-inbox",
        "ck-search",
        "ck-projects",
        "workbox-precache-v2-owner",
        "other-app-api",
      ]),
      delete: vi.fn(async (name: string) => {
        deleted.push(name);
        return true;
      }),
    };

    await expect(purgeLegacyContextKeepApiCaches(storage as unknown as CacheStorage)).resolves.toEqual([
      "ck-brief",
      "ck-inbox",
      "ck-search",
      "ck-projects",
    ]);
    expect(deleted).toEqual(["ck-brief", "ck-inbox", "ck-search", "ck-projects"]);
    expect((await db.getAll("mutations"))).toHaveLength(1);
  });
});
