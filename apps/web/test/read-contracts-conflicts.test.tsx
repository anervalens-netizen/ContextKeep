import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueuedMutation } from "../src/lib/offline/db.js";
const mocks = vi.hoisted(() => ({ listMutations: vi.fn(), listConflicts: vi.fn(), dismissConflict: vi.fn(), replayQueue: vi.fn() }));
vi.mock("../src/lib/offline/queue.js", () => mocks);
import { OfflineOperationInspector } from "../src/components/OfflineOperationInspector.js";
import { ConflictOverlay } from "../src/components/ConflictOverlay.js";
import { offlineMutationTarget } from "../src/components/OfflineMutationDetails.js";
import { useUiStore } from "../src/state/ui.js";
const projectId = "22222222-2222-4222-8222-222222222222";
const mutation: QueuedMutation = { method: "PATCH", url: `/api/projects/${projectId}?private=not-for-display`, label: "Edit project", body: {secret: "must-not-be-rendered"}, enqueuedAt: "2026-09-24T12:00:00Z", idempotencyKey: "offline-event" };
const conflict = { seq: 1, mutation, code: "idempotency_outcome_unknown", status: 409, message: "Outcome unknown", detectedAt: "2026-09-24T12:01:00Z" };
afterEach(() => { cleanup(); useUiStore.setState({conflicts: []}); vi.clearAllMocks(); });
it("RC10 inspects unknown outcomes from the conflict store without replay or acknowledgement", async () => {
  mocks.listMutations.mockResolvedValue([]); mocks.listConflicts.mockResolvedValue([conflict]);
  render(<OfflineOperationInspector />);
  fireEvent.click(screen.getByRole("button", {name: "Inspect offline operations"}));
  expect(await screen.findByText(/idempotency_outcome_unknown/)).toBeTruthy();
  expect(screen.getByRole("link", {name: "Open affected area", hidden: true}).getAttribute("href")).toBe(`/projects/${projectId}`);
  expect(document.body.textContent).not.toContain("must-not-be-rendered");
  expect(document.body.textContent).not.toContain("not-for-display");
  expect(mocks.dismissConflict).not.toHaveBeenCalled(); expect(mocks.replayQueue).not.toHaveBeenCalled();
});
it("RC10 exposes read-only details directly beside the unknown-outcome acknowledgement", () => {
  useUiStore.setState({conflicts: [conflict]}); render(<ConflictOverlay />);
  expect(screen.getByText("Inspect operation")).toBeTruthy();
  expect(screen.getByText(/server may already have applied/)).toBeTruthy();
  expect(mocks.dismissConflict).not.toHaveBeenCalled();
});
it("RC10 never creates an external or executable navigation target", () => {
  expect(offlineMutationTarget({...mutation,url: "https://outside.invalid/api/projects/"+projectId})).toBeNull();
  expect(offlineMutationTarget({...mutation,url: "javascript:alert(1)"})).toBeNull();
});
