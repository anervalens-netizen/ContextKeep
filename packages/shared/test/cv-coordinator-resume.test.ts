import { describe, expect, it } from "vitest";
import { projectResumeContext, renderResumeText } from "../src/resume.js";

describe("CV independent review: resume fidelity", () => {
  it("preserves a checkpoint pointer and actionable recovery even when its body was budget-omitted", () => {
    const input = {
      project: { id: "project-fixture", name: "Fixture" },
      latestCheckpoint: { recordId: "checkpoint-fixture", revision: 4, recordedAt: "2026-09-24T10:00:00Z", status: "proposed", provenance: "agent_report", checkpoint: null, checkpointOmitted: true, recovery: { tool: "get_record", includeUnreviewed: true } },
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
      facts: { items: [{ recordId: "fact-fixture", text: "SQLite remains the single memory store.", status: "accepted", provenance: "owner_declaration" }] },
      currentState: { items: [{ recordId: "state-fixture", text: "Runtime release is abc123.", status: "accepted", provenance: "owner_declaration" }] },
    };
    const text = renderResumeText(projectResumeContext(input));
    expect(text).toContain("SQLite remains the single memory store.");
    expect(text).toContain("Runtime release is abc123.");
  });
  it("does not present stale selected rules as unqualified current truth", () => {
    const input = {
      project: { id: "project-fixture", name: "Fixture" },
      constraints: { items: [{ recordId: "rule-fixture", text: "Previously observed deployment constraint.", status: "accepted", provenance: "source_evidence", stale: true, requiresReview: true }] },
    };
    expect(renderResumeText(projectResumeContext(input))).toMatch(/stale|freshness|requires review/i);
  });
});

it("preserves the actual snapshot fetch time in copied cached context", () => {
  const text = renderResumeText(projectResumeContext({
    project: { id: "project-fixture", name: "Fixture" },
    cached: true,
    cachedAt: "2026-09-24T10:15:00.000Z",
  }));
  expect(text).toContain("fetchedAt=2026-09-24T10:15:00.000Z");
  expect(text).toContain("not live freshness");
});
