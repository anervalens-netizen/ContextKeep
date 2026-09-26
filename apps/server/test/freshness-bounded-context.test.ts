import { afterEach, describe, expect, it, vi } from "vitest";
import { records, conflicts } from "../src/db/schema.js";
import {
  loadRecordFreshnessContext,
  toRecordDto,
} from "../src/services/mappers.js";
import {
  classifyRecordFreshness,
  type FreshnessRecord,
} from "../src/services/memory-freshness.js";
import { makeTestApp, type TestApp } from "./helpers.js";

type Row = typeof records.$inferSelect;
const apps: TestApp[] = [];
const now = "2026-05-01T00:00:00.000Z";
function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});
async function fixture() {
  const t = await makeTestApp({ adapters: "manual" });
  apps.push(t);
  const response = await t.post("/api/projects", {
    name: "Synthetic bounded freshness",
  });
  expect(response.statusCode).toBe(200);
  const projectId = response.json<{ id: string }>().id;
  function row(n: number, overrides: Partial<Row> = {}): Row {
    return {
      id: id(n),
      projectId,
      type: "fact",
      subject: "api-gateway",
      predicate: "status",
      valueJson: null,
      text: `Synthetic api-gateway observation ${n}`,
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      taskStatus: null,
      recordDedupHash: `synthetic-${n}`,
      recordedAt: "2026-03-01T00:00:00.000Z",
      sourceEventAt: "2026-02-01T00:00:00.000Z",
      effectiveFrom: null,
      effectiveTo: null,
      reviewedAt: null,
      reviewDueAt: null,
      volatile: 0,
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }
  const canonical = row(9000, {
    reviewStatus: "accepted",
    evidenceBasis: "document",
    sourceEventAt: "2026-01-01T00:00:00.000Z",
  });
  return { t, projectId, row, canonical };
}
function insert(t: TestApp, rows: Row[]) {
  t.app.ck.deps.db.transaction((tx) => {
    for (const row of rows) tx.insert(records).values(row).run();
  });
}

describe("bounded freshness preloads preserve complete evidence semantics", () => {
  it("counts all observations beyond the sample and retains bounded bodies and reference IDs", async () => {
    const { t, row, canonical } = await fixture();
    // Weak capture-time observations intentionally precede the strong evidence
    // in keyset order, so a first-page cap would produce the wrong verdict.
    const weak = Array.from({ length: 150 }, (_, i) =>
      row(i + 1, { sourceEventAt: null }),
    );
    const unrelated = Array.from({ length: 150 }, (_, i) =>
      row(i + 201, { subject: `separate-${i}`, text: `separate-${i} healthy` }),
    );
    const strong = Array.from({ length: 150 }, (_, i) => row(i + 501));
    insert(t, [canonical, ...weak, ...unrelated, ...strong]);
    const reads = vi.spyOn(t.app.ck.deps.db, "all");
    const bounded = loadRecordFreshnessContext(
      t.app.ck.deps.db,
      [canonical],
      now,
    );
    expect(reads.mock.results.length).toBeGreaterThanOrEqual(4);
    for (const result of reads.mock.results)
      if (result.type === "return")
        expect(result.value.length).toBeLessThanOrEqual(128);
    reads.mockRestore();
    expect(bounded.workingRecords!.length).toBeLessThanOrEqual(128);
    expect(bounded.conflicts).toEqual([]);
    const dto = toRecordDto(canonical, [], bounded).freshness!;
    expect(dto).toMatchObject({
      currentness: "needs_verification",
      stale: true,
      reasons: ["newer_observation"],
      referenceSummary: {
        supportCount: 150,
        possiblyRelatedCount: 150,
        supportReferencesTruncated: true,
        possiblyRelatedReferencesTruncated: true,
      },
    });
    expect(dto.supportRecordIds).toEqual(strong.slice(0, 20).map((r) => r.id));
    expect(dto.possiblyRelatedRecordIds).toEqual(
      weak.slice(0, 20).map((r) => r.id),
    );
    const full = classifyRecordFreshness(canonical, {
      nowIso: now,
      workingRecords: [...weak, ...unrelated, ...strong],
    });
    expect(dto.currentness).toBe(full.currentness);
    expect(dto.stale).toBe(full.stale);
    expect(dto.requiresReview).toBe(full.requiresReview);
    expect(dto.referenceSummary!.supportCount).toBe(
      full.supportRecordIds.length,
    );
    expect(dto.referenceSummary!.possiblyRelatedCount).toBe(
      full.possiblyRelatedRecordIds.length,
    );
    const transactional = t.app.ck.deps.db.transaction((tx) =>
      loadRecordFreshnessContext(tx, [canonical], now),
    );
    expect(toRecordDto(canonical, [], transactional).freshness).toEqual(dto);
  });

  it("deduplicates conflict references, retains self-only conflicts and covers non-state accepted records", async () => {
    const { t, row, projectId, canonical } = await fixture();
    const self = row(9001, {
      subject: "self-service",
      reviewStatus: "accepted",
      evidenceBasis: "document",
    });
    const nonState = row(9002, {
      subject: "design-choice",
      type: "decision",
      predicate: null,
      reviewStatus: "accepted",
      evidenceBasis: "document",
    });
    const future = row(9003, {
      subject: "future-service",
      reviewStatus: "accepted",
      evidenceBasis: "document",
      effectiveFrom: "2027-01-01T00:00:00.000Z",
    });
    const expired = row(9004, {
      subject: "expired-service",
      reviewStatus: "accepted",
      evidenceBasis: "document",
      effectiveTo: "2026-04-01T00:00:00.000Z",
    });
    const peers = Array.from({ length: 150 }, (_, i) => row(i + 1));
    insert(t, [canonical, self, nonState, future, expired, ...peers]);
    const conflictRows = [
      ...peers.flatMap((peer, i) =>
        [0, 1].map((copy) => ({
          id: `synthetic-${i}-${copy}`,
          recordIds: [canonical.id, peer.id, peer.id],
        })),
      ),
      { id: "synthetic-self", recordIds: [self.id] },
      { id: "synthetic-non-state", recordIds: [nonState.id, peers[0]!.id] },
      { id: "synthetic-future", recordIds: [future.id, peers[0]!.id] },
      { id: "synthetic-expired", recordIds: [expired.id, peers[0]!.id] },
    ];
    t.app.ck.deps.db.transaction((tx) => {
      for (const c of conflictRows)
        tx.insert(conflicts)
          .values({
            id: c.id,
            projectId,
            recordIdsJson: JSON.stringify(c.recordIds),
            status: "unresolved",
            resolutionRecordId: null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
    });
    const rows = [canonical, self, nonState, future, expired];
    const ctx = loadRecordFreshnessContext(t.app.ck.deps.db, rows, now);
    expect(ctx.conflicts).toEqual([]);
    const result = toRecordDto(canonical, [], ctx).freshness!;
    expect(result).toMatchObject({
      currentness: "conflicted",
      stale: true,
      reasons: ["explicit_conflict"],
      referenceSummary: { supportCount: 150, supportReferencesTruncated: true },
    });
    expect(result.supportRecordIds).toEqual(
      peers.slice(0, 20).map((p) => p.id),
    );
    for (const [record, expected] of [
      [self, "conflicted"],
      [nonState, "conflicted"],
      [future, "future_effective"],
      [expired, "expired"],
    ] as const) {
      const bounded = toRecordDto(record, [], ctx).freshness!;
      expect(bounded.currentness).toBe(expected);
      const full = classifyRecordFreshness(record as FreshnessRecord, {
        nowIso: now,
        workingRecords: peers,
        conflicts: conflictRows,
      });
      expect(bounded.currentness).toBe(full.currentness);
      expect(bounded.stale).toBe(full.stale);
    }
    expect(toRecordDto(self, [], ctx).freshness!.supportRecordIds).toEqual([]);
    expect(toRecordDto(nonState, [], ctx).freshness!.supportRecordIds).toEqual([
      peers[0]!.id,
    ]);
  });

  it("keeps complete small-result DTOs unchanged and does not mistake capture recency for stale truth", async () => {
    const { t, row, canonical } = await fixture();
    const weak = row(1, { sourceEventAt: null });
    insert(t, [canonical, weak]);
    const ctx = loadRecordFreshnessContext(t.app.ck.deps.db, [canonical], now);
    const full = classifyRecordFreshness(canonical, {
      nowIso: now,
      workingRecords: [weak],
    });
    const result = toRecordDto(canonical, [], ctx).freshness!;
    expect(result).toEqual(full);
    expect(result.stale).toBe(false);
    expect(result.requiresReview).toBe(true);
    expect(result.referenceSummary).toBeUndefined();
  });
});
