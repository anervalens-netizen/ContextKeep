import { describe, expect, it } from "vitest";
import { projectResumeContext, renderResumeText } from "../src/resume.js";

describe("CV independent review: resume fidelity", () => {
  it("preserves a checkpoint pointer and actionable recovery even when its body was budget-omitted", () => {
    const input = {
      project: { id: "project-fixture", name: "Fixture" },
      latestCheckpoint: {
        recordId: "checkpoint-fixture",
        revision: 4,
        recordedAt: "2026-09-24T10:00:00Z",
        status: "proposed",
        provenance: "agent_report",
        checkpoint: null,
        checkpointOmitted: true,
        recovery: { tool: "get_record", includeUnreviewed: true },
      },
      indicators: { truncated: true },
    };
    const text = renderResumeText(projectResumeContext(input));
    expect(text).toContain("checkpoint-fixture");
    expect(text).toMatch(/proposed|unreviewed/i);
    expect(text).toMatch(/checkpoint.*omitted|omitted.*checkpoint/i);
  });
  it("keeps selected canonical facts and current state in the resume rather than silently dropping them", () => {
    const input = {
      project: { id: "project-fixture", name: "Fixture" },
      facts: {
        items: [
          {
            recordId: "fact-fixture",
            text: "SQLite remains the single memory store.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
      currentState: {
        items: [
          {
            recordId: "state-fixture",
            text: "Runtime release is abc123.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
    };
    const text = renderResumeText(projectResumeContext(input));
    expect(text).toContain("SQLite remains the single memory store.");
    expect(text).toContain("Runtime release is abc123.");
  });
  it("does not present stale selected rules as unqualified current truth", () => {
    const input = {
      project: { id: "project-fixture", name: "Fixture" },
      constraints: {
        items: [
          {
            recordId: "rule-fixture",
            text: "Previously observed deployment constraint.",
            status: "accepted",
            provenance: "source_evidence",
            stale: true,
            requiresReview: true,
          },
        ],
      },
    };
    expect(renderResumeText(projectResumeContext(input))).toMatch(
      /stale|freshness|requires review/i,
    );
  });
});

it("preserves the actual snapshot fetch time in copied cached context", () => {
  const text = renderResumeText(
    projectResumeContext({
      project: { id: "project-fixture", name: "Fixture" },
      cached: true,
      cachedAt: "2026-09-24T10:15:00.000Z",
    }),
  );
  expect(text).toContain("fetchedAt=2026-09-24T10:15:00.000Z");
  expect(text).toContain("not live freshness");
});

it("preserves an explicit null next action instead of reviving a checkpoint action", () => {
  const base = {
    project: { id: "project-fixture", name: "Fixture" },
    latestCheckpoint: {
      recordId: "checkpoint-fixture",
      revision: 2,
      recordedAt: "2026-10-03T10:00:00Z",
      status: "proposed" as const,
      provenance: "agent_report",
      checkpoint: { nextAction: "OBSOLETE STEP" },
    },
  };
  expect(
    projectResumeContext({ ...base, latestNextAction: null }).nextAction,
  ).toBeNull();
  expect(projectResumeContext(base).nextAction).toBe("OBSOLETE STEP");
});

it("uses the resume capsule when legacy pointers were omitted for budget", () => {
  const project = { id: "project-fixture", name: "Fixture" };
  expect(
    projectResumeContext({
      project,
      latestNextAction: null,
      resumePointersOmittedForBudget: true,
      resumeCapsule: { nextAction: "Continue verified work" },
    }).nextAction,
  ).toBe("Continue verified work");
  expect(
    projectResumeContext({
      project,
      resumeCapsule: { nextAction: "Continue from capsule" },
    }).nextAction,
  ).toBe("Continue from capsule");
  expect(
    projectResumeContext({
      project,
      latestNextAction: null,
      resumePointersOmittedForBudget: true,
      resumeCapsule: { nextAction: null },
    }).nextAction,
  ).toBeNull();
});

it("preserves and renders a budgeted post-closure follow-up from the resume capsule", () => {
  const projection = projectResumeContext({
    project: { id: "project-fixture", name: "Fixture" },
    latestNextAction: null,
    resumePointersOmittedForBudget: true,
    resumeCapsule: {
      nextAction: null,
      followUp: {
        checkpointRecordId: "follow-up-fixture",
        nextAction: null,
        summary: "Reconcile the later checkpoint.",
        recordedAt: "2026-10-04T10:00:00.000Z",
        provenance: "agent_report",
        detailOmittedForBudget: true,
        recovery: {
          tool: "get_record",
          recordId: "follow-up-fixture",
          includeUnreviewed: true,
        },
      },
    },
  });
  expect(projection.followUp).toMatchObject({
    checkpointRecordId: "follow-up-fixture",
    nextAction: null,
    summary: "Reconcile the later checkpoint.",
  });
  const text = renderResumeText(projection);
  expect(text).toContain("Post-closure follow-up");
  expect(text).toContain("follow-up-fixture");
  expect(text).toContain("Reconcile the later checkpoint.");
  expect(text).toContain("Follow-up action: none");
  expect(text).toContain("RECOVERY:");
});
