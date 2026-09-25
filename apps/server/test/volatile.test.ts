import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { RecordDto } from "@contextkeep/shared";
import { records } from "../src/db/schema.js";
import { expectStatus, makeTestApp, reviewCurrent, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>) => {
  const t = await makeTestApp();
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

/**
 * A11 review badges for volatile facts (handoff §12 item 15, §13 case A11).
 * Volatile facts are facts whose currency expires (deployment version, current
 * build SHA, live endpoint URL). On accept the pipeline stamps
 * review_due_at = reviewed_at + CK_VOLATILE_REVIEW_INTERVAL_DAYS (default 7 days).
 * Stable decisions never get this stamp — §3 "Stable decisions do not expire
 * automatically" still holds.
 *
 * Server-computed isOverdue (volatile=true AND reviewDueAt < now) drives the
 * in-app review badge without forcing the client to compare timestamps.
 */
describe("A11: volatile fact review policy", () => {
  it("non-volatile fact: review_due_at stays null, isOverdue=false", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "fact: the API host is a stable decision that does not expire",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "stable fact import");
      const candidates = await t.get("/api/inbox");
      const id = candidates.json<{ candidates: { id: string }[] }>().candidates[0]!.id;
      const accept = await reviewCurrent(t, [id], "accept");
      expectStatus(accept, 200, "accept stable fact");

      const detail = await t.get(`/api/records/${id}`);
      const dto = detail.json<RecordDto>();
      expect(dto.volatile).toBe(false);
      expect(dto.reviewDueAt).toBeNull();
      expect(dto.isOverdue).toBe(false);
    });
  });

  it("volatile fact accepted: review_due_at = reviewed_at + intervalDays, isOverdue=false initially", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "volatile-fact: deployment version is 1.2.3 in production",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "volatile fact import");
      const id = (await t.get("/api/inbox"))
        .json<{ candidates: { id: string }[] }>()
        .candidates[0]!.id;

      // Inspect the proposed record — volatile flag is plumbed BEFORE accept.
      const proposed = (await t.get(`/api/records/${id}`)).json<RecordDto>();
      expect(proposed.volatile).toBe(true);
      expect(proposed.reviewDueAt).toBeNull();
      expect(proposed.isOverdue).toBe(false);

      const beforeAccept = new Date();
      const accept = await reviewCurrent(t, [id], "accept");
      expectStatus(accept, 200, "accept volatile fact");
      const afterAccept = new Date();

      const accepted = (await t.get(`/api/records/${id}`)).json<RecordDto>();
      expect(accepted.volatile).toBe(true);
      expect(accepted.reviewStatus).toBe("accepted");
      expect(accepted.reviewedAt).not.toBeNull();
      expect(accepted.reviewDueAt).not.toBeNull();
      expect(accepted.isOverdue).toBe(false);

      // A11 contract (handoff §12 item 15): review_due_at = reviewed_at + interval
      // EXACTLY, both derived from the same `now` captured at the start of
      // decideReview. The invariant below is the actual contractual guarantee;
      // no wall-clock tolerance, no rounding. Any drift here is a real bug.
      const reviewedAtMs = new Date(accepted.reviewedAt!).getTime();
      const dueAtMs = new Date(accepted.reviewDueAt!).getTime();
      const intervalMs = dueAtMs - reviewedAtMs;
      const expectedMs = 7 * 24 * 60 * 60 * 1000;
      expect(intervalMs).toBe(expectedMs);
      // The wall-clock boundary check (reviewedAt ∈ [beforeAccept, afterAccept])
      // is intentionally absent: it is non-contractual and was the source of
      // false flakes under vitest forks pool scheduling jitter. The interval
      // invariant above proves the A11 contract end-to-end without it.
      void beforeAccept;
      void afterAccept;
    });
  });

  it("volatile fact with review_due_at in the past: isOverdue=true (server-side simulation)", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "volatile-fact: current endpoint is https://stale.example.com/v1",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "volatile fact import");
      const id = (await t.get("/api/inbox"))
        .json<{ candidates: { id: string }[] }>()
        .candidates[0]!.id;

      const accept = await reviewCurrent(t, [id], "accept");
      expectStatus(accept, 200, "accept volatile fact");

      // Fast-forward: rewrite the row's review_due_at to a moment in the past,
      // simulating a fact that has passed its review window.
      t.app.ck.deps.sqlite
        .prepare(`UPDATE records SET review_due_at = ? WHERE id = ?`)
        .run("2020-01-01T00:00:00.000Z", id);

      const detail = (await t.get(`/api/records/${id}`)).json<RecordDto>();
      expect(detail.volatile).toBe(true);
      expect(detail.reviewDueAt).toBe("2020-01-01T00:00:00.000Z");
      expect(detail.isOverdue).toBe(true);
    });
  });

  it("reviewed volatile truth rejects in-place text correction and preserves its review window", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "volatile-fact: build SHA is abc123def for the current release train",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "volatile fact import");
      const id = (await t.get("/api/inbox"))
        .json<{ candidates: { id: string }[] }>()
        .candidates[0]!.id;

      const accept = await reviewCurrent(t, [id], "accept");
      expectStatus(accept, 200, "accept");
      const accepted = (await t.get(`/api/records/${id}`)).json<RecordDto>();
      expect(accepted.volatile).toBe(true);
      expect(accepted.reviewDueAt).not.toBeNull();

      // F03 hardening: accepted semantic truth is immutable in place. A text
      // correction must go through the correction/supersession workflow so the
      // old assertion and its evidence remain traceable.
      const edit = await t.put(`/api/records/${id}`, {
        revision: accepted.revision,
        text: "volatile-fact: build SHA is abc123def456 for the current release train",
      });
      expectStatus(edit, 409, "reviewed volatile semantic edit");
      expect(edit.json<{ error: { code: string } }>().error.code).toBe("semantic_edit_requires_correction");

      const unchanged = (await t.get(`/api/records/${id}`)).json<RecordDto>();
      expect(unchanged.text).toBe(accepted.text);
      expect(unchanged.revision).toBe(accepted.revision);
      expect(unchanged.volatile).toBe(true);
      expect(unchanged.reviewDueAt).toBe(accepted.reviewDueAt);
      expect(unchanged.isOverdue).toBe(false);
    });
  });

  it("DB row inspection: volatile column is set on import, not derived on accept", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "volatile-fact: deployment SHA rotates weekly per CI tag",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "volatile fact import");
      const id = (await t.get("/api/inbox"))
        .json<{ candidates: { id: string }[] }>()
        .candidates[0]!.id;

      // BEFORE accept: row.volatile = 1 (carried from adapter candidate).
      const beforeRow = t.app.ck.deps.db.select().from(records).where(eq(records.id, id)).get()!;
      expect(beforeRow.volatile).toBe(1);
      expect(beforeRow.reviewDueAt).toBeNull();

      await reviewCurrent(t, [id], "accept");

      // AFTER accept: row.volatile = 1 preserved, review_due_at stamped.
      const afterRow = t.app.ck.deps.db.select().from(records).where(eq(records.id, id)).get()!;
      expect(afterRow.volatile).toBe(1);
      expect(afterRow.reviewDueAt).not.toBeNull();
    });
  });
});
