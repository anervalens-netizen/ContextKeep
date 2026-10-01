import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { records, projects, conflicts } from "../src/db/schema.js";
import { openDatabase } from "../src/db/client.js";
import * as freshnessModule from "../src/services/memory-freshness.js";
import {
  loadRecordFreshnessContext,
  toRecordDto,
} from "../src/services/mappers.js";
import {
  classifyRecordFreshness,
  prepareState,
  preparedStateRelationship,
  stateRelationship,
} from "../src/services/memory-freshness.js";
import { readBrief } from "../src/mcp/reads.js";
import { ContextKeepMemoryService } from "../src/services/memory-context.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const NOW = "2026-05-01T00:00:00.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const AFTER = "2026-02-01T00:00:00.000Z";
type Row = typeof records.$inferSelect;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
});
async function fixture() {
  const t = await makeTestApp({ adapters: "manual" });
  apps.push(t);
  const projectId = (
    await t.post("/api/projects", { name: "Synthetic freshness fixture" })
  ).json<{ id: string }>().id;
  const row = (n: number, patch: Partial<Row> = {}): Row => ({
    id: id(n),
    projectId,
    type: "fact",
    subject: "example-gateway",
    predicate: "status",
    valueJson: null,
    text: "Synthetic gateway healthy",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: null,
    recordDedupHash: `synthetic-${n}`,
    recordedAt: AFTER,
    sourceEventAt: AFTER,
    effectiveFrom: null,
    effectiveTo: null,
    reviewedAt: null,
    reviewDueAt: null,
    volatile: 0,
    revision: 1,
    createdAt: BEFORE,
    updatedAt: BEFORE,
    ...patch,
  });
  const canonical = row(1, {
    reviewStatus: "accepted",
    evidenceBasis: "document",
    sourceEventAt: BEFORE,
  });
  const insert = (rows: Row[]) =>
    t.app.ck.deps.db.transaction((tx) => {
      for (const record of rows)
        tx.insert(records)
          .values({ ...record, recordDedupHash: `synthetic-${record.id}` })
          .run();
    });
  const bump = (
    project = projectId,
    kind: "contentVersion" | "workingMemoryVersion" = "workingMemoryVersion",
  ) => {
    t.app.ck.deps.db
      .update(projects)
      .set({ [kind]: sql`${projects[kind]} + 1` })
      .where(eq(projects.id, project))
      .run();
  };
  const freshness = (record = canonical, at = NOW) =>
    toRecordDto(
      record,
      [],
      loadRecordFreshnessContext(t.app.ck.deps.db, [record], at),
    ).freshness!;
  return { t, projectId, row, canonical, insert, bump, freshness };
}

/** Count actual executed statements and returned rows, including native streams. */
function measureSql(t: TestApp) {
  const stats = { calls: 0, rows: 0, proposalScans: 0, proposalRows: 0 };
  const sqlite = t.app.ck.deps.sqlite;
  const prepare = sqlite.prepare.bind(sqlite);
  const spy = vi
    .spyOn(sqlite, "prepare")
    .mockImplementation((query: string) => {
      const statement = prepare(query);
      const proposalScan =
        /SELECT id, project_id AS projectId/.test(query) &&
        /evidence_basis = 'agent_report'/.test(query);
      for (const method of ["all", "get", "iterate"] as const) {
        const original = statement[method].bind(statement);
        // Instrument the native methods, so Drizzle's .raw() still uses counters.
        (statement[method] as unknown) = (...args: unknown[]) => {
          stats.calls++;
          if (proposalScan) stats.proposalScans++;
          const value = original(...args);
          const count = (n: number) => {
            stats.rows += n;
            if (proposalScan) stats.proposalRows += n;
          };
          if (method === "iterate")
            return (function* () {
              for (const row of value as Iterable<unknown>) {
                count(1);
                yield row;
              }
            })();
          count(
            method === "all"
              ? (value as unknown[]).length
              : value === undefined
                ? 0
                : 1,
          );
          return value;
        };
      }
      return statement;
    });
  return {
    stats,
    reset: () => {
      for (const key of Object.keys(stats) as Array<keyof typeof stats>)
        stats[key] = 0;
    },
    stop: () => spy.mockRestore(),
  };
}

