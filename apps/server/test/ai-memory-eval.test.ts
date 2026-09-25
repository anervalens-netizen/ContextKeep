import { describe, expect, it } from "vitest";
import {
  AI_MEMORY_CORPUS,
  runAiMemoryEval,
  validateAiMemoryCorpus,
} from "../src/evals/ai-memory-harness.js";

describe("A5.2 AI-memory evaluation harness", () => {
  it("has a representative synthetic RO/EN corpus and stable shape invariants", async () => {
    expect(() => validateAiMemoryCorpus()).not.toThrow();
    expect(AI_MEMORY_CORPUS.length).toBeGreaterThanOrEqual(40);

    const report = await runAiMemoryEval();
    expect(report.baseline).toBe(true);
    expect(report.evaluation).toBe("A5.2");
    expect(report.providerCalls).toBe(0);
    expect(report.resumeQuality.providerCalls).toBe(0);
    expect(report.resumeQuality.cases.map((item) => item.language)).toEqual(["en", "en", "ro", "en"]);
    expect(report.resumeQuality.current.essentialsRetained).toBeGreaterThanOrEqual(report.resumeQuality.baseline.essentialsRetained);
    expect(report.resumeQuality.current.currentness).toBeGreaterThanOrEqual(report.resumeQuality.baseline.currentness);
    expect(report.resumeQuality.cases.find((item) => item.id === "resume-omitted-pointer")?.omissionRecoveryVisible).toBe(true);
    expect(report.metrics.toolCallsProxy.providerCalls).toBe(0);
    expect(report.corpus.caseCount).toBe(AI_MEMORY_CORPUS.length);
    expect(report.corpus.languageCounts.ro).toBeGreaterThan(0);
    expect(report.corpus.languageCounts.en).toBeGreaterThan(0);
    expect(report.fixture.recordCount).toBeGreaterThanOrEqual(30);
    expect(report.fixture.workingMemoryCount).toBeGreaterThan(0);
    expect(report.fixture.intentionallyUnbackedRecordIds).toEqual(["eval-unbacked"]);
    expect(report.cases).toHaveLength(AI_MEMORY_CORPUS.length);
    expect(new Set(report.cases.map((testCase) => testCase.id)).size).toBe(report.cases.length);
    expect(report.cases.every((testCase) => Number.isFinite(testCase.contextBytes))).toBe(true);
    expect(report.cases.every((testCase) => Number.isFinite(testCase.retrievalLatencyMs))).toBe(true);

    const exactSha = report.cases.find((testCase) => testCase.id === "A5.1-EXACT-01");
    expect(exactSha?.top10RecordIds).toContain("eval-release-current");
    expect(exactSha?.top10RecordIds).not.toContain("eval-release-old");

    const workingMemory = report.cases.find((testCase) => testCase.id === "A5.1-WORK-01");
    expect(workingMemory?.top10RecordIds).not.toContain("eval-working-next");

    const missing = report.cases.find((testCase) => testCase.id === "A5.1-ABSTAIN-01");
    expect(missing?.observedAbstention).toBe(true);
    expect(missing?.synthesisStatus).toBe("unknown");

    const unbacked = report.cases.find((testCase) => testCase.id === "A5.1-ABSTAIN-04");
    expect(unbacked?.synthesisStatus).toBe("unknown");
    expect(unbacked?.evidenceCoverage).toBe(0);

    // The original A5.1 numbers remain available as a frozen before
    // comparator, while the AI-first path evaluates explicit working scope.
    expect(report.legacyBaseline.metrics.recallAt10.value).toBe(0.6182);
    expect(report.legacyBaseline.metrics.currentness.rate).toBe(0.5);
    expect(report.legacyBaseline.metrics.abstention.rate).toBe(0.5);
    expect(report.aiFirst.metrics.recallAt10.value).toBeGreaterThanOrEqual(0.95);
    expect(report.aiFirst.metrics.exactIdentifierRecallAt10.value).toBe(1);
    expect(report.aiFirst.metrics.currentness.rate).toBeGreaterThanOrEqual(0.95);
    expect(report.aiFirst.metrics.evidenceCoverageEligible.value).toBe(1);
    expect(report.aiFirst.metrics.abstention.rate).toBeGreaterThanOrEqual(0.95);
    expect(report.aiFirst.metrics.localLatencyMs.p95).toBeLessThan(75);
    expect(report.aiFirst.thresholdEvaluation.meetsAllMeasuredThresholds).toBe(true);

    const aiWorkingMemory = report.aiFirst.cases.find((testCase) => testCase.id === "A5.1-WORK-01");
    expect(aiWorkingMemory?.retrievalScope).toBe("working");
    expect(aiWorkingMemory?.top10RecordIds).toContain("eval-working-next");
    expect(aiWorkingMemory?.top10RecordIds).not.toContain("eval-next-en");

    for (const id of ["A5.1-ABSTAIN-02", "A5.1-ABSTAIN-05", "A5.1-RO-ABSTAIN-01"]) {
      const result = report.aiFirst.cases.find((testCase) => testCase.id === id);
      expect(result?.observedAbstention, id).toBe(true);
      expect(result?.synthesisStatus, id).toBe("unknown");
    }
  });
});
