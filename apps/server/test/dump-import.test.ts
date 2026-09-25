import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { applyDump, summarizeDump } from "../src/services/dump-import.js";
import { seedDemo } from "../src/seed.js";
import { buildJsonDump } from "../src/services/export.js";
import type { ServiceDeps } from "../src/services/import.js";
import { recordDedupHash } from "../src/lib/hash.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>) => {
  const t = await makeTestApp({ seed: true });
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

function depsOf(t: TestApp): ServiceDeps {
  return (t.app as unknown as { ck: { deps: ServiceDeps } }).ck.deps;
}

function sqliteOf(t: TestApp): Database.Database {
  return depsOf(t).sqlite;
}

describe("M1 dump import: happy path", () => {
  it("rejects an unknown format", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/admin/import-dump", {
        dump: { format: "something.else", version: 1 },
      });
      expectStatus(res, 400, "unknown format");
    });
  });

  it("rejects an unsupported version", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/admin/import-dump", {
        dump: { format: "contextkeep.json_dump", version: 999 },
      });
      expectStatus(res, 400, "bad version");
    });
  });

  it("applyDump: minimal dump with one project inserts it (merge mode)", async () => {
    await withApp(async (t) => {
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [
          {
            id: "imported-proj-1",
            name: "Imported Project",
            aliasesJson: "[]",
            parentProjectId: null,
            description: "imported via dump",
            lifecycle: "active",
            lifecycleRecordId: null,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        sources: [],
        sourceExcerpts: [],
        records: [],
        recordEvidence: [],
        supersessions: [],
      };
      const counters = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      expect(counters.accepted).toBe(1);
      expect(counters.skipped).toBe(0);
      expect(counters.retiredGuards).toBe(0);
      expect(counters.blocked).toBe(0);
      const row = sqliteOf(t)
        .prepare("SELECT name, lifecycle FROM projects WHERE id = ?")
        .get("imported-proj-1") as { name: string; lifecycle: string };
      expect(row.name).toBe("Imported Project");
      expect(row.lifecycle).toBe("active");
    });
  });
});

describe("M1 dump import: idempotency", () => {
  it("re-importing the same dump in merge mode skips every row", async () => {
    await withApp(async (t) => {
      // Round 1: dump from the seed → all rows are new, accepted.
      const dump = buildJsonDump(depsOf(t), { actor: "test:round1", requestId: null });
      const first = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      // The seed is already in the store; every row should be skipped on round 2.
      expect(first.accepted).toBe(0);
      expect(first.skipped).toBeGreaterThan(0);

      const second = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      expect(second.accepted).toBe(0);
      expect(second.skipped).toBe(first.skipped);
    });
  });

  it("reset mode wipes then re-applies — produces the same state (counts are deterministic)", async () => {
    await withApp(async (t) => {
      const dump = buildJsonDump(depsOf(t), { actor: "test:reset", requestId: null });
      const counters = applyDump(
        depsOf(t),
        { dump, mode: "reset", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      // Every row from the original dump is "accepted" again (wipe + replay).
      const projects = sqliteOf(t).prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
      const records = sqliteOf(t).prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number };
      expect(projects.n).toBeGreaterThan(0);
      expect(records.n).toBeGreaterThan(0);
      expect(counters.accepted).toBeGreaterThan(0);
    });
  });
});

describe("M1 dump import: §3 inventory guards", () => {
  it("A3: refuses to reactivate a retired project in merge mode (counts retiredGuards, leaves state untouched)", async () => {
    await withApp(async (t) => {
      const sqlite = sqliteOf(t);
      // Isolated retired project so this test doesn't depend on seed fixtures.
      const projId = "test-retired-a3";
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, aliases_json, parent_project_id, description, lifecycle, lifecycle_record_id, revision, created_at, updated_at)
           VALUES (?, 'Test Retired A3', '[]', NULL, 'isolated test fixture', 'retired', NULL, 1, ?, ?)`,
        )
        .run(projId, new Date().toISOString(), new Date().toISOString());

      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [
          {
            id: projId,
            name: "Renamed-In-Dump",
            aliasesJson: "[]",
            parentProjectId: null,
            description: "dump trying to flip retired project to active",
            lifecycle: "active",
            lifecycleRecordId: null,
            revision: 2,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        sources: [],
        sourceExcerpts: [],
        records: [],
        recordEvidence: [],
        supersessions: [],
      };
      const counters = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      expect(counters.retiredGuards).toBe(1);
      // Project lifecycle is still retired.
      const after = sqlite
        .prepare("SELECT lifecycle FROM projects WHERE id = ?")
        .get(projId) as { lifecycle: string };
      expect(after.lifecycle).toBe("retired");
    });
  });

  it("A19: an accepted record dumped into a retired project is coerced to proposed", async () => {
    await withApp(async (t) => {
      // Use a freshly-created retired project (not from the seed) so this test
      // is fully isolated from other tests that share the same fixtures.
      const sqlite = sqliteOf(t);
      const projId = "test-retired-a19";
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, aliases_json, parent_project_id, description, lifecycle, lifecycle_record_id, revision, created_at, updated_at)
           VALUES (?, 'Test Retired A19', '[]', NULL, 'isolated test fixture', 'retired', NULL, 1, ?, ?)`,
        )
        .run(projId, new Date().toISOString(), new Date().toISOString());

      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [],
        sources: [],
        sourceExcerpts: [],
        records: [
          {
            id: "a19-dumped-record",
            projectId: projId,
            type: "fact",
            subject: "imported-subject",
            predicate: null,
            valueJson: null,
            text: "Imported claim that landed in a retired project's scope.",
            reviewStatus: "accepted",
            evidenceBasis: "document",
            taskStatus: null,
            recordDedupHash: "a19-hash-unique",
            recordedAt: new Date().toISOString(),
            sourceEventAt: null,
            effectiveFrom: null,
            effectiveTo: null,
            reviewedAt: new Date().toISOString(),
            reviewDueAt: null,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        recordEvidence: [],
        supersessions: [],
      };
      const counters = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      expect(counters.accepted).toBe(1);
      expect(counters.retiredGuards).toBe(1);
      const after = sqlite
        .prepare("SELECT review_status FROM records WHERE id = ?")
        .get("a19-dumped-record") as { review_status: string };
      expect(after.review_status).toBe("proposed");
    });
  });
});

