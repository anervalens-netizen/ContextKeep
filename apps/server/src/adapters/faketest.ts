import type {
  AdapterCandidate,
  AdapterExtractResult,
  AdapterUsage,
  AdapterUsageEstimate,
  ExtractionAdapter,
} from "@contextkeep/shared";

/**
 * FakeTest adapter: deterministic canned output for pipeline tests (handoff §8).
 * Recognizes line prefixes:
 *   fact: / decision: / action: / question: / constraint:
 *   status: done — <text>      -> agent-reported completion (A22: stays proposed)
 *   owner-claim: <text>        -> deliberately emits evidenceBasis owner_declaration
 *                                 to prove the pipeline clamps it (A20)
 *   observed: <text>           -> observed_technical evidence (A4 scenarios)
 *   usage-estimate: input=N output=M cost=K model=<name>
 *                               -> reports AdapterUsage via estimateUsage
 *                                  so the cost-ceiling contract is testable
 *                                  without a real provider (handoff §12 item 13).
 * No network access, no provider keys, fully deterministic.
 */
export const fakeTestAdapter: ExtractionAdapter = {
  id: "faketest",
  version: "1.0.0",
  label: "FakeTest (deterministic canned output)",
  // costCategory='free': FakeTest does NO real provider work — it parses text
  // and produces canned candidates. The absence of an 'usage-estimate:' line
  // means "no cost" and is permitted. When an estimate line IS present the
  // cost-ceiling check still applies (universal for any non-null estimateUsage
  // result). See directive §1 (paid-adapter cost bypass closure).
  costCategory: "free",
  estimateUsage({ excerpts }): AdapterUsageEstimate {
    let usage: AdapterUsage | null = null;
    for (const ex of excerpts) {
      for (const rawLine of ex.text.split("\n")) {
        const line = rawLine.trim();
        const m = /^usage-estimate:\s*input=(\d+)\s+output=(\d+)\s+cost=([0-9]+(?:\.[0-9]+)?)\s*(?:model=(\S+))?\s*$/i.exec(
          line,
        );
        if (m) {
          usage = {
            inputTokens: Number.parseInt(m[1]!, 10),
            outputTokens: Number.parseInt(m[2]!, 10),
            estCostUsd: Number.parseFloat(m[3]!),
            model: m[4] ?? "fake-test-v1",
          };
        }
      }
    }
    return usage;
  },
  extract({ excerpts, eventAt }): AdapterExtractResult {
    const out: AdapterCandidate[] = [];
    for (const ex of excerpts) {
      for (const rawLine of ex.text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        let m: RegExpExecArray | null;
        if ((m = /^fact:\s*(.+)$/i.exec(line))) {
          out.push(base(ex.id, eventAt, "fact", "faketest-fact", m[1]!, "document", 0.91));
        } else if ((m = /^decision:\s*(.+)$/i.exec(line))) {
          out.push(
            base(ex.id, eventAt, "decision", "faketest-decision", m[1]!, "agent_report", 0.93),
          );
        } else if ((m = /^action:\s*(.+)$/i.exec(line))) {
          out.push({
            ...base(ex.id, eventAt, "action", "faketest-action", m[1]!, "agent_report", 0.9),
            taskStatus: "open",
          });
        } else if ((m = /^question:\s*(.+)$/i.exec(line))) {
          out.push(
            base(ex.id, eventAt, "question", "faketest-question", m[1]!, "document", 0.88),
          );
        } else if ((m = /^constraint:\s*(.+)$/i.exec(line))) {
          out.push(
            base(ex.id, eventAt, "constraint", "faketest-constraint", m[1]!, "document", 0.89),
          );
        } else if ((m = /^status:\s*done\s*[—–-]\s*(.+)$/iu.exec(line))) {
          out.push({
            ...base(
              ex.id,
              eventAt,
              "action",
              "faketest-agent-report",
              m[1]!,
              "agent_report",
              0.5,
            ),
            taskStatus: "done",
          });
        } else if ((m = /^owner-claim:\s*(.+)$/i.exec(line))) {
          // A20 probe: adapters must never produce owner-confirmed labels;
          // the import pipeline clamps this to agent_report.
          out.push(
            base(
              ex.id,
              eventAt,
              "fact",
              "faketest-owner-claim-probe",
              m[1]!,
              "owner_declaration",
              0.4,
            ),
          );
        } else if ((m = /^observed:\s*(.+)$/i.exec(line))) {
          out.push(
            base(
              ex.id,
              eventAt,
              "fact",
              "faketest-observation",
              m[1]!,
              "observed_technical",
              0.7,
            ),
          );
        } else if ((m = /^volatile-fact:\s*(.+)$/i.exec(line))) {
          // A11 probe: volatile fact — its currency expires, so the pipeline
          // stamps review_due_at = reviewed_at + intervalDays on accept.
          out.push({
            ...base(ex.id, eventAt, "fact", "faketest-volatile-fact", m[1]!, "document", 0.91),
            volatile: true,
          });
        }
      }
    }
    return { candidates: out, usage: null };
  },
};

function base(
  excerptId: string,
  sourceEventAt: string | null,
  type: AdapterCandidate["type"],
  subject: string,
  text: string,
  evidenceBasis: AdapterCandidate["evidenceBasis"],
  confidence: number,
): AdapterCandidate {
  return {
    type,
    subject,
    predicate: null,
    valueJson: null,
    text,
    evidenceBasis,
    taskStatus: null,
    sourceEventAt: sourceEventAt ?? null,
    excerptId,
    relation: "supports",
    confidence,
  };
}
