import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SearchQuery, type SearchResultDto, type SearchScope } from "@contextkeep/shared";
import { projects, records, sources } from "../src/db/schema.js";
import { retrieveRecordMatches, search } from "../src/services/search.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const day = "2024-02-29";
const timestamp = `${day}T12:00:00.000Z`;
const scopes = ["canonical", "working", "all"] as const;
type Row = typeof records.$inferInsert;
type Filters = { recordType?: "fact" | "decision"; recordedFrom?: string; recordedTo?: string };
type Path = "fts" | "like" | "list";

afterEach(async () => {
  for (const t of apps.splice(0)) await t.cleanup();
});

async function fixture() {
  const t = await makeTestApp({ adapters: "manual" });
  apps.push(t);
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  for (const id of [projectId, otherProjectId]) {
    t.app.ck.deps.db.insert(projects).values({
      id, name: `searchfilter ${id}`, createdAt: timestamp, updatedAt: timestamp,
    }).run();
  }
  const add = (overrides: Partial<Row> = {}) => {
    const id = randomUUID();
    t.app.ck.deps.db.insert(records).values({
      id, projectId, type: "fact", subject: `Synthetic observation ${id}`,
      text: "searchfilter beacon", reviewStatus: "accepted", evidenceBasis: "document",
      recordDedupHash: id, recordedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
      // Different temporal axes must not affect the recordedAt filter.
      sourceEventAt: "2020-01-01T00:00:00.000Z", effectiveFrom: "2030-01-01T00:00:00.000Z",
      ...overrides,
    }).run();
    return id;
  };
  return { t, projectId, otherProjectId, add };
}

async function query(t: TestApp, projectId: string, scope: SearchScope, filters: Filters, path: Path,
  extra: { includeHistorical?: boolean; limit?: number; match?: "terms" | "phrase" } = {}) {
  if (path === "list") {
    return search(t.app.ck.deps, {
      q: "", projectId, scope, type: filters.recordType,
      recordedFrom: filters.recordedFrom, recordedTo: filters.recordedTo, ...extra,
    });
  }
  const params = new URLSearchParams({ q: "searchfilter beacon", projectId, scope, ...filters });
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) params.set(key, String(value));
  const res = await t.get(`/api/search?${params}`);
  expectStatus(res, 200, `${path} ${scope} ${params}`);
  return res.json<SearchResultDto>();
}

function ids(rows: Array<{ id: string }>) { return rows.map((row) => row.id).sort(); }

