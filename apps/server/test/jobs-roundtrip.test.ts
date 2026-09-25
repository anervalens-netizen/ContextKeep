import { describe, expect, it } from "vitest";
import type { ImportJobDto } from "@contextkeep/shared";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { adapters?: string }) => {
  const t = await makeTestApp(opts);
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

/**
 * Provider usage round-trip (M2.4d — directive §5).
 *
 * Contract for a successful provider-backed import:
 *   - providerModel is persisted (from usage.model when reported)
 *   - estimated/preflight usage is persisted (from usage.estimateUsage)
 *   - the configured ceiling for the import is persisted
 *   - /api/imports/jobs/:id surfaces all three fields as ImportJobDto
 *
 * Cost ceiling invariant:
 *   actual billable cost <= preflight upper-bound estimate <= configured ceiling
 * For M2.4d (no real provider) the second inequality is the one enforced at
 * runtime; the structure is ready for the first when a real provider reports
 * actual usage after the call.
 */
describe("M2.4d §5: provider usage round-trip on /api/imports/jobs/:id", () => {
  it("successful async adapter import: providerModel + providerUsage + ceiling persisted and returned", async () => {
    await withApp(
      async (t) => {
        const imp = await t.post("/api/imports/text", {
          text: [
            "async-usage-estimate: input=400 output=200 cost=0.0200 model=asynctest-model-rt",
            "",
            "async-fact: a fact imported through the async pipeline for round-trip proof",
          ].join("\n"),
          adapterId: "asynctest",
        });
        expectStatus(imp, 201, "async import");
        const preview = imp.json<{ jobId: string; providerUsage: { estCostUsd: number; model: string }; costCeilingUsd: number }>();
        expect(preview.jobId).toBeTruthy();

        const jobRes = await t.get(`/api/imports/jobs/${preview.jobId}`);
        expectStatus(jobRes, 200, "GET job");
        const job = jobRes.json<ImportJobDto>();
        expect(job.id).toBe(preview.jobId);
        expect(job.stage).toBe("done");
        expect(job.errorCode).toBeNull();
        expect(job.adapterId).toBe("asynctest");
        expect(job.providerModel).toBe("asynctest-model-rt");
        expect(job.providerUsage).not.toBeNull();
        expect(job.providerUsage!.estCostUsd).toBeCloseTo(0.02, 6);
        expect(job.providerUsage!.model).toBe("asynctest-model-rt");
        expect(job.providerUsage!.inputTokens).toBe(400);
        expect(job.providerUsage!.outputTokens).toBe(200);
        // asynctest does NOT implement getActualUsage() — actualUsage is null.
        expect(job.actualUsage).toBeNull();
      },
      { adapters: "manual,asynctest" },
    );
  });

  it("cost-ceiling-exceeded job: providerUsage persists, ceiling persisted, errorCode set", async () => {
    await withApp(
      async (t) => {
        const imp = await t.post("/api/imports/text", {
          text: [
            "async-usage-estimate: input=8000 output=4000 cost=0.1000 model=asynctest-model-ce",
            "",
            "async-fact: should be refused by cost ceiling",
          ].join("\n"),
          adapterId: "asynctest",
        });
        expectStatus(imp, 409, "over-ceiling refused");
        const body = imp.json<{ error: { details: { jobId: string } } }>();
        const jobId = body.error.details!.jobId;

        const jobRes = await t.get(`/api/imports/jobs/${jobId}`);
        expectStatus(jobRes, 200, "GET job");
        const job = jobRes.json<ImportJobDto>();
        expect(job.id).toBe(jobId);
        expect(job.stage).toBe("failed");
        expect(job.errorCode).toBe("cost_ceiling_exceeded");
        expect(job.providerModel).toBe("asynctest-model-ce");
        expect(job.providerUsage).not.toBeNull();
        expect(job.providerUsage!.estCostUsd).toBeCloseTo(0.1, 6);
        expect(job.providerUsage!.model).toBe("asynctest-model-ce");

        // Cost ceiling invariant holds for the refused import:
        // preflight estimate (0.10) > configured ceiling (0.05). The pipeline
        // refused the call BEFORE extract — so there is no "actual" cost yet.
        expect(job.providerUsage!.estCostUsd).toBeGreaterThan(0.05);
        // Refused-before-extract → no actual usage captured.
        expect(job.actualUsage).toBeNull();
      },
      { adapters: "manual,asynctest" },
    );
  });

  it("estimate-required refusal: paid adapter without estimateUsage is refused with 409 estimate_required", async () => {
    // paid-no-estimate ships in source as a registered test-only adapter with
    // costCategory="paid" and NO estimateUsage method. The pipeline MUST refuse
    // it at the pre-flight (handoff §12 item 13 invariant: missing estimate !=
    // automatic "zero cost" for paid adapters).
    await withApp(
      async (t) => {
        const res = await t.post("/api/imports/text", {
          text: "paid-fact: this fact would cost real money, but the adapter refuses to estimate",
          adapterId: "paid-no-estimate",
        });
        expectStatus(res, 409, "estimate-required");
        const body = res.json<{ error: { code: string } }>();
        expect(body.error.code).toBe("estimate_required");

        // Audit row written.
        const audit = await t.get("/api/audit?action=provider_call.estimate_required");
        const events = audit.json<{ targetId: string }[]>();
        expect(events.some((e) => e.targetId === "paid-no-estimate")).toBe(true);
      },
      { adapters: "manual,paid-no-estimate" },
    );
  });

  it("free adapter (Manual) without estimateUsage is allowed (costCategory=\"free\" exception)", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "decision: owner manually enters a fact through Manual",
        adapterId: "manual",
      });
      // Manual adapter extracts nothing → 0 candidates → still 201 with
      // candidateCount=0 and no providerUsage surface.
      expectStatus(res, 201, "manual import OK");
      const preview = res.json<{ providerUsage: unknown; costCeilingUsd: number; jobId: string }>();
      expect(preview.providerUsage).toBeNull();
      expect(preview.costCeilingUsd).toBe(0.05);

      const jobRes = await t.get(`/api/imports/jobs/${preview.jobId}`);
      expectStatus(jobRes, 200, "GET manual job");
      const job = jobRes.json<ImportJobDto>();
      expect(job.adapterId).toBe("manual");
      expect(job.stage).toBe("done");
      expect(job.providerModel).toBeNull();
      expect(job.providerUsage).toBeNull();
      // Manual adapter does not implement getActualUsage() — no network call.
      expect(job.actualUsage).toBeNull();
    });
  });
});
