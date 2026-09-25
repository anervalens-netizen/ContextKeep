import { describe, expect, it } from "vitest";
import { runContextValueResumeEval } from "../src/evals/context-value-resume.js";

describe("CV11 honest presentation comparison", () => {
  it("freezes the actual old copy behavior including its existing checkpoint pointer and next action", () => {
    const report = runContextValueResumeEval();
    expect(report.baselineSha).toBe("c3551f5ab38c0d4b71f111be7ffb16716961f231");
    expect(report.cases.find((c) => c.id === "resume-omitted-pointer")?.baselineRetained).toBe(1);
    expect(report.cases.find((c) => c.id === "resume-ro-checkpoint")?.baselineRetained).toBe(2);
    expect(report.scope).toBe("presentation_fidelity_not_retrieval_benchmark");
    expect(report.providerCalls).toBe(0);
  });
  it("scores missing record reads separately rather than copying current results into the baseline", () => {
    const report = runContextValueResumeEval();
    const english = report.cases.find((c) => c.id === "resume-en-current-history")!;
    expect(english.baselineEstimatedAdditionalReads).toBe(2);
    expect(english.estimatedAdditionalReads).toBe(0);
    const omitted = report.cases.find((c) => c.id === "resume-omitted-pointer")!;
    expect(omitted.baselineEstimatedAdditionalReads).toBe(1);
    expect(omitted.estimatedAdditionalReads).toBe(1);
    expect(omitted.omissionRecoveryVisible).toBe(true);
    expect(omitted.baselineOmissionRecoveryVisible).toBe(false);
  });
  it("compares RO and EN presentation at explicit equal ceilings, without claiming token equivalence", () => {
    const report = runContextValueResumeEval();
    expect(report.cases.map((c) => c.language)).toEqual(["en", "en", "ro", "en"]);
    for (const c of report.cases) {
      expect(c.currentRetained).toBeGreaterThanOrEqual(c.baselineRetained);
      expect(c.budgetChecks.map((b) => b.budget)).toEqual([4000, 6000, 9500]);
      expect(c.budgetChecks.every((b) => b.bothFit)).toBe(true);
    }
  });
});