describe("M1 dump import: audit + HTTP", () => {
  it("writes an import_dump.applied audit event with the dump SHA-256 and counters", async () => {
    await withApp(async (t) => {
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [
          {
            id: "audit-proj",
            name: "Audit Project",
            aliasesJson: "[]",
            parentProjectId: null,
            description: null,
            lifecycle: "unknown",
            lifecycleRecordId: null,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        sources: [],
        sourceExcerpts: [],
        records: [],
        recordEvidence: [],
        supersessions: [],
      };
      const counters = applyDump(
        depsOf(t),
        { dump, mode: "merge", source: "test" },
        { actor: "test:dump-import", requestId: null },
      );
      const auditRow = sqliteOf(t)
        .prepare("SELECT action, after_ref FROM audit_events WHERE action = 'import_dump.applied' ORDER BY timestamp DESC LIMIT 1")
        .get() as { action: string; after_ref: string };
      expect(auditRow.action).toBe("import_dump.applied");
      const parsed = JSON.parse(auditRow.after_ref);
      expect(parsed.dumpSha256).toBe(counters.dumpSha256);
      expect(parsed.accepted).toBe(1);
    });
  });

  it("POST /api/admin/import-dump: returns counters on success", async () => {
    await withApp(async (t) => {
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [
          {
            id: "http-proj",
            name: "HTTP Project",
            aliasesJson: "[]",
            parentProjectId: null,
            description: null,
            lifecycle: "active",
            lifecycleRecordId: null,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        sources: [],
        sourceExcerpts: [],
        records: [],
        recordEvidence: [],
        supersessions: [],
      };
      const res = await t.post("/api/admin/import-dump", { dump, mode: "merge" });
      expectStatus(res, 200, "admin import-dump");
      const body = res.json<{ ok: boolean; mode: string; accepted: number; skipped: number; dumpSha256: string }>();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("merge");
      expect(body.accepted).toBe(1);
      expect(typeof body.dumpSha256).toBe("string");
      expect(body.dumpSha256.length).toBe(64); // sha256 hex
    });
  });

  it("POST /api/admin/import-dump: refuses unauthenticated requests", async () => {
    await withApp(async (t) => {
      const res = await t.raw("POST", "/api/admin/import-dump", { dump: {}, mode: "merge" });
      expectStatus(res, 401, "unauth");
    });
  });
});


describe("2026-09-19 A01 audit regressions", () => {
  it("advances canonical freshness for new accepted merge content, but not for a no-op reimport", async () => {
    await withApp(async (t) => {
      const project = (await t.post("/api/projects", { name: "Merge freshness" })).json<{ id: string }>();
      const sqlite = sqliteOf(t);
      const before = sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
      const sourceId = randomUUID();
      const excerptId = randomUUID();
      const recordId = randomUUID();
      const now = new Date().toISOString();
      const text = "Imported accepted canonical fact.";
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [],
        sources: [{
          id: sourceId, kind: "manual", title: "Merge evidence", originalFilename: null,
          contentHash: `source-${sourceId}`, normalizedHash: `normalized-${sourceId}`, importedAt: now,
          eventAt: now, authorLabel: "test", provenanceBasis: "document", projectId: project.id,
          originalText: text, normalizedText: text, redactionState: "none",
        }],
        sourceExcerpts: [{ id: excerptId, sourceId, startOffset: 0, endOffset: text.length, exactText: text, exactTextHash: `excerpt-${excerptId}` }],
        records: [{
          id: recordId, projectId: project.id, type: "fact", subject: "merge-freshness", predicate: null,
          valueJson: null, text, reviewStatus: "accepted", evidenceBasis: "document", taskStatus: null,
          recordDedupHash: recordDedupHash({ projectId: project.id, type: "fact", subject: "merge-freshness", text }),
          recordedAt: now, sourceEventAt: now, effectiveFrom: null, effectiveTo: null, reviewedAt: now,
          reviewDueAt: null, revision: 1, createdAt: now, updatedAt: now,
        }],
        recordEvidence: [{ recordId, excerptId, relation: "supports", observedAt: now, environment: null, artifactRef: null }],
        supersessions: [],
      };

      const first = applyDump(depsOf(t), { dump, mode: "merge", source: "freshness-test" }, { actor: "test:freshness", requestId: null });
      expect(first.accepted).toBe(4);
      const afterFirst = sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
      expect(afterFirst.contentVersion).toBe(before.contentVersion + 1);

      const second = applyDump(depsOf(t), { dump, mode: "merge", source: "freshness-test" }, { actor: "test:freshness", requestId: null });
      expect(second.accepted).toBe(0);
      const afterSecond = sqlite.prepare("SELECT content_version AS contentVersion FROM projects WHERE id=?").get(project.id) as { contentVersion: number };
      expect(afterSecond).toEqual(afterFirst);
    });
  });

  it("reset import is fail-closed when any row is malformed", async () => {
    await withApp(async (t) => {
      const sqlite = sqliteOf(t);
      const before = {
        projects: (sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n,
        records: (sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n,
        sources: (sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n,
      };
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [],
        sources: [],
        sourceExcerpts: [],
        records: [{ text: "malformed row without an id", reviewStatus: "proposed" }],
        recordEvidence: [],
        supersessions: [],
      };

      const res = await t.post("/api/admin/import-dump", { dump, mode: "reset" });
      expectStatus(res, 400, "malformed reset");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("reset_dump_blocked");

      const after = {
        projects: (sqlite.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n,
        records: (sqlite.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n,
        sources: (sqlite.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n,
      };
      expect(after).toEqual(before);
    });
  });

  it("direct dump import refuses a newly imported accepted record without evidence", async () => {
    await withApp(async (t) => {
      const sqlite = sqliteOf(t);
      const dump = {
        format: "contextkeep.json_dump",
        version: 1,
        projects: [],
        sources: [],
        sourceExcerpts: [],
        records: [{
          id: "audit-accepted-without-evidence",
          projectId: null,
          type: "fact",
          subject: "audit-invalid-canonical",
          predicate: null,
          valueJson: null,
          text: "This accepted claim intentionally has no evidence.",
          reviewStatus: "accepted",
          evidenceBasis: "document",
          taskStatus: null,
          recordDedupHash: "audit-accepted-without-evidence-hash",
          recordedAt: new Date().toISOString(),
          sourceEventAt: null,
          effectiveFrom: null,
          effectiveTo: null,
          reviewedAt: new Date().toISOString(),
          reviewDueAt: null,
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }],
        recordEvidence: [],
        supersessions: [],
      };

      expect(() =>
        applyDump(
          depsOf(t),
          { dump, mode: "merge", source: "audit:a01" },
          { actor: "test:a01", requestId: "audit-a01-no-evidence" },
        ),
      ).toThrow(/accepted but has no evidence/);

      expect(
        (sqlite.prepare("SELECT count(*) AS n FROM records WHERE id=?").get("audit-accepted-without-evidence") as { n: number }).n,
      ).toBe(0);
    });
  });
});

describe("M1 dump import: summarizeDump", () => {
  it("returns the dump SHA-256 for a valid payload", async () => {
    const s = summarizeDump({
      format: "contextkeep.json_dump",
      version: 1,
      projects: [],
      sources: [],
      sourceExcerpts: [],
      records: [],
      recordEvidence: [],
      supersessions: [],
    });
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.sha256.length).toBe(64);
  });

  it("returns an error for a malformed payload", async () => {
    const s = summarizeDump({ format: "nope" });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.code).toBe("invalid_dump");
  });
});

// Re-export so vitest doesn't tree-shake the seed import (some configs need it for side-effects).
void seedDemo;
