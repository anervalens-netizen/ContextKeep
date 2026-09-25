import type {
  AdapterExtractResult,
  AdapterUsage,
  ExtractionAdapter,
} from "@contextkeep/shared";

/**
 * PaidWithInvalidEstimate adapter — test-only adapter that DECLARES itself
 * `costCategory: "paid"` and returns an INVALID estimate: `estCostUsd = NaN`.
 *
 * The cost-ceiling pre-flight must refuse with 409 estimate_invalid + audit
 * `provider_call.estimate_invalid` BEFORE extract (the absence of a finite,
 * non-negative upper-bound estimate is exactly the bypass this regression
 * closes).
 *
 * NOT enabled by default in CK_ADAPTERS.
 */
export const paidWithInvalidEstimateAdapter: ExtractionAdapter = {
  id: "paid-with-invalid-estimate",
  version: "1.0.0",
  label: "PaidWithInvalidEstimate (test-only: costCategory=paid, estCostUsd=NaN)",
  costCategory: "paid",
  estimateUsage(): AdapterUsage {
    return {
      inputTokens: 100,
      outputTokens: 100,
      estCostUsd: Number.NaN,
      model: "test-invalid",
    };
  },
  extract: (): AdapterExtractResult => ({ candidates: [], usage: null }),
};
