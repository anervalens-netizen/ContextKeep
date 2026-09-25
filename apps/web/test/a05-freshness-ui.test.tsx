import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RecordDto } from "@contextkeep/shared";
import { RecordCard } from "../src/components/RecordCard.js";

afterEach(cleanup);

function record(overrides: Partial<RecordDto> = {}): RecordDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectName: "Freshness Demo",
    type: "fact",
    subject: "backend api",
    predicate: "status",
    valueJson: null,
    text: "Backend API status is healthy.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
    sourceEventAt: "2026-01-01T00:00:00.000Z",
    effectiveFrom: null,
    effectiveTo: null,
    reviewedAt: "2026-01-01T00:00:00.000Z",
    reviewDueAt: null,
    volatile: false,
    isOverdue: false,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    evidence: [],
    freshness: {
      authority: "canonical",
      currentness: "current",
      progress: null,
      provenance: "document",
      stale: false,
      requiresReview: false,
      reasons: [],
      supportRecordIds: [],
      possiblyRelatedRecordIds: [],
    },
    ...overrides,
  };
}

describe("CK-A05 freshness UI", () => {
  it("renders explicit verification/conflict state from the shared freshness DTO", () => {
    const needsVerification = record({
      freshness: {
        authority: "canonical",
        currentness: "needs_verification",
        progress: null,
        provenance: "document",
        stale: true,
        requiresReview: true,
        reasons: ["newer_observation"],
        supportRecordIds: ["33333333-3333-4333-8333-333333333333"],
        possiblyRelatedRecordIds: [],
      },
    });
    const { rerender } = render(<RecordCard record={needsVerification} />);
    expect(screen.getByTestId("record-freshness-badge").textContent).toMatch(/Needs verification/i);

    expect(screen.getByRole("link", {name:"Inspect supporting record 1"}).getAttribute("href")).toContain("recordId=33333333-3333-4333-8333-333333333333");
    expect(screen.getByRole("link", {name:"Review record"}).getAttribute("href")).toContain(needsVerification.id);

    rerender(<RecordCard record={record({
      freshness: {
        authority: "canonical",
        currentness: "conflicted",
        progress: null,
        provenance: "document",
        stale: true,
        requiresReview: true,
        reasons: ["explicit_conflict"],
        supportRecordIds: ["44444444-4444-4444-8444-444444444444"],
        possiblyRelatedRecordIds: [],
      },
    })} />);
    expect(screen.getByTestId("record-freshness-badge").textContent).toMatch(/Conflict/i);
  });

  it("does not label a blocked action as stale merely because progress is blocked", () => {
    render(<RecordCard record={record({
      type: "action",
      taskStatus: "blocked",
      freshness: {
        authority: "canonical",
        currentness: "not_applicable",
        progress: "blocked",
        provenance: "document",
        stale: false,
        requiresReview: false,
        reasons: [],
        supportRecordIds: [],
        possiblyRelatedRecordIds: [],
      },
    })} />);
    expect(screen.queryByTestId("record-freshness-badge")).toBeNull();
    expect(screen.getByText("blocked", { exact: false })).toBeTruthy();
  });
});
