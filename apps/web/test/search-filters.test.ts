import { describe, expect, it } from "vitest";
import { isRecordedDate, searchCacheScope, searchFilterError, validateSearchFilters } from "../src/lib/search-filters.js";
import { searchKey } from "../src/lib/offline/mirror.js";

describe("exact search filter identities", () => {
  const base = { query: "release", includeHistorical: false, projectId: "alpha", scope: "canonical" as const, recordType: "fact", recordedFrom: "2026-09-01", recordedTo: "2026-09-30", limit: 100 };
  it.each([
    { query: "other" }, { includeHistorical: true }, { projectId: "beta" }, { projectId: null },
    { scope: "working" as const }, { scope: "all" as const }, { recordType: "decision" },
    { recordType: undefined }, { recordedFrom: "2026-09-02" }, { recordedFrom: undefined },
    { recordedTo: "2026-09-29" }, { recordedTo: undefined }, { limit: 50 }, { limit: 150 },
  ])("isolates changed field %j in both durable key and scope", change => {
    expect(searchKey({ ...base, ...change })).not.toBe(searchKey(base));
    expect(searchCacheScope({ ...base, ...change })).not.toBe(searchCacheScope(base));
  });
  it("retains the unfiltered default-50 scoped mirror identity", () => {
    const old = { query: "release", includeHistorical: false, projectId: "alpha" };
    expect(searchKey(old)).toBe('search:v2:["release",false,"alpha","canonical"]');
    expect(searchKey({ ...old, limit: 50 })).toBe(searchKey(old));
    expect(searchCacheScope({ ...old, limit: 50 })).toBe("search:q=release:historical=false:project=alpha:scope=canonical");
    expect(searchKey({ ...old, limit: 100 })).not.toBe(searchKey(old));
  });
});

describe("shared URL validation", () => {
  it.each(["2026-02-29", "2026-02-30", "2026-04-31", "2026-00-01", "2026-01-00", "2026-13-01", "2026-1-01", "2026-01-01T00:00:00Z"])("rejects impossible or non-date-only input %s", value => {
    expect(isRecordedDate(value)).toBe(false);
    const parsed = validateSearchFilters({ recordedFrom: value });
    expect(parsed.recordedFrom).toBe(value);
    expect(searchFilterError(parsed)).toContain(value);
  });
  it("accepts leap days and the same inclusive UTC day", () => {
    expect(isRecordedDate("2024-02-29")).toBe(true);
    expect(searchFilterError(validateSearchFilters({ recordedFrom: "2024-02-29", recordedTo: "2024-02-29" }))).toBeNull();
    expect(searchFilterError(validateSearchFilters({ recordedFrom: "2026-10-01", recordedTo: "2026-09-30" }))).toContain("must be on or before");
  });
  it.each(["0", "201", "1.5", "no", -1, 0, 201, 1.5, false, [50, 100]])("rejects invalid limit %j rather than widening the request", limit => {
    expect(searchFilterError(validateSearchFilters({ limit }))).toContain("Invalid result limit");
  });
  it.each([1, 50, 100, 150, 200, "1", "200"])("retains a valid URL limit %j", limit => {
    const filters = validateSearchFilters({ limit });
    expect(filters.limit).toBe(Number(limit));
    expect(searchFilterError(filters)).toBeNull();
  });
  it("preserves malformed structured URL values for explicit error display", () => {
    const filters = validateSearchFilters({ recordType: ["fact", "decision"] });
    expect(filters.recordType).toBe('["fact","decision"]');
    expect(searchFilterError(filters)).toContain('["fact","decision"]');
  });
});
