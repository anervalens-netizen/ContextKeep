import { beforeEach, describe, expect, it } from "vitest";
import { offlineDb } from "../src/lib/offline/db.js";
import { briefKey, INBOX_KEY, readCache, saveToCache, searchKey, SEARCH_LAST_KEY } from "../src/lib/offline/mirror.js";

beforeEach(async () => {
  const db = await offlineDb();
  await db.clear("cache");
});

describe("offline mirror (M0 scope 9: brief + last inbox page + last search)", () => {
  it("round-trips the current brief per project", async () => {
    const brief = { project: { id: "p1", name: "ExampleSuite Keyboard" }, facts: [{ text: "voice uses OpenAI" }] };
    await saveToCache(briefKey("p1"), brief, {
      fetchedAt: "2026-09-23T08:00:00.000Z",
      scope: "project:p1:brief",
      cursor: 7,
    });
    const read = await readCache<typeof brief>(briefKey("p1"), "project:p1:brief");
    expect(read).not.toBeNull();
    expect(read!.value).toEqual(brief);
    expect(typeof read!.savedAt).toBe("string");
    expect(read!.provenance).toMatchObject({
      source: "cache",
      fetchedAt: "2026-09-23T08:00:00.000Z",
      scope: "project:p1:brief",
      cursor: 7,
    });
  });

  it("round-trips the last inbox page", async () => {
    const page = { candidates: [{ id: "c1", text: "proposed fact" }], total: 1, byProject: [] };
    await saveToCache(INBOX_KEY, page, { scope: "inbox:limit=1000", cursor: null });
    const read = await readCache<typeof page>(INBOX_KEY, "inbox:limit=1000");
    expect(read!.value).toEqual(page);
  });

  it("round-trips the last search results", async () => {
    const search = { query: "voice", records: [], projects: [], sources: [], tookMs: 1 };
    const key = searchKey({ query: "voice", includeHistorical: false, projectId: "p1" });
    await saveToCache(key, search, { scope: "search:q=voice:historical=false:project=p1", cursor: null });
    const read = await readCache<typeof search>(key, "search:q=voice:historical=false:project=p1");
    expect(read!.value.query).toBe("voice");
    expect(searchKey({ query: "voice", includeHistorical: false, projectId: "p1" }))
      .not.toBe(searchKey({ query: "voice", includeHistorical: false, projectId: "p2" }));
    expect(searchKey({ query: "voice", includeHistorical: false, projectId: "p1" }))
      .not.toBe(searchKey({ query: "voice", includeHistorical: true, projectId: "p1" }));
  });

  it("returns null for missing keys", async () => {
    expect(await readCache("does-not-exist")).toBeNull();
  });

  it("overwrites previous values", async () => {
    await saveToCache(briefKey("p2"), { v: 1 });
    await saveToCache(briefKey("p2"), { v: 2 });
    const read = await readCache<{ v: number }>(briefKey("p2"));
    expect(read!.value.v).toBe(2);
  });

  it("does not rewrite fetchedAt when hydrating from cache", async () => {
    await saveToCache("stable", { v: 1 }, {
      fetchedAt: "2026-09-20T10:00:00.000Z",
      scope: "stable-scope",
      cursor: { canonicalCursor: 3 },
    });
    const first = await readCache<{ v: number }>("stable", "stable-scope");
    const second = await readCache<{ v: number }>("stable", "stable-scope");
    expect(first!.provenance.fetchedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(second!.provenance.fetchedAt).toBe(first!.provenance.fetchedAt);
    expect(second!.provenance.cursor).toEqual({ canonicalCursor: 3 });
  });

  it("keeps legacy rows readable but marks original freshness unknown", async () => {
    const db = await offlineDb();
    await db.put("cache", {
      key: SEARCH_LAST_KEY,
      value: { query: "legacy" },
      savedAt: "2026-09-22T12:00:00.000Z",
    });
    const read = await readCache<{ query: string }>(SEARCH_LAST_KEY);
    expect(read!.value.query).toBe("legacy");
    expect(read!.provenance).toMatchObject({
      source: "legacy-cache",
      fetchedAt: null,
      cursor: null,
    });
  });

  it("keeps known legacy scoped mirrors readable without inventing fetchedAt", async () => {
    const db = await offlineDb();
    await db.put("cache", {
      key: briefKey("p-legacy"),
      value: { v: 1 },
      savedAt: "2026-09-22T12:00:00.000Z",
    });
    const read = await readCache<{ v: number }>(briefKey("p-legacy"), "project:p-legacy:brief");
    expect(read!.value.v).toBe(1);
    expect(read!.provenance).toMatchObject({
      source: "legacy-cache",
      fetchedAt: null,
      scope: "project:p-legacy:brief",
    });
  });

  it("refuses a scoped mirror row under the wrong project/query scope", async () => {
    await saveToCache("scoped", { v: 1 }, { scope: "project:A", cursor: 1 });
    expect(await readCache("scoped", "project:B")).toBeNull();
  });
});