describe("versioned freshness evidence", () => {
  it("unions duplicate-ID projections deterministically across hits, misses, order and repeats", async () => {
    const f = await fixture();
    const a = { ...f.canonical, subject: "alpha", text: "alpha" };
    const b = { ...a, subject: "beta", text: "beta" };
    const working = Array.from({ length: 27 }, (_, i) =>
      f.row(100 + i, {
        subject: "alpha",
        text: "alpha",
        sourceEventAt: i < 23 ? AFTER : null,
      }),
    );
    f.insert([a, ...working.toReversed()]);
    const check = (projections: Row[]) => {
      const reference = projections.map((row) =>
        classifyRecordFreshness(row, {
          nowIso: NOW,
          workingRecords: working,
        }),
      );
      const strong = reference.flatMap((r) => r.supportRecordIds);
      const weak = reference.flatMap((r) => r.possiblyRelatedRecordIds);
      const ctx = loadRecordFreshnessContext(
        f.t.app.ck.deps.db,
        projections,
        NOW,
      );
      const signal = ctx.preloadedSignals!.get(a.id)!;
      expect(signal).toMatchObject({
        supportCount: strong.length,
        possiblyRelatedCount: weak.length,
        supportRecordIds: [...new Set(strong)].sort().slice(0, 20),
        possiblyRelatedRecordIds: [...new Set(weak)].sort().slice(0, 20),
        supportReferencesTruncated: strong.length > 20,
        possiblyRelatedReferencesTruncated: weak.length > 20,
      });
      for (const row of projections)
        expect(toRecordDto(row, [], ctx).freshness).toMatchObject({
          currentness: "needs_verification",
          stale: true,
        });
    };
    // Reproduce the hit B / miss A ordering that used to change on warm reads.
    expect(f.freshness(b).currentness).toBe("current");
    for (const projections of [
      [a, b],
      [a, b],
      [b, a],
      [a, a, b],
      [b, a, a],
    ])
      check(projections);
    f.bump();
    expect(f.freshness(a).stale).toBe(true);
    for (const projections of [
      [b, a],
      [a, b],
      [a, b],
    ])
      check(projections);
    f.bump();
    check([a, a, b]); // all misses, including identical duplicate projections
    check([a, a, b]);
    expect(f.freshness(b).currentness).toBe("current");
  });

  it.each(["sourceEventAt", "effectiveFrom", "recordedAt"] as const)(
    "keeps fractional %s precision on cold, warm and transaction reads",
    async (basis) => {
      const f = await fixture();
      const times = [
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00.000Z",
        "2026-02-01T00:00:00.000000001Z",
        "2026-02-01T00:00:00.1Z",
        "2026-02-01T00:00:00.1000Z",
        "2026-02-01T00:00:00.100000001Z",
        "2026-02-01T02:00:00.100000001+02:00",
      ];
      const timeFields = (at: string) => ({
        sourceEventAt: null,
        effectiveFrom: null,
        recordedAt: BEFORE,
        [basis]: at,
      });
      const working = times.map((at, i) => f.row(100 + i, timeFields(at)));
      f.insert(working.toReversed());
      const counts = [5, 5, 4, 2, 2, 0, 0];
      for (const [i, at] of times.entries()) {
        const canonical = { ...f.canonical, ...timeFields(at) };
        const full = classifyRecordFreshness(canonical, {
          nowIso: NOW,
          workingRecords: working,
        });
        expect(
          basis === "recordedAt"
            ? full.possiblyRelatedRecordIds
            : full.supportRecordIds,
        ).toHaveLength(counts[i]!);
        for (let repeat = 0; repeat < 2; repeat++)
          expect(f.freshness(canonical)).toEqual(full);
        const ctx = f.t.app.ck.deps.db.transaction((tx) =>
          loadRecordFreshnessContext(tx, [canonical], NOW),
        );
        expect(toRecordDto(canonical, [], ctx).freshness).toEqual(full);
        expect(toRecordDto(canonical, [], ctx)[basis]).toBe(at);
      }
    },
  );

  it("rechecks submillisecond canonical boundaries on warm reads without rewriting values", async () => {
    const f = await fixture();
    const canonical = {
      ...f.canonical,
      volatile: 1,
      effectiveFrom: "2026-05-01T00:00:00.000000001Z",
      reviewDueAt: "2026-05-01T00:00:00.100Z",
      effectiveTo: "2026-05-01T01:00:00.100000001+01:00",
    };
    for (const [at, currentness] of [
      ["2026-05-01T00:00:00Z", "future_effective"],
      ["2026-05-01T00:00:00.0000000010Z", "current"],
      ["2026-05-01T00:00:00.099999999Z", "current"],
      ["2026-05-01T00:00:00.1Z", "review_due"],
      ["2026-05-01T00:00:00.1000000010Z", "expired"],
      ["2026-05-01T00:00:00Z", "future_effective"],
    ]) {
      const expected = classifyRecordFreshness(canonical, { nowIso: at! });
      expect(expected.currentness).toBe(currentness);
      expect(f.freshness(canonical, at)).toEqual(expected);
    }
  });

  it("avoids preparing incompatible predicates and older bodies, rescanning uncovered projections", async () => {
    const f = await fixture();
    const working = [
      f.row(2, { predicate: "deployment" }),
      f.row(3, { sourceEventAt: BEFORE }),
      f.row(4, { predicate: null, volatile: 1 }),
    ];
    f.insert(working);
    const prepare = vi.spyOn(freshnessModule, "prepareState");
    const measure = measureSql(f.t);
    for (let write = 0; write < 3; write++) {
      f.bump();
      prepare.mockClear();
      expect(f.freshness().supportRecordIds).toEqual([id(4)]);
      expect(prepare.mock.calls.map(([row]) => row)).toEqual([
        f.canonical,
        expect.objectContaining({ id: id(4) }),
      ]);
    }
    const projections = [
      { ...f.canonical, predicate: "DEPLOYMÉNT" },
      { ...f.canonical, sourceEventAt: "2025-12-01T00:00:00Z" },
      { ...f.canonical, predicate: null, volatile: 1 },
    ];
    for (const canonical of projections) {
      measure.reset();
      const expected = classifyRecordFreshness(canonical, {
        nowIso: NOW,
        workingRecords: working,
      });
      expect(f.freshness(canonical)).toEqual(expected);
      expect(measure.stats.proposalScans).toBe(1);
      measure.reset();
      expect(f.freshness(canonical)).toEqual(expected);
      expect(measure.stats.proposalScans).toBe(0);
    }
    measure.stop();
  });

  it("preserves Unicode, predicate, state-dimension, identifier and weak-text relationships", async () => {
    const f = await fixture();
    const examples = [
      {
        a: { subject: "Știință 東京", text: "ready" },
        b: { subject: "Stiinta 東京", text: "different" },
        expected: "same_entity",
      },
      {
        a: { subject: "x", text: "alpha" },
        b: { subject: "X", text: "beta" },
        expected: "same_entity",
      },
      {
        a: { subject: "one", text: "Current release red" },
        b: { subject: "two", text: "Current release blue" },
        expected: "same_entity",
      },
      {
        a: { subject: "one", text: "ready /a/b/c" },
        b: { subject: "two", text: "ready /a/b/c" },
        expected: "same_entity",
      },
      {
        a: { subject: "one", text: "ready node42.example.invalid" },
        b: { subject: "two", text: "ready node42.example.invalid" },
        expected: "same_entity",
      },
      {
        a: { subject: "alpha beta", text: "ready" },
        b: { subject: "beta gamma", text: "ready" },
        expected: "same_entity",
      },
      {
        a: { subject: "one", text: "alpha beta gamma delta" },
        b: { subject: "two", text: "alpha beta gamma epsilon" },
        expected: "same_entity",
      },
      {
        a: { subject: "production service", text: "current state" },
        b: { subject: "current report", text: "production service" },
        expected: "possibly_related",
      },
      {
        a: { subject: "one", text: "shared" },
        b: { subject: "two", text: "shared" },
        expected: "possibly_related",
      },
      {
        a: { subject: "one", text: "alpha" },
        b: { subject: "two", text: "beta" },
        expected: "unrelated",
      },
      {
        a: { predicate: "STATUS" },
        b: { predicate: "status" },
        expected: "same_entity",
      },
      {
        a: { predicate: "version" },
        b: { predicate: "status" },
        expected: "unrelated",
      },
      {
        a: { predicate: "" },
        b: { predicate: "status" },
        expected: "same_entity",
      },
    ] as const;
    const accepted: Row[] = [];
    for (const [i, example] of examples.entries()) {
      const target = f.row(100 + i, {
        ...f.canonical,
        id: id(100 + i),
        ...example.a,
      });
      const working = f.row(200 + i, example.b);
      expect(stateRelationship(target, working)).toBe(example.expected);
      expect(
        preparedStateRelationship(prepareState(target), prepareState(working)),
      ).toBe(example.expected);
      accepted.push(target);
      f.insert([working]);
    }
    const working = f.t.app.ck.deps.db
      .select()
      .from(records)
      .where(eq(records.reviewStatus, "proposed"))
      .all();
    const full = accepted.map((row) =>
      classifyRecordFreshness(row, { nowIso: NOW, workingRecords: working }),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = loadRecordFreshnessContext(f.t.app.ck.deps.db, accepted, NOW);
      expect(
        accepted.map((row) => toRecordDto(row, [], ctx).freshness),
      ).toEqual(full);
    }
    // A new page exercises the inverted index rather than the per-target signals.
    const later = f.row(999, {
      ...f.canonical,
      id: id(999),
      subject: "x",
      text: "unshared",
    });
    expect(f.freshness(later)).toEqual(
      classifyRecordFreshness(later, { nowIso: NOW, workingRecords: working }),
    );
  });

  it("preserves state eligibility and structured observation time without reading report bodies from a warm cache", async () => {
    const f = await fixture();
    const working = [
      f.row(2, {
        predicate: null,
        text: "plain note",
        valueJson: '{"currentState":false}',
      }),
      f.row(3, {
        predicate: null,
        text: "plain note",
        volatile: 1,
        sourceEventAt: null,
        effectiveFrom: AFTER,
      }),
      f.row(4, {
        predicate: null,
        text: "plain note",
        valueJson: '{"operationalState":null}',
        sourceEventAt: null,
      }),
      f.row(5, { predicate: null, text: "plain note", valueJson: "{invalid}" }),
      f.row(6, {
        predicate: null,
        text: "plain note",
        valueJson: '[{"currentState":true}]',
      }),
      f.row(7, { sourceEventAt: BEFORE }),
      f.row(8, { sourceEventAt: "", effectiveFrom: "" }),
      f.row(9, { type: "decision" }),
      f.row(10, { reviewStatus: "rejected" }),
      f.row(11, { evidenceBasis: "document" }),
    ];
    f.insert([f.canonical, ...working]);
    const expected = classifyRecordFreshness(f.canonical, {
      nowIso: NOW,
      workingRecords: working,
    });
    expect(expected.supportRecordIds).toEqual([id(2), id(3)]);
    expect(expected.possiblyRelatedRecordIds).toEqual([id(4), id(8)]);
    expect(f.freshness()).toEqual(expected);
    const ctx = loadRecordFreshnessContext(
      f.t.app.ck.deps.db,
      [f.canonical],
      NOW,
    );
    ctx
      .preloadedSignals!.get(f.canonical.id)!
      .supportRecordIds.push("synthetic-mutation");
    expect(f.freshness()).toEqual(expected);
  });

  it("keeps the version read and a cold scan in one snapshot during an external commit", async () => {
    const f = await fixture();
    f.insert([f.canonical, f.row(2), f.row(3)]);
    const writer = openDatabase(f.t.config.dbPath);
    const sqlite = f.t.app.ck.deps.sqlite;
    const original = sqlite.prepare.bind(sqlite);
    let committed = false;
    const spy = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((query: string) => {
        const statement = original(query);
        if (/SELECT id, project_id AS projectId/.test(query)) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...args: unknown[]) {
            for (const row of iterate(...args)) {
              if (!committed) {
                writer.db.transaction((tx) => {
                  tx.update(records)
                    .set({ reviewStatus: "rejected" })
                    .where(eq(records.id, id(3)))
                    .run();
                  tx.update(projects)
                    .set({ workingMemoryVersion: 1 })
                    .where(eq(projects.id, f.projectId))
                    .run();
                });
                committed = true;
              }
              yield row;
            }
          };
        }
        return statement;
      });
    try {
      expect(f.freshness().supportRecordIds).toEqual([id(2), id(3)]);
      expect(committed).toBe(true);
      expect(f.freshness().supportRecordIds).toEqual([id(2)]);
    } finally {
      spy.mockRestore();
      writer.sqlite.close();
    }
  });

  it("reclassifies warm brief and context rows at exact temporal boundaries without a write", async () => {
    const f = await fixture();
    const canonical = {
      ...f.canonical,
      volatile: 1,
      effectiveFrom: "2026-05-02T00:00:00.000Z",
      reviewDueAt: "2026-05-03T00:00:00.000Z",
      effectiveTo: "2026-05-04T00:00:00.000Z",
    };
    f.insert([canonical]);
    const service = new ContextKeepMemoryService(f.t.app.ck.deps);
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [at, currentness] of [
      [NOW, "future_effective"],
      [canonical.effectiveFrom, "current"],
      [canonical.reviewDueAt, "review_due"],
      [canonical.effectiveTo, "expired"],
      [NOW, "future_effective"],
    ]) {
      vi.setSystemTime(new Date(at!));
      const brief = readBrief(f.t.app.ck.deps, {
        projectId: f.projectId,
        limit: 10,
        offset: 0,
      });
      expect(brief.sections.facts!.items[0]!.freshness!.currentness).toBe(
        currentness,
      );
      const context = service.getWorkContext(
        { scope: "project", projectId: f.projectId },
        { task: "gateway", totalContextBudgetChars: 60000 },
      );
      expect(context.facts).toMatchObject({
        items: [{ freshness: { currentness } }],
      });
    }
  });

  it("invalidates both versions immediately, isolates projects and returns independent copies", async () => {
    const f = await fixture();
    f.insert([f.canonical]);
    expect(f.freshness().currentness).toBe("current");
    f.insert([f.row(2, { sourceEventAt: null })]);
    f.bump();
    expect(f.freshness()).toMatchObject({
      stale: false,
      possiblyRelatedRecordIds: [id(2)],
    });
    const returned = f.freshness();
    returned.possiblyRelatedRecordIds.push("mutated");
    expect(f.freshness().possiblyRelatedRecordIds).toEqual([id(2)]);
    f.t.app.ck.deps.db
      .update(records)
      .set({ sourceEventAt: AFTER })
      .where(eq(records.id, id(2)))
      .run();
    f.bump();
    expect(f.freshness()).toMatchObject({
      stale: true,
      supportRecordIds: [id(2)],
      possiblyRelatedRecordIds: [],
    });
    f.t.app.ck.deps.db
      .update(records)
      .set({ reviewStatus: "rejected" })
      .where(eq(records.id, id(2)))
      .run();
    f.bump(f.projectId, "contentVersion");
    expect(f.freshness().currentness).toBe("current");

    const otherId = (
      await f.t.post("/api/projects", { name: "Synthetic other project" })
    ).json<{ id: string }>().id;
    const other = f.row(3, { ...f.canonical, id: id(3), projectId: otherId });
    f.insert([other, f.row(4, { projectId: otherId })]);
    const ctx = loadRecordFreshnessContext(
      f.t.app.ck.deps.db,
      [f.canonical, other],
      NOW,
    );
    expect(
      toRecordDto(f.canonical, [], ctx).freshness!.supportRecordIds,
    ).toEqual([]);
    expect(toRecordDto(other, [], ctx).freshness!.supportRecordIds).toEqual([
      id(4),
    ]);
    const measure = measureSql(f.t);
    f.bump(otherId);
    f.freshness();
    expect(measure.stats.proposalScans).toBe(0);
    measure.stop();
  });

  it("keeps effective/review boundaries and clock reversal live, and never caches conflict truth", async () => {
    const f = await fixture();
    const canonical = {
      ...f.canonical,
      volatile: 1,
      effectiveFrom: "2026-05-02T00:00:00.000Z",
      reviewDueAt: "2026-05-03T00:00:00.000Z",
      effectiveTo: "2026-05-04T00:00:00.000Z",
    };
    f.insert([canonical]);
    const expected = [
      [NOW, "future_effective"],
      [canonical.effectiveFrom, "current"],
      [canonical.reviewDueAt, "review_due"],
      [canonical.effectiveTo, "expired"],
      [NOW, "future_effective"],
    ];
    const measure = measureSql(f.t);
    for (const [at, currentness] of expected)
      expect(f.freshness(canonical, at).currentness).toBe(currentness);
    expect(measure.stats.proposalScans).toBe(1);
    measure.stop();
    const at = canonical.effectiveFrom;
    f.t.app.ck.deps.db
      .insert(conflicts)
      .values({
        id: "synthetic-conflict",
        projectId: f.projectId,
        recordIdsJson: JSON.stringify([canonical.id, id(42)]),
        status: "unresolved",
        resolutionRecordId: null,
        createdAt: BEFORE,
        updatedAt: BEFORE,
      })
      .run();
    expect(f.freshness(canonical, at)).toMatchObject({
      currentness: "conflicted",
      supportRecordIds: [id(42)],
    });
    f.t.app.ck.deps.db
      .update(conflicts)
      .set({ status: "resolved" })
      .where(eq(conflicts.id, "synthetic-conflict"))
      .run();
    expect(f.freshness(canonical, at).currentness).toBe("current");
  });

  it("separates DB instances, observes external commits and never leaks a rolled-back transaction", async () => {
    const [f, other] = await Promise.all([fixture(), fixture()]);
    // Deliberately collide project IDs, versions and record IDs in separate DBs.
    other.t.app.ck.deps.db
      .insert(projects)
      .values({
        ...f.t.app.ck.deps.db
          .select()
          .from(projects)
          .where(eq(projects.id, f.projectId))
          .get()!,
        name: "Synthetic colliding project",
      })
      .run();
    f.insert([f.canonical, f.row(2)]);
    other.insert([{ ...f.canonical }]);
    expect(f.freshness().stale).toBe(true);
    expect(other.freshness(f.canonical).stale).toBe(false);
    const db = f.t.app.ck.deps.db;
    expect(() =>
      db.transaction((tx) => {
        tx.update(records)
          .set({ sourceEventAt: BEFORE })
          .where(eq(records.id, id(2)))
          .run();
        tx.update(projects)
          .set({ workingMemoryVersion: 1 })
          .where(eq(projects.id, f.projectId))
          .run();
        expect(
          toRecordDto(
            f.canonical,
            [],
            loadRecordFreshnessContext(tx, [f.canonical], NOW),
          ).freshness!.stale,
        ).toBe(false);
        // Passing the root handle inside a transaction must also bypass the cache.
        expect(f.freshness().stale).toBe(false);
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");
    f.bump(); // Version 1 is reused, but the rolled-back snapshot must be gone.
    expect(f.freshness().stale).toBe(true);
    const second = openDatabase(f.t.config.dbPath);
    try {
      second.db.transaction((tx) => {
        tx.update(records)
          .set({ reviewStatus: "rejected" })
          .where(eq(records.id, id(2)))
          .run();
        tx.update(projects)
          .set({ workingMemoryVersion: 2 })
          .where(eq(projects.id, f.projectId))
          .run();
      });
      expect(f.freshness().stale).toBe(false);
    } finally {
      second.sqlite.close();
    }
  });
});

describe("freshness work and retention budgets", () => {
  it("streams long bodies without a SQL sorter and samples IDs independently of rowid/postings order", async () => {
    const f = await fixture();
    const canonical = { ...f.canonical, subject: "A", text: "current /x/y/z" };
    const working = Array.from({ length: 140 }, (_, i) =>
      f.row(100 + i, {
        subject: `B${i}`,
        text: "Synthetic report. ".repeat(8000) + " /x/y/z",
        sourceEventAt: i % 2 ? null : AFTER,
      }),
    );
    // More than one transaction page; physical order differs from ID order.
    f.insert(working.toReversed());
    const sqlite = f.t.app.ck.deps.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    const plans: string[][] = [];
    const reads: string[] = [];
    const spy = vi
      .spyOn(sqlite, "prepare")
      .mockImplementation((query: string) => {
        const statement = prepare(query);
        if (!/SELECT id, project_id AS projectId/.test(query)) return statement;
        for (const method of ["iterate", "all"] as const) {
          const original = statement[method].bind(statement);
          (statement[method] as unknown) = (...args: unknown[]) => {
            plans.push(
              (
                prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as {
                  detail: string;
                }[]
              ).map((r) => r.detail),
            );
            // No temporary body sorter in either native or transaction scans.
            const opcodes = (
              prepare(`EXPLAIN ${query}`).all(...args) as { opcode: string }[]
            ).map((r) => r.opcode);
            expect(opcodes).not.toContain("SorterOpen");
            expect(opcodes).not.toContain("OpenEphemeral");
            reads.push(method);
            return original(...args);
          };
        }
        return statement;
      });
    try {
      const result = f.freshness(canonical);
      expect(reads).toEqual(["iterate"]);
      expect(result).toMatchObject({
        supportRecordIds: working
          .filter((r) => r.sourceEventAt)
          .slice(0, 20)
          .map((r) => r.id),
        possiblyRelatedRecordIds: working
          .filter((r) => !r.sourceEventAt)
          .slice(0, 20)
          .map((r) => r.id),
        referenceSummary: { supportCount: 70, possiblyRelatedCount: 70 },
      });
      // Exercise cached postings for a new projection without another body scan.
      expect(f.freshness({ ...canonical, id: id(9999) })).toEqual(result);
      expect(reads).toEqual(["iterate"]);
      const ctx = f.t.app.ck.deps.db.transaction((tx) =>
        loadRecordFreshnessContext(tx, [canonical], NOW),
      );
      expect(toRecordDto(canonical, [], ctx).freshness).toEqual(result);
      expect(reads).toEqual(["iterate", "all", "all"]);
      for (const plan of plans) {
        expect(plan.join("\n")).toContain(
          "USING INDEX ix_records_project_status",
        );
        expect(plan.join("\n")).not.toContain("TEMP B-TREE");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("shares one cold proposal scan across paginated brief and task context, with no warm proposal reads", async () => {
    const f = await fixture();
    const types = ["fact", "decision", "constraint", "question", "action"];
    const accepted = Array.from({ length: 1000 }, (_, i) =>
      f.row(i + 1, {
        reviewStatus: "accepted",
        evidenceBasis: "document",
        type: types[i % types.length]!,
        subject: `example-gateway ${i}`,
        predicate: i % 5 === 0 ? "status" : null,
        sourceEventAt: BEFORE,
        recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        taskStatus: i % 5 === 4 ? "open" : null,
      }),
    );
    const working = Array.from({ length: 10_000 }, (_, i) =>
      f.row(i + 1001, {
        subject: `example-gateway observation-${i}`,
        text: `Working gateway current release deployment health observation ${i}; verify SQLite backup evidence before handoff.`,
        sourceEventAt: i < 5000 ? null : AFTER,
      }),
    );
    f.insert([...accepted, ...working]);
    const measure = measureSql(f.t);
    const start = performance.now();
    const cold = readBrief(f.t.app.ck.deps, {
      projectId: f.projectId,
      offset: 0,
      limit: 10,
    });
    const coldMs = performance.now() - start;
    expect(measure.stats.proposalScans).toBe(1);
    expect(measure.stats.proposalRows).toBe(10_000);
    expect(measure.stats.calls).toBeLessThan(50);
    expect(measure.stats.rows).toBeLessThan(10_150);
    expect(cold.sections.facts!.items).toHaveLength(10);
    expect(cold.sections.facts!.total).toBe(200);
    const first = cold.sections.facts!.items[0]!;
    expect(first.freshness).toMatchObject({
      currentness: "needs_verification",
      stale: true,
      referenceSummary: {
        supportCount: 5000,
        possiblyRelatedCount: 5000,
        supportReferencesTruncated: true,
        possiblyRelatedReferencesTruncated: true,
      },
    });
    const coldWork = { ...measure.stats };
    const briefSamples: number[] = [];
    const contextSamples: number[] = [];
    let warmBriefWork = { calls: 0, rows: 0 };
    let warmContextWork = { calls: 0, rows: 0 };
    let contextChars = 0;
    const service = new ContextKeepMemoryService(f.t.app.ck.deps);
    const context = { scope: "project" as const, projectId: f.projectId };
    const input = {
      task: "gateway",
      limitPerSection: 5,
      totalContextBudgetChars: 6000,
    };
    // Warm unrelated retrieval caches once; freshness is already shared by brief.
    const complete = service.getWorkContext(context, {
      ...input,
      totalContextBudgetChars: 60000,
    });
    expect(complete.facts).toMatchObject({
      items: [
        expect.objectContaining({
          status: "accepted",
          freshness: expect.objectContaining({
            stale: true,
            referenceSummary: expect.objectContaining({
              supportCount: 5000,
              possiblyRelatedCount: 5000,
            }),
          }),
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    });
    measure.reset();
    for (let sample = 0; sample < 10; sample++) {
      const prior = { ...measure.stats };
      let start = performance.now();
      const brief = readBrief(f.t.app.ck.deps, {
        projectId: f.projectId,
        offset: 0,
        limit: 10,
      });
      briefSamples.push(performance.now() - start);
      expect(brief.sections).toEqual(cold.sections);
      warmBriefWork = {
        calls: measure.stats.calls - prior.calls,
        rows: measure.stats.rows - prior.rows,
      };
      const beforeContext = { ...measure.stats };
      start = performance.now();
      const output = service.getWorkContext(context, input);
      contextSamples.push(performance.now() - start);
      warmContextWork = {
        calls: measure.stats.calls - beforeContext.calls,
        rows: measure.stats.rows - beforeContext.rows,
      };
      contextChars = JSON.stringify(output).length;
      expect(output.project).toMatchObject({ id: f.projectId });
      expect(JSON.stringify(output).length).toBeLessThanOrEqual(6000);
    }
    expect(measure.stats.proposalScans).toBe(0);
    expect(measure.stats.proposalRows).toBe(0);
    // Deterministic work budget, independent of machine speed or generous timing.
    expect(measure.stats.rows).toBeLessThan(4000);
    expect(measure.stats.calls).toBeLessThan(800);
    const warmWork = { ...measure.stats };
    measure.reset();
    const page = readBrief(f.t.app.ck.deps, {
      projectId: f.projectId,
      offset: 10,
      limit: 10,
    });
    expect(page.sections.facts!.items[0]!.recordId).not.toBe(first.recordId);
    expect(
      page.sections.facts!.items[0]!.freshness!.referenceSummary!.supportCount,
    ).toBe(5000);
    expect(measure.stats.proposalScans).toBe(0); // prepared index serves unseen targets
    measure.reset();
    f.bump();
    const coldContextStart = performance.now();
    const refreshed = service.getWorkContext(context, input);
    const coldContextMs = performance.now() - coldContextStart;
    expect(refreshed.project).toMatchObject({ workingMemoryVersion: 1 });
    expect(measure.stats.proposalScans).toBe(1);
    expect(measure.stats.proposalRows).toBe(10000);
    expect(measure.stats.rows).toBeLessThan(16000);
    expect(measure.stats.calls).toBeLessThan(90);
    const coldContextWork = { ...measure.stats };
    measure.stop();
    const distribution = (samples: number[]) => {
      const sorted = samples.sort((a, b) => a - b);
      return {
        medianMs: Number(sorted[5]!.toFixed(2)),
        p95Ms: Number(sorted[9]!.toFixed(2)),
      };
    };
    const measurements = {
      fixture: "1000 accepted / 10000 working",
      coldBriefMs: Number(coldMs.toFixed(2)),
      coldWork,
      coldContextMs: Number(coldContextMs.toFixed(2)),
      coldContextWork,
      warmCombinedWork: warmWork,
      warmBriefWork,
      warmContextWork,
      contextChars,
      brief: distribution(briefSamples),
      context: distribution(contextSamples),
    };
    // Optional synthetic measurement artifact for a dedicated local run. CI
    // assertions depend on executed SQL work, never machine-sensitive timings.
    if (process.env.CK_FRESHNESS_METRICS) {
      writeFileSync(
        process.env.CK_FRESHNESS_METRICS,
        JSON.stringify(measurements, null, 2),
      );
    }
  });

  it("bounds retained signal/project entries and recomputes evicted evidence completely", async () => {
    const f = await fixture();
    const accepted = Array.from({ length: 520 }, (_, i) =>
      f.row(i + 1, {
        ...f.canonical,
        id: id(i + 1),
        subject: `example-gateway ${i}`,
      }),
    );
    f.insert([...accepted, f.row(1000)]);
    loadRecordFreshnessContext(f.t.app.ck.deps.db, accepted, NOW);
    // The earliest signals were evicted, but the complete prepared index remains.
    const measure = measureSql(f.t);
    expect(f.freshness(accepted[0]!).supportRecordIds).toEqual([id(1000)]);
    expect(measure.stats.proposalScans).toBe(0);
    measure.stop();
    for (let i = 0; i < 8; i++) {
      const projectId = (
        await f.t.post("/api/projects", {
          name: `Synthetic cache project ${i}`,
        })
      ).json<{ id: string }>().id;
      const canonical = f.row(2000 + i, {
        ...f.canonical,
        id: id(2000 + i),
        projectId,
      });
      f.insert([canonical]);
      f.freshness(canonical);
    }
    const evicted = measureSql(f.t);
    expect(f.freshness(accepted[0]!).supportRecordIds).toEqual([id(1000)]);
    expect(evicted.stats.proposalScans).toBe(1);
    evicted.stop();
  });

  it("does not truncate long reports or lose evidence when the prepared index exceeds its byte budget", async () => {
    const f = await fixture();
    const canonical = {
      ...f.canonical,
      subject: "A",
      text: "production /x/y/z",
    };
    // Unique tokens make the prepared index exceed admission size. The only
    // strong identifier occurs beyond the display clip at the end of the report.
    const working = Array.from({ length: 7 }, (_, report) =>
      f.row(report + 100, {
        subject: "B",
        text:
          Array.from({ length: 15000 }, (_, i) => `term${report}x${i}`).join(
            " ",
          ) + " /x/y/z",
      }),
    );
    f.insert([canonical, ...working]);
    const first = f.freshness(canonical);
    expect(first).toMatchObject({
      stale: true,
      supportRecordIds: working.map((row) => row.id),
    });
    const measure = measureSql(f.t);
    expect(f.freshness(canonical)).toEqual(first);
    expect(measure.stats.proposalScans).toBe(0); // compact signals still admitted
    const another = { ...canonical, id: id(999) };
    expect(f.freshness(another)).toEqual(first);
    expect(measure.stats.proposalScans).toBe(1); // complete fallback for an unseen target
    expect(measure.stats.proposalRows).toBe(7);
    measure.stop();
  });
});
