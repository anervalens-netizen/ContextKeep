import type { AdapterExtractResult, ExtractionAdapter } from "@contextkeep/shared";

/**
 * PaidWithNullEstimate adapter — test-only adapter that DECLARES itself
 * `costCategory: "paid"` but returns null from `estimateUsage`.
 *
 * NOT enabled by default in CK_ADAPTERS. Ships in source so the
 * `paid + method returning null → refused` regression can be exercised
 * end-to-end (the cost-ceiling pre-flight refuses with 409 estimate_required
 * BEFORE extract, with audit `provider_call.estimate_required`).
 */
export const paidWithNullEstimateAdapter: ExtractionAdapter = {
  id: "paid-with-null-estimate",
  version: "1.0.0",
  label: "PaidWithNullEstimate (test-only: costCategory=paid, estimateUsage returns null)",
  costCategory: "paid",
  estimateUsage: () => null,
  extract: (): AdapterExtractResult => ({ candidates: [], usage: null }),
};
