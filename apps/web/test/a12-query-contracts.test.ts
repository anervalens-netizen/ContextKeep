import { afterEach, describe, expect, it } from "vitest";
import { cacheScopes, queryKeys, queryRoots } from "../src/lib/query-contracts.js";
import { legacyCanonicalSearchKey, readCache, searchKey } from "../src/lib/offline/mirror.js";
import { offlineDb } from "../src/lib/offline/db.js";

afterEach(async () => {
  const db = await offlineDb();
  await db.clear("cache");
});

describe("CK-A12 shared web query/cache contracts", () => {
  it("uses one stable producer identity for projects/meta/work-context/inbox", () => {
    expect(queryKeys.projects).toBe(queryRoots.projects);
    expect(queryKeys.meta).toBe(queryRoots.meta);
    expect(queryKeys.workContext("p1")).toEqual(["work-context", "p1"]);
    expect(queryKeys.inbox("p1", 2, 50)).toEqual(["inbox", "p1", 2, 50]);
    expect(cacheScopes.projects).toBe("projects:list");
    expect(cacheScopes.meta).toBe("meta:dashboard");
    expect(cacheScopes.workContext("p1")).toBe("project:p1:work-context");
    expect(cacheScopes.inbox("p1", 2, 50)).toBe("inbox:project=p1:page=2:limit=50");
  });

  it("keeps global and project-scoped inbox identities distinct", () => {
    expect(queryKeys.inbox(null, 1, 50)).not.toEqual(queryKeys.inbox("p1", 1, 50));
    expect(cacheScopes.inbox(null, 1, 50)).not.toBe(cacheScopes.inbox("p1", 1, 50));
  });

  it("keeps search scope in the cache identity while retaining an exact old canonical key", () => {
    const base = { query: "release", includeHistorical: false, projectId: "p1" };
    expect(searchKey({ ...base, scope: "canonical" })).not.toBe(searchKey({ ...base, scope: "working" }));
    expect(searchKey({ ...base, scope: "all" })).not.toBe(searchKey({ ...base, scope: "working" }));
    expect(legacyCanonicalSearchKey(base)).not.toBe(searchKey({ ...base, scope: "canonical" }));
  });

  it("reads an old scoped canonical row without allowing it to satisfy working/all scope", async () => {
    const base = { query: "release", includeHistorical: false, projectId: "p1" };
    const oldKey = legacyCanonicalSearchKey(base);
    const oldScope = "search:q=release:historical=false:project=p1";
    const db = await offlineDb();
    await db.put("cache", {
      key: oldKey,
      value: { query: "release", records: [], workingRecords: [], projects: [], sources: [], tookMs: 1 },
      savedAt: "2026-09-24T00:00:00.000Z",
      provenance: { generation: 2, source: "network", fetchedAt: "2026-09-23T23:00:00.000Z", savedAt: "2026-09-24T00:00:00.000Z", scope: oldScope, cursor: null },
    });

    await expect(readCache(oldKey, oldScope)).resolves.toMatchObject({ provenance: { scope: oldScope } });
    await expect(readCache(searchKey({ ...base, scope: "working" }), `${oldScope}:scope=working`)).resolves.toBeNull();
    await expect(readCache(searchKey({ ...base, scope: "all" }), `${oldScope}:scope=all`)).resolves.toBeNull();
  });
});
