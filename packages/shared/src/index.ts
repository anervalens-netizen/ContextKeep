export * from "./enums.js";
export * from "./dto.js";
export * from "./install-gate.js";
export * from "./workspace.js";
export * from "./codex.js";
export * from "./dsh.js";
export * from "./sync.js";
export * from "./resume.js";

/**
 * Application schema version — A17: refuse to start on a newer-version store.
 *
 * M4.6 bumps 6 → 7 for the durable mapping between a ContextKeep chat,
 * an exact owner-linked workspace binding and the Codex thread reused there.
 * Future persistent schema migrations MUST bump this constant so older builds
 * refuse the newer store.
 */
export const APP_SCHEMA_VERSION = 16;

/** Adapter registry contract (handoff §8 step 4, M0 scope 11). */
export interface ExtractionAdapter {
  readonly id: string;
  readonly version: string;
  /** Human label; M0 ships manual + faketest only. */
  readonly label: string;
  /**
   * Cost category. Paid adapters (the default) must report estimated usage via
   * `estimateUsage()` so the cost ceiling can be enforced before extraction.
   * Free adapters explicitly declare "free" (zero-cost by contract, e.g. the
   * Manual adapter) and may omit `estimateUsage`. Paid adapters without
   * `estimateUsage` are refused with `409 estimate_required` (see
   * runImport); the absence of an estimate MUST NOT mean automatic "zero cost"
   * for paid adapters (handoff §12 item 13 readiness invariant).
   */
  readonly costCategory?: "free" | "paid" | "subscription";
  /**
   * Produce candidate records from normalized excerpts.
   * A20: adapters must never emit evidenceBasis "owner_declaration";
   * the pipeline downgrades any such attempt to "agent_report".
   *
   * M2.4e directive §7: returns AdapterExtractResult so usage is bound
   * to the request, not module-global state. Concurrent imports cannot
   * cross-contaminate usage/evidence. Adapters without usage tracking
   * (manual, faketest, asynctest) return `usage: null`.
   */
  extract(input: AdapterExtractInput): Promise<AdapterExtractResult> | AdapterExtractResult;
  /**
   * Optional: report estimated provider usage BEFORE extraction runs, so the
   * pipeline can refuse over-budget imports (handoff §12 item 13). Returning
   * `null` means "no provider cost" for this call — no ceiling check is
   * applied. Adapters that DO implement this MUST keep the reported usage
   * consistent with what the subsequent `extract()` call would actually cost
   * (or lower it; never higher).
   */
  estimateUsage?(input: AdapterExtractInput): Promise<AdapterUsageEstimate> | AdapterUsageEstimate;
}

/**
 * Request-scoped extract result (M2.4e directive §7). Providers return
 * candidates AND usage from a SINGLE invocation so concurrent imports
 * cannot cross-contaminate usage/evidence state. The optional
 * `AdapterUsage` carries input/output/reasoning tokens when the provider
 * reports them (subscription/metered). For `costCategory='free'`
 * adapters usage is typically null.
 */
export interface AdapterExtractResult {
  candidates: AdapterCandidate[];
  usage: AdapterUsage | null;
}

export interface AdapterExtractInput {
  sourceId: string;
  projectId: string | null;
  authorLabel: string | null;
  eventAt: string | null;
  excerpts: { id: string; text: string; startOffset: number; endOffset: number }[];
}

export interface AdapterCandidate {
  type: "fact" | "decision" | "action" | "constraint" | "question";
  subject: string;
  predicate?: string | null;
  valueJson?: unknown | null;
  text: string;
  evidenceBasis: "owner_declaration" | "agent_report" | "document" | "observed_technical";
  taskStatus?: "open" | "in_progress" | "blocked" | "done" | "cancelled" | null;
  sourceEventAt?: string | null;
  excerptId: string;
  relation?: "supports" | "contradicts";
  confidence?: number | null;
  /** A11: mark this candidate as volatile (its currency expires). Default false. */
  volatile?: boolean;
}

/**
 * Adapter-reported usage metadata (handoff §12 item 13).
 * Optional: only adapters with an associated provider cost emit this.
 * Reported values are adapter estimates, NOT post-hoc measurements.
 */
export interface AdapterUsage {
  /** Tokens billed for the input (or null when not token-priced). */
  inputTokens: number | null;
  /** Tokens billed for the output (or null when not token-priced). */
  outputTokens: number | null;
  /** Estimated cost in USD for this call. Pipeline enforces the configured ceiling against this. */
  estCostUsd: number;
  /** Provider model identifier (e.g. "gpt-4o-mini"); null for non-model adapters. */
  model: string | null;
}

/** Adapter estimate result. `null` means "no usage reported" — pipeline skips the ceiling check. */
export type AdapterUsageEstimate = AdapterUsage | null;
