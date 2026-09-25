import { afterEach, describe, expect, it } from "vitest";
import { deleteOfflineDatabase, offlineDb } from "../src/lib/offline/db.js";
import { purgeLocalContextKeepData } from "../src/lib/offline/local-data.js";
import { saveToCache } from "../src/lib/offline/mirror.js";
import { setLocalDataAccessPaused, subscribeLocalDataAccess } from "../src/lib/offline/local-data-state.js";

afterEach(async () => {
  setLocalDataAccessPaused(false);
  await deleteOfflineDatabase();
  localStorage.clear();
});

async function seedUnsafe(): Promise<void> {
  const db = await offlineDb();
  await db.add("mutations", {
    method: "POST",
    url: "/api/inbox/decide",
    body: { items: [{ recordId: "r1", revision: 1 }], action: "accept" },
    enqueuedAt: "2026-09-23T20:00:00.000Z",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    deliveryState: "queued",
  });
  await db.add("conflicts", {
    mutation: {
      method: "POST",
      url: "/api/import",
      enqueuedAt: "2026-09-23T20:00:00.000Z",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      deliveryState: "queued",
    },
    status: 409,
    code: "near_duplicate_pending",
    message: "Owner review required",
    detectedAt: "2026-09-23T20:01:00.000Z",
  });
  await db.put("cache", {
    key: "brief:p1",
    value: { secret: "cached project data" },
    savedAt: "2026-09-23T20:00:00.000Z",
  });
}

describe("CK-A14 deliberate local-data purge", () => {
  it("blocks the default purge while queued or review-required work exists and preserves every row", async () => {
    await seedUnsafe();

    const result = await purgeLocalContextKeepData({ discardUnsynced: false });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("expected blocked purge");
    expect(result.summary).toMatchObject({
      queued: 1,
      conflicts: 1,
      reviewRequired: 1,
      unsafeCount: 2,
    });

    const db = await offlineDb();
    expect(await db.count("mutations")).toBe(1);
    expect(await db.count("conflicts")).toBe(1);
    expect(await db.count("cache")).toBe(1);
  });

  it("requires explicit discard, deletes only local ContextKeep storage, and blocks delayed cache repopulation", async () => {
    await seedUnsafe();

    const result = await purgeLocalContextKeepData({ discardUnsynced: true });
    expect(result.status).toBe("complete");

    await expect(offlineDb()).rejects.toThrow(/paused/i);
    await expect(saveToCache("late", { shouldNot: "return" })).rejects.toThrow(/paused/i);

    setLocalDataAccessPaused(false);
    const fresh = await offlineDb();
    expect(await fresh.count("mutations")).toBe(0);
    expect(await fresh.count("conflicts")).toBe(0);
    expect(await fresh.count("cache")).toBe(0);
  });

  it("broadcasts the pause barrier so another tab can stop reads before deletion", () => {
    const original = globalThis.BroadcastChannel;
    const peers = new Set<any>();
    class FakeBroadcastChannel {
      private listeners = new Set<(event: MessageEvent) => void>();
      constructor(readonly name: string) { peers.add(this); }
      addEventListener(_type: string, listener: (event: MessageEvent) => void): void { this.listeners.add(listener); }
      removeEventListener(_type: string, listener: (event: MessageEvent) => void): void { this.listeners.delete(listener); }
      postMessage(data: unknown): void {
        for (const peer of peers) {
          if (peer === this || peer.name !== this.name) continue;
          for (const listener of peer.listeners) listener({ data } as MessageEvent);
        }
      }
      close(): void { peers.delete(this); }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: FakeBroadcastChannel });
    const seen: boolean[] = [];
    const release = subscribeLocalDataAccess((paused) => seen.push(paused));
    try {
      setLocalDataAccessPaused(true);
      expect(seen).toEqual([true]);
      setLocalDataAccessPaused(false);
      expect(seen).toEqual([true, false]);
    } finally {
      release();
      Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: original });
    }
  });

  it("reports partial cleanup honestly instead of claiming success", async () => {
    const db = await offlineDb();
    await db.put("cache", {
      key: "brief:p1",
      value: { cached: true },
      savedAt: "2026-09-23T20:00:00.000Z",
    });

    const result = await purgeLocalContextKeepData({
      discardUnsynced: false,
      deleteDatabase: async () => {
        throw new Error("simulated blocked deleteDatabase");
      },
    });
    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial purge");
    expect(result.errors).toContain("IndexedDB could not be fully deleted.");
  });
});