describe.each<Path>(["fts", "like", "list"])("search record filters through %s", (path) => {
  it("applies type and one/two-sided dates in every scope without leaking other projects or review states", async () => {
    const { t, projectId, otherProjectId, add } = await fixture();
    const groups = ["canonical", "working"] as const;
    const byGroup = {} as Record<typeof groups[number], Record<string, string>>;
    for (const group of groups) {
      const state = group === "canonical"
        ? { reviewStatus: "accepted", evidenceBasis: "document" }
        : { reviewStatus: "proposed", evidenceBasis: "agent_report" };
      byGroup[group] = {
        before: add({ ...state, recordedAt: "2024-02-28T23:59:59.999Z" }),
        start: add({ ...state, recordedAt: `${day}T00:00:00.000Z` }),
        end: add({ ...state, recordedAt: `${day}T23:59:59.999Z` }),
        after: add({ ...state, recordedAt: "2024-03-01T00:00:00.000Z" }),
        decision: add({ ...state, type: "decision" }),
      };
      add({ ...state, projectId: otherProjectId });
      add({ ...state, reviewStatus: "rejected" });
    }
    add({ reviewStatus: "proposed", evidenceBasis: "document" });
    const historical = add({ reviewStatus: "superseded" });
    if (path === "like") {
      // Only the isolated fixture's derived index is emptied to exercise fallback.
      t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
      expect(t.app.ck.deps.sqlite.prepare("SELECT count(*) AS n FROM ck_records_fts").get()).toEqual({ n: 0 });
    }
    const cases: Array<{ filters: Filters; keys: string[] }> = [
      { filters: {}, keys: ["before", "start", "end", "after", "decision"] },
      { filters: { recordType: "fact" }, keys: ["before", "start", "end", "after"] },
      { filters: { recordType: "decision" }, keys: ["decision"] },
      { filters: { recordedFrom: day }, keys: ["start", "end", "after", "decision"] },
      { filters: { recordedTo: day }, keys: ["before", "start", "end", "decision"] },
      { filters: { recordedFrom: day, recordedTo: day }, keys: ["start", "end", "decision"] },
      { filters: { recordType: "fact", recordedFrom: day, recordedTo: day }, keys: ["start", "end"] },
      { filters: { recordedFrom: "2025-01-01" }, keys: [] },
    ];
    for (const scope of scopes) {
      for (const { filters, keys } of cases) {
        const result = await query(t, projectId, scope, filters, path);
        expect(ids(result.records)).toEqual(scope === "working" ? [] : keys.map((key) => byGroup.canonical[key]!).sort());
        expect(ids(result.workingRecords)).toEqual(scope === "canonical" ? [] : keys.map((key) => byGroup.working[key]!).sort());
        expect(result.workingRecords.every((row) => row.reviewStatus === "proposed" && row.evidenceBasis === "agent_report")).toBe(true);
        expect(result.completeness.records.mayHaveMore).toBe(false);
        expect(result.completeness.workingRecords.mayHaveMore).toBe(false);
      }
      const result = await query(t, projectId, scope,
        { recordType: "fact", recordedFrom: day, recordedTo: day }, path,
        { includeHistorical: true, match: "phrase" });
      expect(ids(result.records)).toEqual(scope === "working" ? [] : [byGroup.canonical.start!, byGroup.canonical.end!, historical].sort());
      expect(ids(result.workingRecords)).toEqual(scope === "canonical" ? [] : [byGroup.working.start!, byGroup.working.end!].sort());
    }
  });

  it("filters before the bounded candidate window", async () => {
    const { t, projectId, add } = await fixture();
    const wanted: string[] = [];
    t.app.ck.deps.db.transaction(() => {
      for (const reviewStatus of ["accepted", "proposed"]) {
        for (let i = 0; i < 205; i++) {
          // These rank ahead by recency in LIKE/list, and by term frequency in FTS.
          add({ reviewStatus, evidenceBasis: "agent_report", type: "decision", text: "searchfilter beacon searchfilter beacon", recordedAt: "2025-01-01T00:00:00.000Z" });
          add({ reviewStatus, evidenceBasis: "agent_report", text: "searchfilter beacon searchfilter beacon", recordedAt: "2025-01-01T00:00:00.000Z" });
        }
        wanted.push(add({ reviewStatus, evidenceBasis: "agent_report" }));
      }
    });
    if (path === "like") t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
    const result = await query(t, projectId, "all", { recordType: "fact", recordedFrom: day, recordedTo: day }, path, { limit: 1 });
    expect(ids(result.records)).toEqual([wanted[0]]);
    expect(ids(result.workingRecords)).toEqual([wanted[1]]);
    if (path !== "list") {
      expect(result.completeness.records).toEqual({ returned: 1, limit: 1, mayHaveMore: false, candidateLimitReached: false });
      expect(result.completeness.workingRecords).toEqual(result.completeness.records);
    }
  });

  it("keeps the 50/100/150/200 windows and truthful completeness above 200 matches", async () => {
    const { t, projectId, add } = await fixture();
    t.app.ck.deps.db.transaction(() => {
      for (const reviewStatus of ["accepted", "proposed"]) {
        for (let i = 0; i < 205; i++) add({ reviewStatus, evidenceBasis: "agent_report" });
      }
    });
    if (path === "like") t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
    let prior: SearchResultDto | undefined;
    for (const limit of [undefined, 100, 150, 200]) {
      const result = await query(t, projectId, "all", { recordType: "fact", recordedFrom: day, recordedTo: day }, path, { limit });
      for (const bucket of ["records", "workingRecords"] as const) {
        expect(result[bucket]).toHaveLength(limit ?? 50);
        expect(result.completeness[bucket]).toEqual({
          returned: limit ?? 50, limit: limit ?? 50, mayHaveMore: true,
          candidateLimitReached: path !== "list",
        });
        if (prior) expect(result[bucket].slice(0, prior[bucket].length)).toEqual(prior[bucket]);
      }
      prior = result;
    }
    if (path !== "list") {
      // Even internal callers requesting more cannot expand the lexical candidate cap.
      const completeness = { candidateLimitReached: false, mayHaveMore: false };
      expect(retrieveRecordMatches(t.app.ck.deps.db, {
        q: "searchfilter beacon", projectId, type: "fact", recordedFrom: day, recordedTo: day,
        statuses: ["accepted"], limit: 500, hydrateEvidence: false, completeness,
      })).toHaveLength(200);
      expect(completeness).toEqual({ candidateLimitReached: true, mayHaveMore: true });
    }
  });
});

