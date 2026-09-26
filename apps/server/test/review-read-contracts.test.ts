import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { records } from "../src/db/schema.js";
import { createRecord } from "../src/services/memory-management.js";
import {
  attachProjectNames,
  loadRecordFreshnessContext,
} from "../src/services/mappers.js";
import { decideReview } from "../src/services/review.js";
import { makeTestApp } from "./helpers.js";

describe("GitHub review read contracts", () => {
  it("loads only page-relevant freshness observations and conflicts", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const project = await t.post("/api/projects", {
        name: "Synthetic freshness page",
      });
      const projectId = project.json<{ id: string }>().id;
      const source = await t.post("/api/imports/text", {
        projectId,
        adapterId: "manual",
        text: "synthetic freshness evidence",
      });
      const sourceId = source.json<any>().source.id as string;
      const sourceExcerptId = (
        t.app.ck.handle.sqlite
          .prepare(
            "SELECT id FROM source_excerpts WHERE source_id=? ORDER BY start_offset,id LIMIT 1",
          )
          .get(sourceId) as { id: string }
      ).id;
      const context = { actor: "test:review-read", requestId: null };
      const create = (input: {
        subject: string;
        text: string;
        evidenceBasis: "document" | "agent_report";
        sourceEventAt: string;
      }) =>
        createRecord(
          t.app.ck.deps,
          {
            projectId,
            sourceExcerptId,
            recordType: "fact",
            subject: input.subject,
            text: input.text,
            predicate: "status",
            valueJson: null,
            evidenceBasis: input.evidenceBasis,
            sourceEventAt: input.sourceEventAt,
            taskStatus: null,
            volatile: false,
          },
          context,
        ).record;

      const accepted = create({
        subject: "api-gateway",
        text: "api-gateway green",
        evidenceBasis: "document",
        sourceEventAt: "2026-01-01T00:00:00.000Z",
      });
      const acceptedResult = decideReview(
        t.app.ck.deps,
        {
          items: [{ recordId: accepted.id, revision: accepted.revision }],
          action: "accept",
          edits: {},
          ownerAction: true,
        },
        context,
      );
      expect(acceptedResult.accepted).toEqual([accepted.id]);

      const relevant = create({
        subject: "api-gateway",
        text: "api-gateway blue",
        evidenceBasis: "agent_report",
        sourceEventAt: "2026-01-02T00:00:00.000Z",
      });
      const unrelatedIds: string[] = [];
      for (let i = 0; i < 80; i += 1) {
        const unrelated = create({
          subject: `unrelated-service-${i}`,
          text: `unrelated-service-${i} blue`,
          evidenceBasis: "agent_report",
          sourceEventAt: "2026-01-03T00:00:00.000Z",
        });
        unrelatedIds.push(unrelated.id);
      }
      const addConflict = t.app.ck.handle.sqlite.prepare(
        `INSERT INTO conflicts
          (id, project_id, record_ids_json, status, resolution_record_id, created_at, updated_at)
         VALUES (?, ?, ?, 'unresolved', NULL, ?, ?)`,
      );
      for (const [index, recordId] of unrelatedIds.entries()) {
        addConflict.run(
          `unrelated-conflict-${index}`,
          projectId,
          JSON.stringify([recordId]),
          "2026-01-03T00:00:00.000Z",
          "2026-01-03T00:00:00.000Z",
        );
      }

      const acceptedRow = t.app.ck.deps.db
        .select()
        .from(records)
        .where(eq(records.id, accepted.id))
        .get()!;
      const freshnessContext = loadRecordFreshnessContext(
        t.app.ck.deps.db,
        [acceptedRow],
        "2026-01-04T00:00:00.000Z",
      );
      expect(freshnessContext.workingRecords.map((row) => row.id)).toEqual([
        relevant.id,
      ]);
      expect(freshnessContext.conflicts).toEqual([]);

      const dto = attachProjectNames(
        t.app.ck.deps.db,
        [acceptedRow],
        new Map(),
      )[0]!;
      expect(dto.freshness).toMatchObject({
        currentness: "needs_verification",
        stale: true,
        requiresReview: true,
        reasons: ["newer_observation"],
        supportRecordIds: [relevant.id],
      });
    } finally {
      await t.cleanup();
    }
  });
});
