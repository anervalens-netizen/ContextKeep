import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ProjectDto,
  WorkspaceDto,
  WorkspaceReconciliationDto,
  WorkspaceScanResultDto,
} from "@contextkeep/shared";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock }));

const { WorkspaceRegistry } = await import("../src/components/WorkspaceRegistry.js");

const project: ProjectDto = {
  id: "project-1",
  name: "Existing Project",
  aliases: [],
  parentId: null,
  description: null,
  lifecycle: "active",
  lifecycleRecordId: null,
  revision: 1,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
};

const workspace: WorkspaceDto = {
  id: "workspace-1",
  canonicalKey: "git:github.com/example/unihub-retail",
  canonicalPath: "/opt/Mobiup/unihub-retail",
  displayName: "unihub-retail",
  gitRemote: "github.com/example/unihub-retail",
  gitBranch: "main",
  gitHeadSha: "0123456789abcdef",
  lastGitActivity: "2026-09-10T12:00:00.000Z",
  lastObservedActivity: "2026-09-10T12:00:00.000Z",
  projectId: null,
  projectName: null,
  projectLifecycle: null,
  ignored: false,
  firstSeenAt: "2026-09-10T12:00:00.000Z",
  lastSeenAt: "2026-09-10T12:00:00.000Z",
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
};

function reconciliation(items: WorkspaceDto[]): WorkspaceReconciliationDto {
  return {
    generatedAt: "2026-09-11T09:00:00.000Z",
    total: items.length,
    tracked: 0,
    linked: 0,
    ignored: 0,
    unresolved: items.length,
    codexCatalogAvailable: true,
    dshCatalogAvailable: true,
    seededProjectIds: [],
    items: items.map((item) => ({
      workspace: item,
      status: "unresolved",
      history: {
        codexCurrentCount: 0,
        codexArchivedCount: 0,
        codexSummaryCount: 0,
        dshSessionCount: 0,
        lastAgentActivity: null,
      },
      suggestion: {
        action: "review",
        projectId: null,
        projectName: null,
        confidence: "low",
        reason: "Owner review required.",
      },
    })),
  };
}

function renderRegistry(projects: ProjectDto[] = [project]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(WorkspaceRegistry, { projects }),
    ),
  );
  return client;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => cleanup());

describe("M3.5/M4 WorkspaceRegistry", () => {
  it("keeps unresolved setup compact until the owner chooses to review it", async () => {
    apiFetchMock.mockResolvedValueOnce(reconciliation([workspace]));
    renderRegistry();

    expect(await screen.findByText(/1 workspace still need a decision/)).toBeTruthy();
    expect(screen.queryByText("unihub-retail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review 1" }));
    expect(await screen.findByText("unihub-retail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Track as project" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Existing project for unihub-retail" })).toBeTruthy();
    expect(screen.queryByText("Linked · Existing Project")).toBeNull();
  });

  it("Scan uses the explicit scan endpoint and refreshes reconciliation evidence", async () => {
    const discovered = { ...workspace, id: "workspace-2", displayName: "ContextKeep", canonicalPath: "/opt/contextkeep" };
    const scanResult: WorkspaceScanResultDto = {
      configuredRootCount: 1,
      discoveredCount: 1,
      insertedCount: 1,
      updatedCount: 0,
      workspaces: [discovered],
    };
    let reconciliationCalls = 0;
    apiFetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url === "/api/workspaces/reconciliation" && !options) {
        reconciliationCalls += 1;
        return reconciliationCalls === 1 ? reconciliation([]) : reconciliation([discovered]);
      }
      if (url === "/api/workspaces/scan") return scanResult;
      throw new Error(`unexpected API call ${url}`);
    });
    renderRegistry([]);

    await screen.findByText("All observed workspaces have a decision.");
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByText(/1 workspace still need a decision/)).toBeTruthy();
    expect(screen.getByText(/Found 1 workspace · 1 new · 0 refreshed/)).toBeTruthy();
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/api/workspaces/scan",
        expect.objectContaining({ method: "POST" }),
      );
      expect(reconciliationCalls).toBeGreaterThanOrEqual(2);
    });
  });
});


describe("WorkspaceRegistry collapsed error state", () => {
  it("surfaces reconciliation failure without requiring the owner to expand setup", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("reconciliation unavailable"));
    renderRegistry();
    expect(await screen.findByText("Could not load workspace setup.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Needs decision/ })).toBeNull();
    expect(screen.getByRole("button", { name: "View setup" }).getAttribute("aria-expanded")).toBe("false");
  });
});
