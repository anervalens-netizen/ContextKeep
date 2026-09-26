import { describe, expect, it } from "vitest";
import { encodeReadCursor } from "../src/services/bounded-read.js";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>) => {
  const t = await makeTestApp();
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

function installSyntheticReadFixture(
  t: TestApp,
  projectId: string,
): { sourceId: string } {
  const sqlite = t.app.ck.handle.sqlite;
  const now = "2026-01-01T00:00:00.000Z";
  const sourceId = "bounded-source";
  const normalizedText = "synthetic bounded-read source text";
  sqlite
    .prepare(
      `INSERT INTO sources
      (id, kind, title, original_filename, content_hash, normalized_hash, imported_at, event_at,
       author_label, provenance_basis, project_id, original_text, normalized_text, redaction_state)
     VALUES (?, 'text', 'Synthetic bounded-read source', NULL, ?, ?, ?, NULL, NULL, 'document', ?, ?, ?, 'none')`,
    )
    .run(
      sourceId,
      "bounded-content-hash",
      "bounded-normalized-hash",
      now,
      projectId,
      normalizedText,
      normalizedText,
    );

  const addExcerpt = sqlite.prepare(
    `INSERT INTO source_excerpts (id, source_id, start_offset, end_offset, exact_text, exact_text_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 6; i += 1) {
    addExcerpt.run(
      `bounded-excerpt-${String(i).padStart(3, "0")}`,
      sourceId,
      0,
      i,
      `synthetic excerpt ${i}`,
      `hash-${i}`,
    );
  }

  const addRecord = sqlite.prepare(
    `INSERT INTO records
      (id, project_id, type, subject, predicate, value_json, text, review_status, evidence_basis,
       task_status, record_dedup_hash, recorded_at, source_event_at, effective_from, effective_to,
       reviewed_at, review_due_at, volatile, revision, created_at, updated_at)
     VALUES (?, ?, 'fact', ?, NULL, NULL, ?, ?, 'document', NULL, ?, ?, ?, NULL, NULL, ?, NULL, 0, 1, ?, ?)`,
  );
  for (let i = 1; i <= 35; i += 1) {
    const id = `bounded-record-${String(i).padStart(3, "0")}`;
    const status = i === 1 ? "superseded" : "accepted";
    addRecord.run(
      id,
      projectId,
      id,
      `synthetic timeline record ${i}`,
      status,
      `dedup-${i}`,
      now,
      now,
      now,
      now,
      now,
    );
  }
  addRecord.run(
    "bounded-record-proposed",
    projectId,
    "bounded-record-proposed",
    "proposed must not appear",
    "proposed",
    "dedup-proposed",
    now,
    now,
    now,
    now,
    now,
  );
  addRecord.run(
    "bounded-record-rejected",
    projectId,
    "bounded-record-rejected",
    "rejected must not appear",
    "rejected",
    "dedup-rejected",
    now,
    now,
    now,
    now,
    now,
  );

  const addEvidence = sqlite.prepare(
    `INSERT INTO record_evidence (record_id, excerpt_id, relation, observed_at, environment, artifact_ref)
     VALUES (?, ?, 'supports', ?, 'synthetic', NULL)`,
  );
  for (let i = 1; i <= 5; i += 1) {
    addEvidence.run(
      `bounded-record-${String(i).padStart(3, "0")}`,
      `bounded-excerpt-${String(i).padStart(3, "0")}`,
      now,
    );
  }
  sqlite
    .prepare(
      `INSERT INTO supersessions (id, prior_record_id, replacement_record_id, job_id, reason, confirmed_at, confirmed_by, proposed_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'synthetic-owner', ?)`,
    )
    .run(
      "bounded-supersession",
      "bounded-record-001",
      "bounded-record-035",
      "synthetic correction",
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO conflicts (id, project_id, record_ids_json, status, resolution_record_id, created_at, updated_at)
     VALUES (?, ?, '[]', ?, NULL, ?, ?)`,
    )
    .run("bounded-conflict-unresolved", projectId, "unresolved", now, now);
  sqlite
    .prepare(
      `INSERT INTO conflicts (id, project_id, record_ids_json, status, resolution_record_id, created_at, updated_at)
     VALUES (?, ?, '[]', ?, NULL, ?, ?)`,
    )
    .run("bounded-conflict-resolved", projectId, "resolved", now, now);
  return { sourceId };
}

describe("R06 bounded reads", () => {
  it("traverses a same-timestamp timeline without omission, retains off-page supersession links, and bounds materialization", async () => {
    await withApp(async (t) => {
      const project = (
        await t.post("/api/projects", { name: "Synthetic bounded timeline" })
      ).json<{ id: string }>();
      installSyntheticReadFixture(t, project.id);

      const first = await t.get(`/api/projects/${project.id}/timeline?limit=7`);
      expectStatus(first, 200, "bounded timeline first page");
      const firstBody = first.json<any>();
      expect(firstBody.pagination).toMatchObject({
        limit: 7,
        total: 35,
        returned: 7,
        hasNext: true,
      });
      expect(firstBody.entries).toHaveLength(7);
      expect(firstBody.entries[0].record.evidence).toHaveLength(1);
      expect(firstBody.entries[0].supersededBy.recordId).toBe(
        "bounded-record-035",
      );

      const ids = [...firstBody.entries.map((entry: any) => entry.record.id)];
      let cursor = firstBody.pagination.nextCursor as string | null;
      while (cursor) {
        const page = await t.get(
          `/api/projects/${project.id}/timeline?limit=7&cursor=${encodeURIComponent(cursor)}`,
        );
        expectStatus(page, 200, "bounded timeline continuation");
        const body = page.json<any>();
        ids.push(...body.entries.map((entry: any) => entry.record.id));
        cursor = body.pagination.nextCursor;
      }
      expect(ids).toHaveLength(35);
      expect(new Set(ids).size).toBe(35);
      expect(ids).toEqual([...ids].sort());
      expect(ids).not.toContain("bounded-record-proposed");
      expect(ids).not.toContain("bounded-record-rejected");

      const beyond = await t.get(
        `/api/projects/${project.id}/timeline?limit=7&cursor=${encodeURIComponent(
          encodeReadCursor({
            version: 1,
            kind: "timeline",
            projectId: project.id,
            eventTime: "2026-01-01T00:00:00.000Z",
            recordId: "zzzz",
            contentVersion: 0,
          }),
        )}`,
      );
      expectStatus(beyond, 200, "bounded timeline beyond end");
      expect(beyond.json<any>().entries).toEqual([]);
      expect(beyond.json<any>().pagination).toMatchObject({
        total: 35,
        returned: 0,
        hasNext: false,
        nextCursor: null,
      });

      expectStatus(
        await t.get(
          `/api/projects/${project.id}/timeline?limit=7&cursor=not-a-cursor`,
        ),
        400,
        "invalid timeline cursor",
      );
    });
  });

  it("exposes a reset contract when canonical content changes during timeline traversal", async () => {
    await withApp(async (t) => {
      const project = (
        await t.post("/api/projects", { name: "Synthetic timeline snapshot" })
      ).json<{ id: string }>();
      installSyntheticReadFixture(t, project.id);
      const first = (
        await t.get(`/api/projects/${project.id}/timeline?limit=2`)
      ).json<any>();
      t.app.ck.handle.sqlite
        .prepare(
          "UPDATE projects SET content_version = content_version + 1 WHERE id=?",
        )
        .run(project.id);
      const next = await t.get(
        `/api/projects/${project.id}/timeline?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
      );
      expectStatus(next, 409, "changed timeline snapshot");
      expect(next.json<any>().error.code).toBe("timeline_snapshot_changed");
    });
  });

  it("paginates source excerpts with exact totals and filters conflicts in SQL", async () => {
    await withApp(async (t) => {
      const project = (
        await t.post("/api/projects", { name: "Synthetic bounded source" })
      ).json<{ id: string }>();
      const { sourceId } = installSyntheticReadFixture(t, project.id);
      const legacy = await t.get(`/api/sources/${sourceId}`);
      expectStatus(legacy, 200, "legacy source read");
      const legacyBody = legacy.json<any>();
      expect(legacyBody.source).toMatchObject({
        normalizedHash: "bounded-normalized-hash",
        excerptCount: 6,
      });
      expect(legacyBody.excerpts).toHaveLength(6);
      expect(legacyBody.pagination).toBeUndefined();
      const first = await t.get(`/api/sources/${sourceId}?limit=2`);
      expectStatus(first, 200, "bounded source first page");
      const firstBody = first.json<any>();
      expect(firstBody.source.excerptCount).toBe(6);
      expect(firstBody.pagination).toMatchObject({
        limit: 2,
        total: 6,
        returned: 2,
        hasNext: true,
      });
      const excerptIds = [
        ...firstBody.excerpts.map((excerpt: any) => excerpt.id),
      ];
      let cursor = firstBody.pagination.nextCursor as string | null;
      while (cursor) {
        const page = await t.get(
          `/api/sources/${sourceId}?limit=2&cursor=${encodeURIComponent(cursor)}`,
        );
        expectStatus(page, 200, "bounded source continuation");
        const body = page.json<any>();
        excerptIds.push(...body.excerpts.map((excerpt: any) => excerpt.id));
        cursor = body.pagination.nextCursor;
      }
      expect(excerptIds).toHaveLength(6);
      expect(new Set(excerptIds).size).toBe(6);
      expectStatus(
        await t.get(`/api/sources/${sourceId}?limit=2&cursor=not-a-cursor`),
        400,
        "invalid excerpt cursor",
      );

      const unresolved = await t.get("/api/conflicts?status=unresolved");
      expectStatus(unresolved, 200, "filtered conflicts");
      expect(
        unresolved
          .json<any[]>()
          .every((conflict) => conflict.status === "unresolved"),
      ).toBe(true);
      expect(unresolved.json<any[]>().map((conflict) => conflict.id)).toContain(
        "bounded-conflict-unresolved",
      );
      expect(
        unresolved.json<any[]>().map((conflict) => conflict.id),
      ).not.toContain("bounded-conflict-resolved");
    });
  });

  it("rejects a continuation when an excerpt is inserted before its cursor", async () => {
    await withApp(async (t) => {
      const project = (
        await t.post("/api/projects", { name: "Synthetic source insertion" })
      ).json<{ id: string }>();
      const { sourceId } = installSyntheticReadFixture(t, project.id);
      const first = (
        await t.get(`/api/sources/${sourceId}?limit=2`)
      ).json<any>();
      const sqlite = t.app.ck.handle.sqlite;
      sqlite
        .prepare(
          `INSERT INTO source_excerpts (id, source_id, start_offset, end_offset, exact_text, exact_text_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bounded-excerpt-000",
          sourceId,
          0,
          99,
          "inserted before cursor",
          "hash-inserted",
        );

      const next = await t.get(
        `/api/sources/${sourceId}?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
      );
      expectStatus(next, 409, "inserted excerpt changes snapshot");
      expect(next.json<any>().error.code).toBe(
        "source_excerpt_snapshot_changed",
      );
    });
  });

  it("rejects a continuation when excerpt content changes without changing the count", async () => {
    await withApp(async (t) => {
      const project = (
        await t.post("/api/projects", { name: "Synthetic source mutation" })
      ).json<{ id: string }>();
      const { sourceId } = installSyntheticReadFixture(t, project.id);
      const first = (
        await t.get(`/api/sources/${sourceId}?limit=2`)
      ).json<any>();
      const firstExcerptId = first.excerpts[0].id as string;
      const beforeCount = (
        t.app.ck.handle.sqlite
          .prepare(
            "SELECT count(*) AS n FROM source_excerpts WHERE source_id=?",
          )
          .get(sourceId) as { n: number }
      ).n;
      t.app.ck.handle.sqlite
        .prepare(
          "UPDATE source_excerpts SET exact_text=?, exact_text_hash=? WHERE id=?",
        )
        .run("mutated excerpt content", "hash-mutated", firstExcerptId);
      const afterCount = (
        t.app.ck.handle.sqlite
          .prepare(
            "SELECT count(*) AS n FROM source_excerpts WHERE source_id=?",
          )
          .get(sourceId) as { n: number }
      ).n;
      expect(afterCount).toBe(beforeCount);

      const next = await t.get(
        `/api/sources/${sourceId}?limit=2&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
      );
      expectStatus(next, 409, "mutated excerpt changes snapshot");
      expect(next.json<any>().error.code).toBe(
        "source_excerpt_snapshot_changed",
      );
    });
  });
});