it("omits discovery buckets only when explicit record filters are active", async () => {
  const { t, projectId, add } = await fixture();
  add();
  t.app.ck.deps.db.insert(sources).values({
    id: randomUUID(), projectId, kind: "paste", title: "searchfilter beacon", contentHash: "synthetic-search-source",
    normalizedHash: "synthetic-search-source", importedAt: timestamp, provenanceBasis: "system",
    originalText: "searchfilter beacon", normalizedText: "searchfilter beacon",
  }).run();
  // The project name deliberately matches the same query as the source.
  const base = new URLSearchParams({ q: "searchfilter", projectId, scope: "all" });
  const control = (await t.get(`/api/search?${base}`)).json<SearchResultDto>();
  expect(control.projects).toHaveLength(1);
  expect(control.sources).toHaveLength(1);
  const filtersToCheck: Filters[] = [{ recordType: "fact" }, { recordedFrom: day }, { recordedTo: day }];
  for (const filters of filtersToCheck) {
    const result = (await t.get(`/api/search?${base}&${new URLSearchParams(filters)}`)).json<SearchResultDto>();
    expect(result.records).toHaveLength(1);
    expect(result.projects).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.completeness.projects).toEqual({ returned: 0, limit: 50, mayHaveMore: false, candidateLimitReached: false });
    expect(result.completeness.sources).toEqual({ returned: 0, limit: 20, mayHaveMore: false, candidateLimitReached: false });
    const list = search(t.app.ck.deps, { q: "", projectId, type: filters.recordType, ...filters });
    expect(list.projects).toEqual([]);
    expect(list.sources).toEqual([]);
  }
});

it("compares UTC days across timestamp offsets and the year boundary", async () => {
  const { t, projectId, add } = await fixture();
  const first = add({ recordedAt: "2025-01-01T02:00:00+02:00" });
  const last = add({ recordedAt: "2024-12-31T21:59:59.999-02:00" });
  const before = add({ recordedAt: "2025-01-01T01:59:59.999+02:00" });
  const after = add({ recordedAt: "2024-12-31T22:00:00-02:00" });
  const result = await query(t, projectId, "canonical", { recordedFrom: "2025-01-01", recordedTo: "2025-01-01" }, "fts");
  expect(ids(result.records)).toEqual([first, after].sort());
  const previous = await query(t, projectId, "canonical", { recordedFrom: "2024-12-31", recordedTo: "2024-12-31" }, "fts");
  expect(ids(previous.records)).toEqual([last, before].sort());
});

it("rejects malformed, impossible and reversed HTTP dates, invalid types and limits", async () => {
  const { t } = await fixture();
  const invalidDates = ["", "not-a-date", "2024-2-29", "2024-02-9", "2023-02-29", "1900-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-00-01", "2024-01-00", "2024-02-29T00:00:00Z", " 2024-02-29"];
  for (const field of ["recordedFrom", "recordedTo"]) {
    for (const value of invalidDates) {
      expectStatus(await t.get(`/api/search?${new URLSearchParams({ q: "searchfilter", [field]: value })}`), 400, `${field}=${value}`);
    }
  }
  for (const suffix of ["recordedFrom=2024-03-01&recordedTo=2024-02-29", "recordType=unsupported", "recordType=", "limit=201", "limit=0", "limit=1.5"]) {
    expectStatus(await t.get(`/api/search?q=searchfilter&${suffix}`), 400, suffix);
  }
  for (const date of ["2000-02-29", day, "2024-12-31"]) {
    expectStatus(await t.get(`/api/search?q=searchfilter&recordedFrom=${date}&recordedTo=${date}&limit=200`), 200);
  }
  expectStatus(await t.get("/api/search?q=searchfilter&limit=1"), 200);
  expect(SearchQuery.parse({ q: "searchfilter" })).toEqual({
    q: "searchfilter", mode: "discovery", match: "terms", scope: "canonical",
    projectId: null, includeHistorical: false, limit: 50,
  });
});
