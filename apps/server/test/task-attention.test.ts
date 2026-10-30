import { describe, expect, it } from "vitest";
import { classifyTaskAttention, type AttentionInput } from "../src/services/task-attention.js";

const base: AttentionInput = { state: "blocked", lifecycle: "active", blockerCounts: { blocking: 0, verification: 0, deferred: 1, legacy: 0 }, liveExecutions: 0, verificationRequired: 0, invalidEvidence: 0, reconciliationNeeded: 0, followUp: false, followUpAction: false, ownerAction: false };
describe("task attention categories", () => {
  it("treats exclusively deferred blockers as deferred, but mixed and unknown blocked states remain actionable", () => {
    expect(classifyTaskAttention(base)).toMatchObject({ needsAttention: false, items: expect.arrayContaining([expect.objectContaining({ reason: "blocked_state", category: "deferred", requiresAction: false })]) });
    expect(classifyTaskAttention({ ...base, blockerCounts: { ...base.blockerCounts, blocking: 1 } }).needsAttention).toBe(true);
    expect(classifyTaskAttention({ ...base, blockerCounts: { blocking: 0, verification: 0, deferred: 0, legacy: 0 } }).needsAttention).toBe(true);
    expect(classifyTaskAttention({ ...base, blockerCounts: { ...base.blockerCounts, legacy: 1 } }).needsAttention).toBe(true);
  });
  it.each(["paused", "retired"])("suppresses routine work in %s but never uncertainty", lifecycle => {
    const input = { ...base, lifecycle, blockerCounts: { ...base.blockerCounts, blocking: 1 } };
    expect(classifyTaskAttention(input).needsAttention).toBe(false);
    for (const field of ["liveExecutions", "verificationRequired", "invalidEvidence", "reconciliationNeeded"] as const)
      expect(classifyTaskAttention({ ...input, [field]: 1 }).needsAttention).toBe(true);
  });
  it("distinguishes informational and actionable follow-up", () => {
    const input = { ...base, state: "done", blockerCounts: { blocking: 0, verification: 0, deferred: 0, legacy: 0 }, followUp: true };
    expect(classifyTaskAttention(input).needsAttention).toBe(false);
    expect(classifyTaskAttention({ ...input, followUpAction: true }).needsAttention).toBe(true);
  });
});
