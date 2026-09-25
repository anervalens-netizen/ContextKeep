import type {
  AdapterCandidate,
  AdapterExtractResult,
  AdapterUsage,
  AdapterUsageEstimate,
  ExtractionAdapter,
} from "@contextkeep/shared";

/**
 * AsyncTest adapter — deterministic, test-only async adapter (handoff §12
 * item 13 readiness).
 *
 * Designed to PROVE that an async adapter can be plugged into the import
 * pipeline without any further architectural change. Both `estimateUsage`
 * and `extract` return real Promises (resolved on a microtask + setImmediate
 * hop so the awaiting code path is genuinely exercised). No network calls.
 *
 * Trigger prefixes:
 *   async-usage-estimate: input=N output=M cost=K model=<name>
 *       → reported via estimateUsage() as AdapterUsage. Drives cost ceiling.
 *   async-actual-usage: input=N output=M cost=K model=<name>\n *       → reported by extract() as actual provider usage for budget tests.\n *   async-fact: <text>
 *       → emitted as a fact candidate with `volatile: true` (so the M2.4b
 *         A11 plumbing is exercised end-to-end on top of the async path).
 *   async-decision: <text>
 *       → emitted as a decision candidate.
 *
 * Test-only: enabled via `CK_ADAPTERS=manual,faketest,asynctest` (or just
 * `asynctest` in isolation). The default production CK_ADAPTERS does NOT
 * include `asynctest`; the registry's `get(id)` audit refuses it otherwise
 * (A21). This file ships in source for the architectural-contract proof,
 * not as a production extractor.
 */
export const asyncTestAdapter: ExtractionAdapter = {
  id: "asynctest",
  version: "1.0.0",
  label: "AsyncTest (deterministic async adapter for M2.4d contract proof)",
  // costCategory='free': this adapter does NO real provider work — it parses
  // text and produces canned candidates. The absence of an estimate (no
  // 'usage-estimate:' line in the input) means "no cost" and is permitted by
  // the contract. When an estimate line IS present the cost-ceiling check
  // still applies (universal for any non-null estimateUsage result).
  costCategory: "free",

  async estimateUsage({ excerpts }): Promise<AdapterUsageEstimate> {
    // Force the awaiting code path through at least one microtask + one
    // setImmediate tick so the test exercises a genuinely-async handoff,
    // not a sync function returning Promise.resolve(...).
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    let usage: AdapterUsage | null = null;
    for (const ex of excerpts) {
      for (const rawLine of ex.text.split("\n")) {
        const line = rawLine.trim();
        const m = /^async-usage-estimate:\s*input=(\d+)\s+output=(\d+)\s+cost=([0-9]+(?:\.[0-9]+)?)\s*(?:model=(\S+))?\s*$/i.exec(
          line,
        );
        if (m) {
          usage = {
            inputTokens: Number.parseInt(m[1]!, 10),
            outputTokens: Number.parseInt(m[2]!, 10),
            estCostUsd: Number.parseFloat(m[3]!),
            model: m[4] ?? "asynctest-model-v1",
          };
        }
      }
    }
    return usage;
  },

  async extract({ excerpts, eventAt }): Promise<AdapterExtractResult> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const out: AdapterCandidate[] = [];
    let actualUsage: AdapterUsage | null = null;
    for (const ex of excerpts) {
      for (const rawLine of ex.text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let m: RegExpExecArray | null;
        if ((m = /^async-actual-usage:\s*input=(\d+)\s+output=(\d+)\s+cost=([0-9]+(?:\.[0-9]+)?)\s*(?:model=(\S+))?\s*$/i.exec(line))) {
          actualUsage = {
            inputTokens: Number.parseInt(m[1]!, 10),
            outputTokens: Number.parseInt(m[2]!, 10),
            estCostUsd: Number.parseFloat(m[3]!),
            model: m[4] ?? "asynctest-model-v1",
          };
        } else if ((m = /^async-fact:\s*(.+)$/i.exec(line))) {
          out.push({
            type: "fact",
            subject: "asynctest-fact",
            predicate: null,
            valueJson: null,
            text: m[1]!,
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: eventAt ?? null,
            excerptId: ex.id,
            relation: "supports",
            confidence: 0.9,
            volatile: true, // exercise A11 plumbing on the async path too
          });
        } else if ((m = /^async-decision:\s*(.+)$/i.exec(line))) {
          out.push({
            type: "decision",
            subject: "asynctest-decision",
            predicate: null,
            valueJson: null,
            text: m[1]!,
            evidenceBasis: "agent_report",
            taskStatus: null,
            sourceEventAt: eventAt ?? null,
            excerptId: ex.id,
            relation: "supports",
            confidence: 0.92,
            volatile: false,
          });
        }
      }
    }
    return { candidates: out, usage: actualUsage };
  },
};
