import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SearchRecordDto } from "@contextkeep/shared";
import { RecordCard } from "../src/components/RecordCard.js";

afterEach(cleanup);

const taskId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const progressId = "33333333-3333-4333-8333-333333333333";
const recordedAt = "2026-01-01T00:00:00.000Z";

function taskState(overrides: Partial<NonNullable<SearchRecordDto["taskState"]>> = {}): NonNullable<SearchRecordDto["taskState"]> {
  return {
    effectiveState: "done",
    stateSource: "reported_progress",
    progress: {
      recordId: progressId, recordedAt, taskRevision: 1, status: "done",
      reviewStatus: "proposed", evidenceBasis: "agent_report",
    },
    stateProvenance: {
      recordId: progressId, recordedAt, reviewStatus: "proposed", evidenceBasis: "agent_report",
    },
    resume: { tool: "resume_task", projectId, taskId },
    ...overrides,
  };
}

function record(overrides: Partial<SearchRecordDto> = {}): SearchRecordDto {
  return {
    id: taskId, projectId, projectName: "Search state demo", type: "action",
    subject: "Synthetic task", predicate: null, valueJson: null, text: "Inspect the synthetic task.",
    reviewStatus: "accepted", evidenceBasis: "owner_declaration", taskStatus: "blocked",
    recordedAt, sourceEventAt: null, effectiveFrom: null, effectiveTo: null,
    reviewedAt: recordedAt, reviewDueAt: null, volatile: false, isOverdue: false,
    revision: 1, createdAt: recordedAt, updatedAt: recordedAt, evidence: [],
    taskState: taskState(), ...overrides,
  };
}

describe("search effective task state", () => {
  it("shows reported completion with its own proposed provenance and preserves the task record status", () => {
    render(<RecordCard record={record()} />);
    const state = screen.getByTestId("effective-task-state");
    expect(within(state).getByText("done")).toBeTruthy();
    expect(within(state).queryByText("blocked")).toBeNull();
    const provenance = screen.getByTestId("task-state-provenance");
    expect(within(provenance).getByText("Effective state from progress report.")).toBeTruthy();
    expect(within(provenance).getByText("proposed")).toBeTruthy();
    expect(within(provenance).getByText("agent report")).toBeTruthy();
    expect(within(provenance).queryByText("accepted")).toBeNull();
    expect(within(provenance).getByText("Task record status: blocked.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inspect state source" }).getAttribute("href"))
      .toBe(`/projects/${projectId}?recordId=${progressId}`);
    expect(within(provenance).getByText("report recorded 2026-01-01")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a terminal task state while making later follow-up evidence inspectable", () => {
    render(<RecordCard record={record({
      taskStatus: "done",
      taskState: taskState({
        effectiveState: "done", stateSource: "task_record",
        stateProvenance: { recordId: taskId, recordedAt, reviewStatus: "accepted", evidenceBasis: "owner_declaration" },
        progress: { recordId: progressId, recordedAt, taskRevision: 1, status: "open", reviewStatus: "proposed", evidenceBasis: "agent_report" },
      }),
    })} />);
    expect(within(screen.getByTestId("effective-task-state")).getByText("done")).toBeTruthy();
    expect(screen.getByText("Effective state from task record.")).toBeTruthy();
    expect(screen.getByText("task updated 2026-01-01")).toBeTruthy();
    expect(screen.getByText("Latest progress: open.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inspect latest progress" }).getAttribute("href"))
      .toBe(`/projects/${projectId}?recordId=${progressId}`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows unknown state without inventing a source or an evidence link", () => {
    render(<RecordCard record={record({
      taskStatus: null,
      taskState: taskState({ effectiveState: "unknown", stateSource: "unknown", stateProvenance: null, progress: null }),
    })} />);
    expect(within(screen.getByTestId("effective-task-state")).getByText("unknown")).toBeTruthy();
    expect(screen.getByText("State provenance is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Inspect state source" })).toBeNull();
  });

  it("keeps an unknown effective state when the inspected task record has provenance", () => {
    render(<RecordCard record={record({
      taskStatus: null,
      taskState: taskState({
        effectiveState: "unknown", stateSource: "unknown", progress: null,
        stateProvenance: { recordId: taskId, recordedAt, reviewStatus: "proposed", evidenceBasis: "agent_report" },
      }),
    })} />);
    expect(within(screen.getByTestId("effective-task-state")).getByText("unknown")).toBeTruthy();
    expect(screen.getByText("Effective state from unknown source.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Inspect task record" }).getAttribute("href"))
      .toBe(`/projects/${projectId}?recordId=${taskId}`);
    expect(screen.queryByRole("link", { name: "Inspect state source" })).toBeNull();
  });

  it("retains the existing card for records without a task-state projection", () => {
    render(<RecordCard record={record({ taskState: undefined })} />);
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.queryByTestId("effective-task-state")).toBeNull();
    expect(screen.queryByTestId("task-state-provenance")).toBeNull();
  });
});
