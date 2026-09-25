import { describe, expect, it } from "vitest";
import { McpWorkContextResult, WorkingIndexDto, McpSearchResultDto } from "../src/dto.js";

describe("CK-A12 shared work-context contract", () => {
  it("validates the common REST/MCP/UI resume model including checkpoint revision and blocker state", () => {
    const section = {
      total: 1, returned: 1, omitted: 0, truncated: false,
      items: [{
        recordId: "11111111-1111-4111-8111-111111111111",
        revision: 2,
        subject: "guardrail",
        text: "Keep exact-head evidence.",
        status: "accepted",
        provenance: "owner_declaration",
        stale: false,
        requiresReview: false,
        evidenceCount: 0,
      }],
    };
    const parsed = McpWorkContextResult.parse({
      project: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "ContextKeep",
        revision: 15,
        contentVersion: 17,
        workingMemoryVersion: 47,
      },
      freshness: {
        canonicalCursor: 17,
        workingCursor: 47,
        canonical: { cursor: 17, status: "canonical" },
        working: { cursor: 47, status: "unreviewed_working_memory" },
      },
      goals: section,
      actions: { ...section, total: 0, returned: 0, items: [] },
      constraints: section,
      openQuestions: { ...section, total: 0, returned: 0, items: [] },
      workingMemory: { ...section, cursor: 47, items: section.items.map((item) => ({ ...item, status: "proposed", recordedAt: "2026-09-24T00:00:00Z" })) },
      latestCheckpoint: {
        recordId: "33333333-3333-4333-8333-333333333333",
        revision: 4,
        recordedAt: "2026-09-23T15:00:00.000Z",
        status: "proposed",
        provenance: "agent_report",
        checkpoint: { summary: "Resume here", nextAction: "Continue", artifactRefs: ["git:abc"] },
      },
      blockerState: {
        activeCount: 1,
        resolvedCount: 0,
        active: [{ blockerId: "b1", text: "Wait", checkpointRevision: 4 }],
      },
      indicators: { stale: false, blocked: true, truncated: false, unknown: [] },
      truncated: false,
    });
    expect(parsed.latestCheckpoint?.revision).toBe(4);
    expect(parsed.goals.items[0]?.recordId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.blockerState?.active[0]?.checkpointRevision).toBe(4);
  });

  it("fails closed when a record section loses its stable record identity", () => {
    const section = { total: 1, returned: 1, omitted: 0, truncated: false, items: [{ text: "missing id" }] };
    expect(() => McpWorkContextResult.shape.goals.parse(section)).toThrow();
  });
});

it("RC01/RC06 compact index requires a subject and search requires completeness", () => {
  const index = {recordId:"11111111-1111-4111-8111-111111111111",revision:1,status:"proposed",recordedAt:"2026-09-24"};
  expect(WorkingIndexDto.safeParse(index).success).toBe(false);
  expect(WorkingIndexDto.safeParse({...index,subject:"Capture title"}).success).toBe(true);
  expect(McpSearchResultDto.safeParse({query:"empty",scope:"canonical",records:[],canonicalRecords:[],workingRecords:[]}).success).toBe(false);
});
