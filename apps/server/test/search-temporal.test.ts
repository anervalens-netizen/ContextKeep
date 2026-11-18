import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpSearchResultDto, SearchResultDto } from "@contextkeep/shared";
import { projects, records } from "../src/db/schema.js";
import {
  buildSearchProfile,
  retrieveRecordMatches,
  search,
} from "../src/services/search.js";
import { searchTemporal } from "../src/services/search-time.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const now = "2026-05-20T00:00:00.000Z";
const old = "2024-01-01T00:00:00.000Z";
const recent = "2026-05-19T00:00:00.000Z";
const apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps.splice(0)) await t.cleanup();
});

const token = randomUUID();
async function fixture() {
  const t = await makeTestApp({ adapters: "manual", mcpToken: token });
  apps.push(t);
  const projectId = randomUUID();
  t.app.ck.deps.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Synthetic timeline",
      createdAt: old,
      updatedAt: old,
    })
    .run();
  const add = (overrides: Partial<typeof records.$inferInsert> = {}) => {
    const id = overrides.id ?? randomUUID();
    t.app.ck.deps.db
      .insert(records)
      .values({
        id,
        projectId,
        type: "fact",
        subject: "Beacon deployment",
        predicate: null,
        text: "Beacon current deployment",
        reviewStatus: "accepted",
        evidenceBasis: "document",
        recordDedupHash: id,
        recordedAt: old,
        sourceEventAt: old,
        createdAt: old,
        updatedAt: old,
        ...overrides,
      })
      .run();
    return id;
  };
  const matches = (q: string, statuses = ["accepted"], limit = 10) =>
    retrieveRecordMatches(t.app.ck.deps.db, {
      q,
      projectId,
      statuses,
      limit,
      nowIso: now,
      temporalRanking: true,
      hydrateEvidence: false,
    });
  return { t, projectId, add, matches };
}

describe("ME-08 temporal policy", () => {
  it.each([
    [
      { sourceEventAt: old, recordedAt: recent },
      "source_event",
      old,
      "dated",
      12,
    ],
    [
      { sourceEventAt: null, effectiveFrom: recent },
      "effective_from",
      recent,
      "dated",
      12,
    ],
    [
      { sourceEventAt: null, recordedAt: recent },
      "unknown",
      null,
      "unknown",
      0,
    ],
    [{ sourceEventAt: "invalid" }, "source_event", null, "invalid", -24],
    [
      { sourceEventAt: "2026-02-30T00:00:00.000Z" },
      "source_event",
      null,
      "invalid",
      -24,
    ],
    [
      { sourceEventAt: "2030-01-01T00:00:00.000Z" },
      "source_event",
      null,
      "future",
      -24,
    ],
    [
      { effectiveFrom: "2030-01-01T00:00:00.000Z" },
      "source_event",
      null,
      "future",
      -24,
    ],
    [{ effectiveTo: now }, "source_event", null, "expired", -24],
    [
      { sourceEventAt: "2026-05-20T00:00:00.000001Z" },
      "source_event",
      null,
      "future",
      -24,
    ],
    [
      { sourceEventAt: "2024-01-01T02:00:00+02:00" },
      "source_event",
      "2024-01-01T02:00:00+02:00",
      "dated",
      12,
    ],
    [
      { effectiveFrom: recent, effectiveTo: old },
      "source_event",
      null,
      "invalid",
      -24,
    ],
    [
      { sourceEventAt: old, effectiveFrom: recent },
      "source_event",
      old,
      "dated",
      12,
    ],
    [{ volatile: 1, reviewDueAt: now }, "source_event", old, "dated", -24],
    [{ volatile: 0, reviewDueAt: old }, "source_event", old, "dated", 12],
  ] as const)(
    "classifies %j",
    async (overrides, basis, rankTime, eligibility, currentAdjustment) => {
      const { t, add } = await fixture();
      const id = add({ ...overrides, reviewedAt: recent });
      const row = t.app.ck.deps.db
        .select()
        .from(records)
        .all()
        .find((r) => r.id === id)!;
      expect(searchTemporal(row, now)).toEqual({
        basis,
        rankTime,
        eligibility,
        currentAdjustment,
      });
    },
  );

  it.each([
    "what is currently deployed",
    "ce rulează acum",
    "care este versiunea actuală",
    "în prezent",
  ])("recognizes current intent %s", (q) => {
    expect(buildSearchProfile(q).currentIntent).toBe(true);
  });
  it.each([
    "previous deployment",
    "historical deployment",
    "ce era înainte",
    "istoric",
    "runtime anterior",
    "what was deployed before",
    "ce era instalat",
  ])("recognizes historical intent %s", (q) => {
    expect(buildSearchProfile(q).historicalIntent).toBe(true);
  });
});

