import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ServiceDeps } from "../src/services/import.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>) => {
  const t = await makeTestApp({ seed: true });
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

/** Resolve the raw better-sqlite3 handle from the test app. */
function dbOf(t: TestApp): Database.Database {
  const deps = (t.app as unknown as { ck: { deps: ServiceDeps } }).ck.deps;
  return deps.sqlite;
}

describe("FTS5: index integrity", () => {
  it("ck_records_fts virtual table exists after migration", async () => {
    await withApp(async (t) => {
      const sqlite = dbOf(t);
      const row = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ck_records_fts'",
        )
        .get();
      expect(row).toBeTruthy();
    });
  });

  it("FTS5 row count equals records row count (index mirrors the records table)", async () => {
    await withApp(async (t) => {
      const sqlite = dbOf(t);
      const ftsCount = (
        sqlite.prepare("SELECT COUNT(*) AS n FROM ck_records_fts").get() as {
          n: number;
        }
      ).n;
      const recordsCount = (
        sqlite.prepare("SELECT COUNT(*) AS n FROM records").get() as {
          n: number;
        }
      ).n;
      // The seed inserts 11 records. All should be in FTS5 (the index mirrors
      // the records table; review_status is an UNINDEXED filter column).
      expect(ftsCount).toBe(recordsCount);
      expect(ftsCount).toBeGreaterThanOrEqual(11);
    });
  });

  it("INSERT into records is mirrored into ck_records_fts by trigger, DELETE removes it", async () => {
    await withApp(async (t) => {
      const sqlite = dbOf(t);
      const before = (
        sqlite.prepare("SELECT COUNT(*) AS n FROM ck_records_fts").get() as {
          n: number;
        }
      ).n;
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO records (id, type, subject, text, review_status, evidence_basis, record_dedup_hash, recorded_at, created_at, updated_at)
           VALUES (?, 'fact', ?, ?, 'proposed', 'document', ?, ?, ?, ?)`,
        )
        .run(
          "fts5-test-insert-1",
          "fts5-trig",
          "unique-fts5-trigger-marker",
          "fts5-trig-abc123",
          now,
          now,
          now,
        );
      const afterInsert = (
        sqlite.prepare("SELECT COUNT(*) AS n FROM ck_records_fts").get() as {
          n: number;
        }
      ).n;
      expect(afterInsert).toBe(before + 1);
      const row = sqlite
        .prepare("SELECT subject, text FROM ck_records_fts WHERE record_id = ?")
        .get("fts5-test-insert-1") as
        { subject: string; text: string } | undefined;
      expect(row?.subject).toBe("fts5-trig");
      expect(row?.text).toMatch(/unique-fts5-trigger-marker/);

      // Now DELETE it and confirm the FTS5 row is removed too.
      sqlite
        .prepare("DELETE FROM records WHERE id = ?")
        .run("fts5-test-insert-1");
      const afterDelete = (
        sqlite.prepare("SELECT COUNT(*) AS n FROM ck_records_fts").get() as {
          n: number;
        }
      ).n;
      expect(afterDelete).toBe(before);
      const still = sqlite
        .prepare("SELECT 1 FROM ck_records_fts WHERE record_id = ?")
        .get("fts5-test-insert-1");
      expect(still).toBeUndefined();
    });
  });
});

describe("FTS5: query behaviour", () => {
  it("returns accepted results matching the query (regression vs M0 LIKE)", async () => {
    await withApp(async (t) => {
      const res = await t.get(
        `/api/search?q=${encodeURIComponent("voice input")}`,
      );
      expectStatus(res, 200, "voice input search");
      const body = res.json<{
        records: Array<{ text: string; reviewStatus: string }>;
      }>();
      expect(
        body.records.some((r) => r.text.includes("uses the OpenAI-powered")),
      ).toBe(true);
      expect(body.records.every((r) => r.reviewStatus === "accepted")).toBe(
        true,
      );
    });
  });

  it("does NOT return proposed records (A5: proposals are never searchable)", async () => {
    await withApp(async (t) => {
      const res = await t.get(`/api/search?q=${encodeURIComponent("Cordis")}`);
      const records = res.json<{
        records: Array<{ text: string; reviewStatus: string }>;
      }>().records;
      // ExampleAssistant fact is a proposal in the seed → must not appear.
      expect(records.length).toBe(0);
    });
  });

  it("includeHistorical=true reveals superseded records", async () => {
    await withApp(async (t) => {
      const res = await t.get(
        `/api/search?q=${encodeURIComponent("voice input")}&includeHistorical=true`,
      );
      const records = res.json<{
        records: Array<{ text: string; reviewStatus: string }>;
      }>().records;
      expect(records.some((r) => r.reviewStatus === "superseded")).toBe(true);
      expect(records.some((r) => r.reviewStatus === "accepted")).toBe(true);
    });
  });

  it("porter stemming matches morphological variants", async () => {
    await withApp(async (t) => {
      // The seed has "uses the OpenAI-powered..." — search for "using" (which
      // stems to "use" + "ing" → still matches "uses" via porter).
      const stem = await t.get(`/api/search?q=${encodeURIComponent("using")}`);
      expect(
        stem
          .json<{ records: Array<{ text: string }> }>()
          .records.some((r) => r.text.toLowerCase().includes("uses")),
      ).toBe(true);
      // And a bare stem
      const bare = await t.get(`/api/search?q=${encodeURIComponent("use")}`);
      expect(
        bare
          .json<{ records: Array<{ text: string }> }>()
          .records.some((r) => r.text.toLowerCase().includes("uses")),
      ).toBe(true);
    });
  });

  it("prefix matching: typing half a word still finds it (project name)", async () => {
    await withApp(async (t) => {
      const res = await t.get(
        `/api/search?q=${encodeURIComponent("ExampleSuite")}`,
      );
      const projects = res.json<{ projects: Array<{ name: string }> }>()
        .projects;
      expect(projects.some((p) => p.name.includes("ExampleSuite"))).toBe(true);
    });
  });

  it("FTS5 operators in user input are quoted (no operator injection)", async () => {
    await withApp(async (t) => {
      // Column-restrict operator would otherwise require the column to exist;
      // the quotes around the user's term turn it into a literal token.
      const res = await t.get(
        `/api/search?q=${encodeURIComponent('voice OR "fake_col:abc"')}`,
      );
      expectStatus(res, 200, "operator injection attempt");
      expect(
        res.json<{ records: unknown[] }>().records.length,
      ).toBeGreaterThanOrEqual(0);
    });
  });

  it("scope filters (projectId) AND with the FTS5 MATCH", async () => {
    await withApp(async (t) => {
      const all = await t.get("/api/projects");
      const projects = all.json<Array<{ id: string; name: string }>>();
      const kb = projects.find((p) => p.name === "ExampleSuite Keyboard");
      expect(kb).toBeTruthy();
      const res = await t.get(
        `/api/search?q=${encodeURIComponent("OpenAI")}&projectId=${kb!.id}`,
      );
      const records = res.json<{
        records: Array<{ projectId: string | null }>;
      }>().records;
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((r) => r.projectId === kb!.id)).toBe(true);
    });
  });

  it("scope filters (type) AND with the FTS5 MATCH", async () => {
    await withApp(async (t) => {
      const res = await t.get(
        `/api/search?q=${encodeURIComponent("decision")}&type=decision`,
      );
      const records = res.json<{ records: Array<{ type: string }> }>().records;
      // Every returned record must satisfy both the text query AND the type filter.
      expect(records.every((r) => r.type === "decision")).toBe(true);
    });
  });
});
