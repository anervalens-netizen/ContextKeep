import type {
  AdapterCandidate,
  AdapterExtractResult,
  ExtractionAdapter,
} from "@contextkeep/shared";

/**
 * PaidNoEstimate adapter — deterministic, test-only adapter that DECLARES
 * itself paid (costCategory="paid") but does NOT implement estimateUsage.
 *
 * Registered in the source registry so that the pipeline can exercise the
 * `estimate_required` refusal path (handoff §12 item 13 readiness): a paid
 * adapter that does not report usage cannot be safely called — the
 * absence of an estimate MUST NOT mean automatic "zero cost". NOT enabled
 * by default in CK_ADAPTERS; tests opt in via
 * `makeTestApp({ adapters: "manual,paid-no-estimate" })`.
 *
 * Not a real provider; ships in source for the missing-estimate contract proof.
 */
export const paidNoEstimateAdapter: ExtractionAdapter = {
  id: "paid-no-estimate",
  version: "1.0.0",
  label: "PaidNoEstimate (test-only: costCategory=paid, no estimateUsage — proves refusal)",
  costCategory: "paid",
  extract({ excerpts, eventAt }): AdapterExtractResult {
    const out: AdapterCandidate[] = [];
    for (const ex of excerpts) {
      for (const rawLine of ex.text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = /^paid-fact:\s*(.+)$/i.exec(line);
        if (m) {
          out.push({
            type: "fact",
            subject: "paid-no-estimate-fact",
            predicate: null,
            valueJson: null,
            text: m[1]!,
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: eventAt ?? null,
            excerptId: ex.id,
            relation: "supports",
            confidence: 0.9,
          });
        }
      }
    }
    return { candidates: out, usage: null };
  },
};