describe("ME-06 bounded retrieval and authority", () => {
  it("interprets past deployment questions as historical while preserving the explicit history toggle", async () => {
    const { t, projectId, add } = await fixture();
    add();
    const oldId = add({ reviewStatus: "superseded" });
    for (const q of [
      "what was Beacon deployed before",
      "ce era Beacon deployment",
    ]) {
      expect(buildSearchProfile(q)).toMatchObject({
        currentIntent: false,
        historicalIntent: true,
      });
      expect(
        search(t.app.ck.deps, { q, projectId, includeHistorical: true })
          .records[0]?.id,
      ).toBe(oldId);
      expect(
        search(t.app.ck.deps, { q, projectId }).records.some(
          (row) => row.id === oldId,
        ),
      ).toBe(false);
    }
  });

  it("does not erase a valid event time because reviewDueAt is malformed", async () => {
    const { t, add } = await fixture();
    const id = add({
      sourceEventAt: recent, reviewDueAt: "not-a-valid-review-date", volatile: 0,
    });
    const row = t.app.ck.deps.db.select().from(records).all().find((r) => r.id === id)!;
    expect(searchTemporal(row, now)).toMatchObject({
      basis: "source_event", eligibility: "dated",
      rankTime: recent, currentAdjustment: 12,
    });
  });

  it("marks malformed volatile review schedules as requiring verification while preserving valid event time", async () => {
    const { t, projectId, add } = await fixture();
    const id = add({
      sourceEventAt: recent, volatile: 1,
      reviewDueAt: "not-a-valid-review-date",
      text: "Beacon current deployment",
    });
    const result = search(t.app.ck.deps, {
      q: "Beacon current deployment", projectId, limit: 5,
    });
    const item = result.records.find((r) => r.id === id);
    expect(item?.temporal).toMatchObject({
      eligibility: "dated", rankTime: recent, currentAdjustment: -24,
    });
    expect(item?.freshness).toMatchObject({
      currentness: "review_due", requiresReview: true,
    });
  });

  it("does not score partial textual identifiers as exact identity matches", async () => {
    const { t, projectId, add } = await fixture();
    const valid = add({text: "Beacon current deployment PR35"});
    const partial = add({text: "Beacon current deployment PR350"});
    const matches = retrieveRecordMatches(t.app.ck.deps.db, {
      q: "Beacon current deployment PR35", projectId,
      statuses: ["accepted"], limit: 10, temporalRanking: true,
      hydrateEvidence: false,
    });
    expect(matches.find((m) => m.row.id === valid)?.exactIdentifier).toBe(true);
    expect(matches.find((m) => m.row.id === partial)?.exactIdentifier).toBe(false);
    expect(matches[0]?.row.id).toBe(valid);
  });

  it("ranks valid current operational evidence above lexically stronger future evidence", async () => {
    const { t, projectId, add } = await fixture();
    const valid = add({
      predicate: "status", subject: "Beacon valid deployment",
      sourceEventAt: recent, text: "Beacon current deployment",
    });
    const future = add({
      predicate: "status", subject: "Beacon future deployment",
      sourceEventAt: "2099-01-01T00:00:00.000Z",
      text: "Beacon current deployment runtime status",
    });
    const result = search(t.app.ck.deps, {
      q: "Beacon current deployment runtime status", projectId, limit: 1,
    });
    expect(result.records[0]?.id).toBe(valid);
    expect(result.records[0]?.temporal?.eligibility).toBe("dated");
    // The future evidence remains recoverable when a wider window is selected.
    const widened = search(t.app.ck.deps, {
      q: "Beacon current deployment runtime status", projectId, limit: 5,
    });
    expect(widened.records.some((row) => row.id === future)).toBe(true);
    expect(widened.records.find((row) => row.id === future)?.temporal?.eligibility).toBe("future");
  });

  it("preserves both temporal intents for current-and-previous questions", () => {
    const profile = buildSearchProfile("what was the previous runtime and what is current");
    expect(profile.currentIntent).toBe(true);
    expect(profile.historicalIntent).toBe(true);
  });

  it("ranks events ahead of late imports, missing metadata and future events with stable ties", async () => {
    const { add, matches } = await fixture();
    const current = add({
      id: "00000000-0000-4000-8000-000000000001",
      sourceEventAt: recent,
    });
    const tie = add({
      id: "00000000-0000-4000-8000-000000000002",
      sourceEventAt: recent,
      recordedAt: recent,
    });
    const imported = add({ recordedAt: recent, reviewedAt: recent });
    const unknown = add({ sourceEventAt: null, recordedAt: recent });
    const future = add({ sourceEventAt: "2099-01-01T00:00:00.000Z" });
    const invalid = add({ sourceEventAt: "bad-date" });
    const expired = add({ sourceEventAt: recent, effectiveTo: now });
    for (const query of ["Beacon currently deployed", "Beacon curent"]) {
      const ids = matches(query).map((m) => m.row.id);
      expect(ids.slice(0, 2)).toEqual([current, tie]);
      expect(ids.indexOf(imported)).toBeLessThan(ids.indexOf(unknown));
      for (const id of [future, invalid, expired])
        expect(ids.indexOf(current)).toBeLessThan(ids.indexOf(id));
    }
  });

  it("preserves scope, historical toggle, constraints, provenance and business state on reads", async () => {
    const { t, projectId, add } = await fixture();
    const accepted = add();
    const constraint = add({
      type: "constraint",
      predicate: null,
      text: "Beacon deployment must retain recovery evidence",
      sourceEventAt: null,
    });
    const historical = add({ reviewStatus: "superseded" });
    const proposed = add({
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      sourceEventAt: recent,
    });
    add({
      reviewStatus: "proposed",
      evidenceBasis: "document",
      sourceEventAt: recent,
    });
    const snapshot = () =>
      t.app.ck.deps.sqlite.prepare("SELECT * FROM records ORDER BY id").all();
    const before = snapshot();
    const changes = t.app.ck.deps.sqlite
      .prepare("SELECT total_changes() AS n")
      .get();
    const query = (
      scope: "canonical" | "working" | "all",
      includeHistorical = false,
      q = "Beacon current deployment",
    ) =>
      SearchResultDto.parse(
        search(t.app.ck.deps, { q, projectId, scope, includeHistorical }),
      );
    const canonical = query("canonical");
    expect(canonical.records.map((r) => r.id)).toEqual(
      expect.arrayContaining([accepted, constraint]),
    );
    expect(canonical.workingRecords).toEqual([]);
    const working = query("working");
    expect(working.records).toEqual([]);
    expect(working.workingRecords.map((r) => r.id)).toEqual([proposed]);
    const all = query("all");
    expect(all.records.map((r) => r.id)).toEqual(
      canonical.records.map((r) => r.id),
    );
    expect(all.workingRecords[0]).toMatchObject({
      id: proposed,
      reviewStatus: "proposed",
      freshness: { authority: "working", currentness: "unknown" },
    });
    expect(all.records.find((r) => r.id === accepted)?.freshness).toMatchObject(
      { currentness: "needs_verification" },
    );
    for (const q of [
      "Beacon historical deployment",
      "Beacon deployment anterior",
    ]) {
      expect(query("canonical", true, q).records[0]?.id).toBe(historical);
      expect(
        query("canonical", false, q).records.some((r) => r.id === historical),
      ).toBe(false);
    }
    expect(snapshot()).toEqual(before);
    expect(
      t.app.ck.deps.sqlite.prepare("SELECT total_changes() AS n").get(),
    ).toEqual(changes);
    expect(all.ranking?.policy).toBe("bounded-temporal-v1");
  });

  it.each([false, true])(
    "recovers dated proposals and exact identifiers under saturation (LIKE %s)",
    async (like) => {
      const { t, projectId, add } = await fixture();
      t.app.ck.deps.db.transaction(() => {
        for (let i = 0; i < 205; i++)
          add({
            reviewStatus: "proposed",
            evidenceBasis: "agent_report",
            text: "Beacon current deployment Beacon current deployment",
            recordedAt: recent,
          });
      });
      const wanted = add({
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
        sourceEventAt: recent,
      });
      const exact = add({
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
        text: "Beacon deployment revision abc1234",
        sourceEventAt: old,
      });
      if (like) t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
      const query = (q: string, limit = 1) =>
        search(t.app.ck.deps, { q, projectId, scope: "working", limit });
      expect(query("Beacon current deployment").workingRecords[0]?.id).toBe(
        wanted,
      );
      // Unchanged internal callers keep their existing lexical policy.
      expect(
        retrieveRecordMatches(t.app.ck.deps.db, {
          q: "Beacon current deployment",
          projectId,
          statuses: ["proposed"],
          limit: 1,
          hydrateEvidence: false,
        }).map((row) => row.row.id),
      ).not.toContain(wanted);
      expect(
        query("Beacon currently deployed abc1234").workingRecords[0]?.id,
      ).toBe(exact);
      expect(
        query("Beacon current deployment").completeness.workingRecords,
      ).toEqual({
        returned: 1,
        limit: 1,
        mayHaveMore: true,
        candidateLimitReached: true,
      });
      expect(
        query("Beacon current deployment", 200).workingRecords,
      ).toHaveLength(200);
      expect(
        query("unmatchedsyntheticword").completeness.workingRecords,
      ).toEqual({
        returned: 0,
        limit: 1,
        mayHaveMore: false,
        candidateLimitReached: false,
      });
    },
  );

  it("exposes invalid and future accepted observations as uncertain, without changing their authority", async () => {
    const { t, projectId, add } = await fixture();
    const future = add({ sourceEventAt: "2099-01-01T00:00:00.000Z" });
    const invalid = add({ sourceEventAt: "not-a-date" });
    const result = search(t.app.ck.deps, { q: "Beacon current", projectId });
    for (const id of [future, invalid]) {
      expect(result.records.find((row) => row.id === id)).toMatchObject({
        reviewStatus: "accepted",
        freshness: { currentness: "unknown", requiresReview: true },
      });
    }
  });

  it("finds the newest matching observation beyond 400 stronger lexical matches", async () => {
    const { t, projectId, add, matches } = await fixture();
    const wanted = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    t.app.ck.deps.sqlite.transaction(() => {
      for (let i = 0; i < 640; i++) {
        add({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          text: "Beacon current deployment ".repeat(8),
          recordedAt: recent,
        });
      }
      add({
        id: wanted,
        sourceEventAt: recent,
        text: "Beacon current deployment" + " background".repeat(64),
      });
      add({
        sourceEventAt: "2099-01-01T00:00:00.000Z",
        text: "Beacon current deployment",
      });
    })();
    expect(
      matches("Beacon current deployment", ["accepted"], 200)[0]?.row.id,
    ).toBe(wanted);
    // The legacy LIKE path has no temporal index. It exposes the same bound
    // and does not claim completeness when it misses this very same record.
    t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
    const fallback = search(t.app.ck.deps, {
      q: "Beacon current deployment",
      projectId,
      mode: "canonical",
      limit: 200,
    });
    expect(fallback.records.map((record) => record.id)).not.toContain(wanted);
    expect(fallback.completeness.records).toMatchObject({
      candidateLimitReached: true,
      mayHaveMore: true,
    });
  });

  it("does not report saturation when the full lexical lane covers a smaller temporal lane", async () => {
    const { t, projectId, add } = await fixture();
    for (let i = 0; i < 25; i++) add();
    const result = search(t.app.ck.deps, {
      q: "Beacon current",
      projectId,
      limit: 30,
    });
    expect(result.records).toHaveLength(25);
    expect(result.completeness.records).toMatchObject({
      mayHaveMore: false,
      candidateLimitReached: false,
    });
  });

  it.each([
    [false, "2026-02-30T00:00:00.000Z"],
    [false, "2026-05-20T10:00Z"],
    [false, "2024-01-01T24:00:00Z"],
    [true, "2026-02-30T00:00:00.000Z"],
    [true, "2026-05-20T10:00Z"],
    [true, "2024-01-01T24:00:00Z"],
    [false, "2099-01-01T00:00:00.000Z"],
    [true, "2099-01-01T00:00:00.000Z"],
  ] as const)(
    "rejects invalid/future temporal lane decoys (LIKE %s, event %s)",
    async (like, sourceEventAt) => {
      const { t, projectId, add } = await fixture();
      t.app.ck.deps.db.transaction(() => {
        for (let i = 0; i < 205; i++)
          add({
            sourceEventAt,
            text: "Beacon current deployment Beacon current deployment",
          });
      });
      const wanted = add();
      if (like) t.app.ck.deps.sqlite.exec("DELETE FROM ck_records_fts");
      const result = search(t.app.ck.deps, {
        q: "Beacon current deployment",
        projectId,
        limit: 1,
      });
      expect(result.records[0]?.id).toBe(wanted);
      expect(result.completeness.records).toMatchObject({
        candidateLimitReached: true,
        mayHaveMore: true,
      });
    },
  );

  it("does not grant exact-identifier relevance from an unrelated record ID substring", async () => {
    const { t, projectId, add } = await fixture();
    const relevant = add({
      subject: "Beacon deployment",
      text: "Beacon current deployment k9x2m1",
      sourceEventAt: recent,
    });
    const falsePositive = add({
      id: "33333333-3333-4333-8333-k9x2m1ab",
      subject: "Synthetic unrelated noise",
      text: "current",
      sourceEventAt: recent,
    });
    const matches = search(t.app.ck.deps, {
      q: "Beacon current deployment k9x2m1", projectId, limit: 10,
    });
    expect(matches.records.map((row) => row.id)).toContain(relevant);
    expect(matches.records.map((row) => row.id)).not.toContain(falsePositive);
  });

  it("finds a literal record UUID in phrase mode without admitting unrelated phrase matches", async () => {
    const { t, projectId, add } = await fixture();
    const id = add({ text: "Unrelated stored description", subject: "Synthetic phrase ID" });
    add({ text: "Beacon current deployment", subject: "Other fixture" });
    const literal = search(t.app.ck.deps, {
      q: id, match: "phrase", projectId, limit: 1,
    });
    expect(literal.records.map((row) => row.id)).toEqual([id]);
    const extended = search(t.app.ck.deps, {
      q: id + " unrelated", match: "phrase", projectId, limit: 1,
    });
    expect(extended.records.some((row) => row.id === id)).toBe(false);
  });

  it("gives exact record IDs priority even when FTS has other matches and respects project scope", async () => {
    const { t, projectId, add } = await fixture();
    const exact = add({ text: "Unrelated stored description" });
    add({
      text: `Beacon current deployment mentions ${exact}`,
      sourceEventAt: recent,
    });
    for (let i = 0; i < 50; i++)
      add({ text: "Beacon current deployment", sourceEventAt: recent });
    const result = search(t.app.ck.deps, {
      q: `Beacon current ${exact}`,
      projectId,
      limit: 1,
    });
    expect(result.records[0]?.id).toBe(exact);
    expect(
      search(t.app.ck.deps, { q: exact, projectId: randomUUID() }).records,
    ).toEqual([]);
  });

  it("preserves superseded rows under historical candidate saturation", async () => {
    const { add, matches } = await fixture();
    for (let i = 0; i < 205; i++)
      add({
        text: "Beacon historical deployment Beacon historical deployment",
      });
    const historical = add({
      text: "Beacon deployment",
      reviewStatus: "superseded",
    });
    for (const q of [
      "Beacon historical deployment",
      "Beacon deployment anterior",
    ]) {
      expect(matches(q, ["accepted", "superseded"], 1)[0]?.row.id).toBe(
        historical,
      );
    }
  });

  it("returns real MCP temporal metadata with null observation time in compatibility and compact responses", async () => {
    const { t, projectId, add } = await fixture();
    const id = add({
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      sourceEventAt: null,
      effectiveFrom: old,
      recordedAt: recent,
    });
    for (const compact of [false, true]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
        },
        payload: {
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: {
            name: "search_context",
            arguments: {
              q: "Beacon current",
              projectId,
              scope: "all",
              compact,
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.isError).not.toBe(true);
      const parsed = McpSearchResultDto.parse(result.structuredContent);
      expect(parsed.workingRecords[0]).toMatchObject({
        recordId: id,
        observedAt: null,
        sourceEventAt: null,
        recordedAt: recent,
        effectiveFrom: old,
        temporal: { basis: "effective_from", eligibility: "dated" },
      });
      expect(parsed.ranking?.intent).toBe("current");
      expect(parsed.records).toEqual([]);
      expect("canonicalRecords" in parsed).toBe(!compact);
    }
  });

  it("keeps MCP temporal fields and ranking contract through schema parsing", () => {
    const parsed = McpSearchResultDto.parse({
      query: "Beacon current",
      scope: "working",
      compact: true,
      records: [],
      workingRecords: [
        {
          recordId: "00000000-0000-4000-8000-000000000001",
          projectId: null,
          subject: "Beacon",
          text: "deployment",
          type: "fact",
          reviewStatus: "proposed",
          status: "proposed",
          provenance: "agent_report",
          recordedAt: recent,
          observedAt: null,
          sourceEventAt: null,
          effectiveFrom: old,
          effectiveTo: null,
          stale: false,
          requiresReview: true,
          temporal: {
            basis: "effective_from",
            rankTime: old,
            eligibility: "dated",
            currentAdjustment: 12,
          },
        },
      ],
      ranking: {
        policy: "bounded-temporal-v1",
        intent: "current",
        notes: ["synthetic explanation"],
      },
      completeness: Object.fromEntries(
        ["records", "workingRecords", "projects", "sources"].map((key) => [
          key,
          {
            returned: key === "workingRecords" ? 1 : 0,
            limit: 10,
            mayHaveMore: false,
            candidateLimitReached: false,
          },
        ]),
      ),
    });
    expect(parsed.workingRecords[0]?.observedAt).toBeNull();
    expect(parsed.ranking?.intent).toBe("current");
  });
});
