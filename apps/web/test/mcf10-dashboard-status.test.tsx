import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, readCacheMock, saveToCacheMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  readCacheMock: vi.fn(),
  saveToCacheMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  isNetworkUnavailableError: () => true,
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  META_DASHBOARD_KEY: "meta:dashboard",
  workContextKey: (id: string) => `work-context:${id}`,
  readCache: readCacheMock,
  saveToCacheBestEffort: saveToCacheMock,
}));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) =>
      ReactModule.createElement("a", { href: to, ...props }, children),
  };
});

const { ProjectMemoryDashboard } = await import("../src/components/ProjectMemoryDashboard.js");

const context = {
  project: { id: "project-1", name: "ContextKeep" },
  freshness: { canonicalCursor: 5, workingCursor: 8 },
  workingMemory: { total: 0, items: [], truncated: false },
  latestCheckpoint: null,
  blockerState: { activeCount: 0, resolvedCount: 0, active: [] },
  indicators: { stale: false, truncated: false, unknown: [] },
};

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ProjectMemoryDashboard, { projectId: "project-1" }),
    ),
  );
  return client;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  readCacheMock.mockReset();
  saveToCacheMock.mockClear();
});
afterEach(() => cleanup());

describe("MCF-10 memory dashboard status semantics", () => {
  it("does not present a fresh but invalid backup as healthy", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects/project-1/work-context") return context;
      if (url === "/api/meta") return {
        appVersion: "0.1.0",
        schemaVersion: 16,
        backup: {
          status: "fresh",
          latestCreatedAt: "2026-09-22T14:00:00.000Z",
          ageSeconds: 120,
          staleAfterHours: 36,
          manifestPresent: true,
          verificationStatus: "changed_or_invalid",
          latestVerifiedAt: null,
          latestBackupRestoreTestedAt: null,
          lastRestoreTestedAt: null,
        },
      };
      throw new Error(`unexpected ${url}`);
    });

    renderDashboard();
    expect(await screen.findByText("Memory status")).toBeTruthy();
    expect(await screen.findByText("invalid")).toBeTruthy();
    expect(screen.getByText("not tested on latest")).toBeTruthy();
    expect(screen.getByText(/freshness alone is not treated as healthy/i)).toBeTruthy();
  });

  it("labels an offline cache as non-live freshness", async () => {
    apiFetchMock.mockRejectedValue(new TypeError("network unavailable"));
    readCacheMock.mockImplementation(async (key: string) => {
      if (key === "work-context:project-1") {
        return { value: context, savedAt: "2026-09-22T13:00:00.000Z", provenance: { source: "cache", fetchedAt: "2026-09-22T13:00:00.000Z", scope: "project:project-1:work-context", cursor: null, generation: 2, savedAt: "2026-09-22T13:00:00.000Z" } };
      }
      if (key === "meta:dashboard") {
        return { value: { appVersion: "0.1.0", schemaVersion: 16 }, savedAt: "2026-09-22T13:00:00.000Z", provenance: { source: "cache", fetchedAt: "2026-09-22T13:00:00.000Z", scope: "meta:dashboard", cursor: 16, generation: 2, savedAt: "2026-09-22T13:00:00.000Z" } };
      }
      return null;
    });

    renderDashboard();
    expect(await screen.findByText("Memory status")).toBeTruthy();
    expect(screen.getByText(/This is not live freshness/i)).toBeTruthy();
  });
});
