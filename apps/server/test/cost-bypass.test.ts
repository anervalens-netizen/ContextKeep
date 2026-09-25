import { describe, expect, it } from "vitest";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

/**
 * M2.4d cleanup §1 — paid-adapter cost bypass closure.
 *
 * Canonical invariants:
 *   costCategory === "paid":
 *     - estimateUsage MUST exist;
 *     - result MUST be non-null;
 *     - estCostUsd MUST be finite and >= 0;
 *     - estimate MUST be a conservative pre-flight upper bound;
 *     - upper bound > configured ceiling → refuse BEFORE extract;
 *     - null / invalid estimate → refuse BEFORE extract.
 *   costCategory === "free":
 *     - estimateUsage MAY be omitted;
 *     - result MAY be null (treated as zero cost).
 *
 * The regressions below exercise every branch.
 */
describe("M2.4d cleanup §1: paid-adapter cost bypass closure", () => {
  it("paid + missing estimateUsage → 409 estimate_required, extract NOT called", async () => {
    const t = await makeTestApp({ adapters: "manual,paid-no-estimate" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "paid-no-estimate does not implement estimateUsage; no real extract() body to call",
        adapterId: "paid-no-estimate",
      });
      expectStatus(res, 409, "paid + missing method refused");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("estimate_required");

      // Audit row.
      const audit = await t.get("/api/audit?action=provider_call.estimate_required");
      const events = audit.json<{ targetId: string }[]>();
      expect(events.some((e) => e.targetId === "paid-no-estimate")).toBe(true);

      // No candidates created (refusal happened before extract).
      const inbox = await t.get("/api/inbox");
      expect(
        inbox.json<{ candidates: { text: string }[] }>().candidates.some((c) =>
          c.text.includes("paid-no-estimate does not implement"),
        ),
      ).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  it("paid + method returning null → 409 estimate_required, extract NOT called", async () => {
    const t = await makeTestApp({ adapters: "manual,paid-with-null-estimate" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "any input — adapter returns null from estimateUsage and never extracts",
        adapterId: "paid-with-null-estimate",
      });
      expectStatus(res, 409, "paid + null estimate refused");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("estimate_required");

      // Audit row written.
      const audit = await t.get("/api/audit?action=provider_call.estimate_required");
      const events = audit.json<{ targetId: string; detail: { reason: string } }[]>();
      const evt = events.find((e) => e.targetId === "paid-with-null-estimate");
      expect(evt).toBeDefined();
      expect(evt!.detail.reason).toMatch(/null/i);

      // No candidates (extract was never called — the adapter body is []).
      const inbox = await t.get("/api/inbox");
      expect(inbox.json<{ candidates: unknown[] }>().candidates).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("paid + NaN estCostUsd → 409 estimate_invalid, extract NOT called", async () => {
    const t = await makeTestApp({ adapters: "manual,paid-with-invalid-estimate" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "any input — adapter returns estCostUsd=NaN which is not a finite non-negative number",
        adapterId: "paid-with-invalid-estimate",
      });
      expectStatus(res, 409, "paid + NaN refused");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("estimate_invalid");

      // Audit row written.
      const audit = await t.get("/api/audit?action=provider_call.estimate_invalid");
      const events = audit.json<{ targetId: string }[]>();
      expect(events.some((e) => e.targetId === "paid-with-invalid-estimate")).toBe(true);

      // No candidates (extract was never called).
      const inbox = await t.get("/api/inbox");
      expect(inbox.json<{ candidates: unknown[] }>().candidates).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("paid + valid under ceiling → extract IS called (candidates persisted)", async () => {
    const t = await makeTestApp({ adapters: "manual,asynctest" });
    try {
      const res = await t.post("/api/imports/text", {
        text: [
          "async-usage-estimate: input=200 output=100 cost=0.0200 model=asynctest-model-v1",
          "",
          "async-fact: paid adapter passed the cost ceiling check; extract should run",
        ].join("\n"),
        adapterId: "asynctest",
      });
      expectStatus(res, 201, "paid + under ceiling → extract ran");
      const preview = res.json<{ candidateCount: number; providerUsage: { estCostUsd: number } | null; costCeilingUsd: number }>();
      expect(preview.candidateCount).toBe(1);
      expect(preview.providerUsage).not.toBeNull();
      expect(preview.providerUsage!.estCostUsd).toBeCloseTo(0.02, 6);
      expect(preview.costCeilingUsd).toBe(0.05);
      // Cost ceiling invariant for the success path:
      //   actual billable cost ≤ preflight upper-bound estimate ≤ configured ceiling
      expect(preview.providerUsage!.estCostUsd).toBeLessThanOrEqual(preview.costCeilingUsd);
    } finally {
      await t.cleanup();
    }
  });

  it("paid + over ceiling → 409 cost_ceiling_exceeded, extract NOT called", async () => {
    const t = await makeTestApp({ adapters: "manual,asynctest" });
    try {
      const res = await t.post("/api/imports/text", {
        text: [
          "async-usage-estimate: input=4000 output=2000 cost=0.1000 model=asynctest-model-v1",
          "",
          "async-fact: should never reach the inbox — over the ceiling",
        ].join("\n"),
        adapterId: "asynctest",
      });
      expectStatus(res, 409, "paid + over ceiling refused");
      const body = res.json<{ error: { code: string; details: { estCostUsd: number; ceilingUsd: number } } }>();
      expect(body.error.code).toBe("cost_ceiling_exceeded");
      expect(body.error.details!.estCostUsd).toBeCloseTo(0.1, 6);
      expect(body.error.details!.ceilingUsd).toBe(0.05);

      // Audit row written.
      const audit = await t.get("/api/audit?action=provider_call.cost_ceiling_exceeded");
      expect(audit.json<unknown[]>().length).toBeGreaterThan(0);

      // No candidates (extract was never called — refused before).
      const inbox = await t.get("/api/inbox");
      expect(inbox.json<{ candidates: { text: string }[] }>().candidates.some((c) =>
        c.text.includes("should never reach the inbox"),
      )).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  it("free + no estimate (manual adapter, no estimateUsage method) → allowed, 201, 0 candidates", async () => {
    const t = await makeTestApp();
    try {
      const res = await t.post("/api/imports/text", {
        text: "decision: owner manually enters a fact via Manual adapter",
        adapterId: "manual",
      });
      expectStatus(res, 201, "free + no estimate allowed");
      const preview = res.json<{ candidateCount: number; providerUsage: unknown; costCeilingUsd: number; jobId: string }>();
      expect(preview.candidateCount).toBe(0); // Manual adapter extracts nothing
      expect(preview.providerUsage).toBeNull();
      expect(preview.costCeilingUsd).toBe(0.05);

      // Job reflects free adapter (no model, no provider usage).
      const job = (await t.get(`/api/imports/jobs/${preview.jobId}`)).json<{
        adapterId: string;
        providerModel: string | null;
        providerUsage: unknown;
      }>();
      expect(job.adapterId).toBe("manual");
      expect(job.providerModel).toBeNull();
      expect(job.providerUsage).toBeNull();
    } finally {
      await t.cleanup();
    }
  });
});
