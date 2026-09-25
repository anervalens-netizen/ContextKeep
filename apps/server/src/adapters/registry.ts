import type { ExtractionAdapter } from "@contextkeep/shared";
import { asyncTestAdapter } from "./asynctest.js";
import { deepseekAdapter } from "./deepseek.js";
import { fakeTestAdapter } from "./faketest.js";
import { manualAdapter } from "./manual.js";
import { minimaxAdapter } from "./minimax.js";
import { openaiAdapter } from "./openai.js";
import { paidNoEstimateAdapter } from "./paid-no-estimate.js";
import { paidWithInvalidEstimateAdapter } from "./paid-with-invalid-estimate.js";
import { paidWithNullEstimateAdapter } from "./paid-with-null-estimate.js";

/**
 * Adapter registry (handoff §8 step 4, M0 scope 11).
 * M0 ships ONLY manual + faketest: no provider adapters, no keys, no network.
 * A14: with no provider enabled, zero provider calls are possible.
 * A21: attempting to call a disabled/unknown adapter throws AND is audit-logged
 * by the caller (import service).
 *
 * M2.5 (owner decision):
 *  - PRIMARY extraction provider is `deepseek` / "deepseek-flash" (= DeepSeek
 *    V4.1 Flash, official API) with thinking enabled and reasoning_effort=max.
 *  - `minimax` (M2.4e primary) is kept registered as DISABLED fallback/history.
 *  - `openai` is registered as a fallback (M2.4d) but kept DISABLED in
 *    production CK_ADAPTERS by default. Enabling it requires OPENAI_API_KEY.
 *  - There is NO silent fallback: a failing DeepSeek call fails the import.
 *
 * Test-only adapters (paid-no-estimate, paid-with-null-estimate,
 * paid-with-invalid-estimate, asynctest) ship in source for the M2.4d
 * paid-adapter contract proofs; not enabled by default in production.
 */
export const allAdapters: Record<string, ExtractionAdapter> = {
  manual: manualAdapter,
  faketest: fakeTestAdapter,
  asynctest: asyncTestAdapter,
  "paid-no-estimate": paidNoEstimateAdapter,
  "paid-with-null-estimate": paidWithNullEstimateAdapter,
  "paid-with-invalid-estimate": paidWithInvalidEstimateAdapter,
  deepseek: deepseekAdapter,
  minimax: minimaxAdapter,
  openai: openaiAdapter,
};

export class AdapterDisabledError extends Error {
  readonly code = "adapter_disabled";
  constructor(
    readonly adapterId: string,
    reason: "unknown_adapter" | "disabled_adapter",
  ) {
    super(
      reason === "unknown_adapter"
        ? `Unknown extraction adapter "${adapterId}". No provider adapters ship in M0; provider calls are refused (A14/A21).`
        : `Extraction adapter "${adapterId}" is disabled in CK_ADAPTERS; call refused (A21).`,
    );
    this.name = "AdapterDisabledError";
  }
}

export interface AdapterRegistry {
  enabledIds(): string[];
  /** Throws AdapterDisabledError for unknown or disabled adapters. */
  get(id: string): ExtractionAdapter;
  list(): { id: string; label: string; version: string; enabled: boolean }[];
}

export function createAdapterRegistry(enabled: string[]): AdapterRegistry {
  const enabledSet = new Set(enabled);
  return {
    enabledIds: () => [...enabledSet],
    get(id: string): ExtractionAdapter {
      const adapter = allAdapters[id];
      if (!adapter) throw new AdapterDisabledError(id, "unknown_adapter");
      if (!enabledSet.has(id)) throw new AdapterDisabledError(id, "disabled_adapter");
      return adapter;
    },
    list: () =>
      Object.values(allAdapters).map((a) => ({
        id: a.id,
        label: a.label,
        version: a.version,
        enabled: enabledSet.has(a.id),
      })),
  };
}
