import { describe,expect,it } from "vitest";
import heldout from "../src/evals/ai-memory-heldout.json" with { type: "json" };
import { runHeldoutEval,validateHeldoutCorpus } from "../src/evals/ai-memory-heldout.js";

describe("A5.3/A5.4 independent held-out evaluation",()=>{
  it("keeps the held-out corpus independent, representative and executable",async()=>{
    expect(()=>validateHeldoutCorpus()).not.toThrow();
    expect(heldout.length).toBeGreaterThanOrEqual(30);
    const report=await runHeldoutEval();
    expect(report.corpus.caseCount).toBe(heldout.length);
    expect(report.providerCalls).toBe(0);
    expect(report.metrics.dependency.caseCount).toBeGreaterThanOrEqual(8);
    expect(["PILOT_WARRANTED","CLOSED_NOT_NEEDED"]).toContain(report.gates.semanticRetrieval);
    expect(["PILOT_WARRANTED","CLOSED_NOT_NEEDED"]).toContain(report.gates.explicitRelations);
  },30000);
});
