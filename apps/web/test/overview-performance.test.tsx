import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BriefDto, RecordDto } from "@contextkeep/shared";

const { api, route } = vi.hoisted(() => ({ api: vi.fn(), route: { projectId: "alpha" } }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: api, ApiError: class extends Error {}, isNetworkUnavailableError: () => false }));
vi.mock("../src/lib/offline/mirror.js", () => ({ briefKey: (id: string) => `brief:${id}`, readCache: vi.fn(), saveToCacheBestEffort: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/components/PwaTaskPanel.js", () => ({ PwaTaskPanel: () => null }));
vi.mock("../src/components/ProjectMemoryDashboard.js", () => ({ ProjectMemoryDashboard: () => null }));
vi.mock("../src/components/ProjectHistoryBackfill.js", () => ({ ProjectHistoryBackfill: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => route, useSearch: () => ({}), useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
import ProjectDetail from "../src/pages/ProjectDetail.js";

const date = "2026-09-01T00:00:00.000Z";
function brief(projectId = "alpha"): BriefDto {
  const records = (type: RecordDto["type"], count: number) => Array.from({ length: count }, (_, index) => ({
    evidence: [], record: {
      id: `${projectId}-${type}-${index}`, projectId, projectName: null, type, subject: "Synthetic evidence", predicate: null,
      text: `${projectId} ${type} ${index + 1}`, reviewStatus: "accepted" as const, evidenceBasis: "owner_declaration" as const,
      recordedAt: date, effectiveFrom: null, effectiveTo: null, sourceEventAt: null, reviewedAt: null, reviewDueAt: null,
      taskStatus: null, volatile: false, isOverdue: false, evidence: [], revision: 1, valueJson: null, createdAt: date, updatedAt: date,
    },
  }));
  return {
    project: { id: projectId, name: `Project ${projectId}`, aliases: [], parentId: null, description: null, lifecycle: "active", lifecycleRecordId: null, revision: 1, contentVersion: 1, createdAt: date, updatedAt: date },
    lifecycle: { state: "active", recordId: null, reviewedAt: null, reviewDueAt: null }, description: "Synthetic overview",
    facts: records("fact", 80), decisions: records("decision", 25), constraints: records("constraint", 12),
    openQuestions: records("question", 11), actions: records("action", 15),
    lastReviewedAt: null, generatedAt: date, revision: 1, contentVersion: 1,
  };
}
const clients: QueryClient[] = [];
const workspaceData = { items: [], unresolved: 0, seededProjectIds: [] };
function serve(url: string) {
  if (url.endsWith("/brief")) return Promise.resolve(brief(url.split("/")[3]));
  if (url === "/api/workspaces/reconciliation") return Promise.resolve(workspaceData);
  // Freshness is independent of overview render prioritization.
  return new Promise(() => {});
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  return { client, ...render(<QueryClientProvider client={client}><ProjectDetail /></QueryClientProvider>) };
}
beforeEach(() => { route.projectId = "alpha"; api.mockReset().mockImplementation(serve); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
const section = (name: string) => within(screen.getByRole("heading", { name }).closest("section")!);

describe("large accepted overview render prioritization", () => {
  it("renders ten per section, preserves exact totals, expands on demand without fetching another brief", async () => {
    mount();
    await screen.findByText("alpha fact 10");
    expect(screen.queryByText("alpha fact 11")).toBeNull();
    expect(screen.getAllByText(/^alpha (fact|decision|constraint|question|action) \d+$/)).toHaveLength(50);
    expect(screen.getByText("Showing 10 of 80 current facts")).toBeTruthy();
    expect(screen.getByText("Showing 10 of 25 decisions")).toBeTruthy();
    expect(screen.getByText("Showing 10 of 12 constraints")).toBeTruthy();
    expect(screen.getByText("Showing 10 of 11 open questions")).toBeTruthy();
    expect(screen.getByText("Showing 10 of 15 next actions")).toBeTruthy();
    fireEvent.click(section("Current facts").getByRole("button", { name: "Show 10 more current facts" }));
    expect(screen.getByText("alpha fact 20")).toBeTruthy();
    expect(screen.queryByText("alpha fact 21")).toBeNull();
    expect(screen.getByText("Showing 20 of 80 current facts")).toBeTruthy();
    fireEvent.click(section("Decisions").getByRole("button", { name: "Show all 25 decisions" }));
    expect(screen.getByText("alpha decision 25")).toBeTruthy();
    expect(screen.getByText("Showing 25 of 25 decisions")).toBeTruthy();
    expect(screen.queryByText("alpha fact 21")).toBeNull();
    fireEvent.click(section("Current facts").getByRole("button", { name: "Show all 80 current facts" }));
    expect(screen.getByText("alpha fact 80")).toBeTruthy();
    fireEvent.click(section("Current facts").getByRole("button", { name: "Show fewer current facts" }));
    expect(screen.queryByText("alpha fact 11")).toBeNull();
    expect(api.mock.calls.filter(([url]) => url.endsWith("/brief"))).toHaveLength(1);
  });

  it("resets section expansion when switching projects", async () => {
    const view = mount();
    await screen.findByText("alpha fact 10");
    fireEvent.click(section("Current facts").getByRole("button", { name: "Show all 80 current facts" }));
    route.projectId = "beta";
    view.rerender(<QueryClientProvider client={view.client}><ProjectDetail /></QueryClientProvider>);
    await screen.findByText("beta fact 10");
    expect(screen.queryByText("beta fact 11")).toBeNull();
    expect(screen.queryByText("alpha fact 80")).toBeNull();
    expect(screen.getByText("Showing 10 of 80 current facts")).toBeTruthy();
  });

  it("starts secondary workspace reconciliation only after the full brief is ready and labels pending counts", async () => {
    let releaseBrief!: (data: BriefDto) => void;
    let releaseWorkspace!: (data: typeof workspaceData) => void;
    api.mockImplementation((url: string) => {
      if (url.endsWith("/brief")) return new Promise(resolve => { releaseBrief = resolve; });
      if (url === "/api/workspaces/reconciliation") return new Promise(resolve => { releaseWorkspace = resolve; });
      return serve(url);
    });
    mount();
    expect(api.mock.calls.some(([url]) => url === "/api/workspaces/reconciliation")).toBe(false);
    await act(async () => { releaseBrief(brief()); });
    await screen.findByText("alpha fact 10");
    await waitFor(() => expect(releaseWorkspace).toBeDefined());
    expect(screen.getByText("Agent sessions").parentElement?.textContent).toContain("Loading…");
    expect(screen.getByText("Loading workspace activity…")).toBeTruthy();
    await act(async () => { releaseWorkspace(workspaceData); });
    await waitFor(() => expect(screen.getByText("Agent sessions").parentElement?.textContent).toContain("0"));
    expect(api.mock.calls.filter(([url]) => url === "/api/workspaces/reconciliation")).toHaveLength(1);
  });

  it("keeps the brief usable when secondary workspace reconciliation fails", async () => {
    api.mockImplementation((url: string) => url === "/api/workspaces/reconciliation" ? Promise.reject(new Error("Synthetic service failure")) : serve(url));
    mount();
    await screen.findByText("Workspace activity unavailable");
    expect(screen.getByText("Agent sessions").parentElement?.textContent).toContain("Unavailable");
    expect(screen.getByText("alpha fact 10")).toBeTruthy();
  });
});
