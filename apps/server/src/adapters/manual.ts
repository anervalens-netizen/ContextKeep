import type { AdapterExtractResult, ExtractionAdapter } from "@contextkeep/shared";

/** Manual adapter: no extraction at all (handoff §8 step 4, M0 scope 11).
 * costCategory="free" because the adapter does NO provider work — there is
 * no possible cost to report, and the absence of estimateUsage is the
 * honest contract declaration for a zero-cost extractor. */
export const manualAdapter: ExtractionAdapter = {
  id: "manual",
  version: "1.0.0",
  label: "Manual (no extraction)",
  costCategory: "free",
  extract: (): AdapterExtractResult => ({ candidates: [], usage: null }),
};
