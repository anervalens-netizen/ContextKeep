import { describe, expect, it } from "vitest";
import { fitWorkContext } from "../src/services/context-budget.js";

function section(items: unknown[]): Record<string, unknown> {
  return {
    total: items.length,
    returned: items.length,
    omitted: 0,
    truncated: false,
    items,
  };
}

function record(
  recordId: string,
  status: "accepted" | "proposed" = "accepted",
): Record<string, unknown> {
  return {
    recordId,
    revision: 1,
    sourceType: "fact",
    subject: `subject-${recordId}`,
    text: "synthetic canonical continuity detail ".repeat(18),
    taskStatus: null,
    recordedAt: "2026-09-23T00:00:00.000Z",
    reviewedAt: null,
    status,
    provenance: status === "proposed" ? "agent_report" : "document",
    stale: false,
    requiresReview: status === "proposed",
    evidenceCount: 1,
    evidenceRefs: [
      {
        excerptId: `excerpt-${recordId}`,
        sourceId: "synthetic-source",
        relation: "supports",
      },
    ],
  };
}

function fixture(): Record<string, unknown> {
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Synthetic context project",
      lifecycle: "active",
      revision: 1,
      contentVersion: 4,
      workingMemoryVersion: 7,
    },
    freshness: {
      canonicalCursor: 4,
      workingCursor: 7,
      canonical: { cursor: 4, status: "current" },
      working: { cursor: 7, status: "current" },
    },
    goals: section([record("canonical-goal-1"), record("canonical-goal-2")]),
    actions: section([
      record("canonical-action-1"),
      record("canonical-action-2"),
    ]),
    constraints: section([
      record("canonical-constraint-1"),
      record("canonical-constraint-2"),
      record("canonical-constraint-3"),
    ]),
    facts: section([record("canonical-fact-1"), record("canonical-fact-2")]),
    currentState: section([record("canonical-state-1")]),
    workingMemory: {
      ...section([
        record("working-pointer-1", "proposed"),
        record("working-pointer-2", "proposed"),
        record("working-pointer-3", "proposed"),
      ]),
      cursor: 7,
    },
    recentWork: section([
      record("working-detail-1", "proposed"),
      record("working-detail-2", "proposed"),
    ]),
    recentHandoffs: section([record("handoff-1")]),
    latestCheckpoint: {
      recordId: "working-pointer-1",
      revision: 1,
      recordedAt: "2026-09-23T00:00:00.000Z",
      status: "proposed",
      provenance: "agent_report",
      checkpoint: {
        summary: "synthetic checkpoint",
        nextAction: "continue synthetic verification",
        artifactRefs: ["synthetic-ref"],
      },
    },
    indicators: { stale: false, truncated: false, unknown: [] },
    truncated: false,
  };
}

describe("context packing evaluation", () => {
  it("keeps canonical authority and a useful unreviewed pointer at the same hard budget", () => {
    const budget = 9_000;
    const result = fitWorkContext(fixture(), budget);
    const serialized = JSON.stringify(result);
    const constraints = result.constraints as {
      items: Record<string, unknown>[];
    };
    const working = result.workingMemory as {
      items: Record<string, unknown>[];
      omitted: number;
      recovery?: unknown;
    };

    expect(serialized.length).toBeLessThanOrEqual(budget);
    expect(constraints.items.map((item) => item.recordId)).toEqual([
      "canonical-constraint-1",
      "canonical-constraint-2",
      "canonical-constraint-3",
    ]);
    expect(
      constraints.items.every(
        (item) => item.status === "accepted" && item.provenance === "document",
      ),
    ).toBe(true);
    expect(
      constraints.items.every(
        (item) =>
          item.detailOmittedForBudget === true &&
          (item.recovery as { tool?: string }).tool === "get_record",
      ),
    ).toBe(true);
    expect(working.items.map((item) => item.recordId)).toEqual([
      "working-pointer-1",
    ]);
    expect(working.items[0]).toMatchObject({
      status: "proposed",
      provenance: "agent_report",
      requiresReview: true,
    });
    expect((working.items[0]!.evidenceRefs as unknown[]).length).toBe(1);
    expect(working.omitted).toBe(2);
    expect(working.recovery).toEqual({
      tool: "search_context",
      scope: "working",
    });
    expect(result.latestCheckpoint).toMatchObject({
      checkpoint: { artifactRefs: ["synthetic-ref"] },
    });
  });
});
