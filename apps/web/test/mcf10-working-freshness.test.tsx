import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock, ApiError: class ApiError extends Error {} }));
vi.mock("../src/lib/offline/mirror.js", () => ({
  briefKey: (id: string) => `brief:${id}`,
  META_DASHBOARD_KEY: "meta:dashboard",
  workContextKey: (id: string) => `work-context:${id}`,
  readCache: vi.fn().mockResolvedValue(null),
  saveToCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/hooks.js", () => ({ notifyError: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    useParams: () => ({ projectId: "project-1" }),
    useSearch: () => ({ recordId: undefined, tab: undefined }),
    useNavigate: () => async () => undefined,
    Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) =>
      ReactModule.createElement("a", { href: to, ...props }, children),
  };
});

const ProjectDetail = (await import("../src/pages/ProjectDetail.js")).default;
const stamp = "2026-09-22T14:00:00.000Z";
const brief = {
  project: {
    id: "project-1", name: "ContextKeep", aliases: [], parentId: null, description: null,
    lifecycle: "active", lifecycleRecordId: null, revision: 1, contentVersion: 0,
    workingMemoryVersion: 1, createdAt: stamp, updatedAt: stamp,
  },
  lifecycle: { state: "active", recordId: null, reviewedAt: null, reviewDueAt: null },
  description: null, facts: [], decisions: [], constraints: [], openQuestions: [], actions: [],
  lastReviewedAt: null, generatedAt: stamp, revision: 1, contentVersion: 0,
};
const reconciliation = {
  generatedAt: stamp, total: 0, tracked: 0, linked: 0, ignored: 0, unresolved: 0,
  codexCatalogAvailable: true, dshCatalogAvailable: true, seededProjectIds: [], items: [],
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  apiFetchMock.mockReset();
});

describe("MCF-10 working freshness", () => {
  it("refreshes the dashboard for a working-only external write without changing canonical content", async () => {
    vi.useFakeTimers();
    let workingVersion = 1;
    let workingText = "Initial working capture";

    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects/project-1/brief") return brief;
      if (url === "/api/workspaces/reconciliation") return reconciliation;
      if (url === "/api/meta") return { appVersion: "0.1.0", schemaVersion: 16 };
      if (url === "/api/projects/project-1/work-context") return {
        project: { id: "project-1", name: "ContextKeep" },
        freshness: { canonicalCursor: 0, workingCursor: workingVersion },
        workingMemory: {
          total: 1, truncated: false,
          items: [{ recordId: "11111111-1111-4111-8111-111111111111", text: workingText, recordedAt: stamp }],
        },
        latestCheckpoint: null,
        blockerState: { activeCount: 0, resolvedCount: 0, active: [] },
        indicators: { stale: false, truncated: false, unknown: [] },
      };
      if (url === "/api/projects/project-1/freshness") return {
        projectId: "project-1", projectRevision: 1, cursor: 0, contentCursor: 0,
        workingCursor: workingVersion, workingMemoryVersion: workingVersion,
        changed: false, delta: 0, resetRequired: false,
        workingChanged: false, workingDelta: 0, workingResetRequired: false, projectRevisionChanged: false, projectRevisionResetRequired: false,
      };
      if (url.startsWith("/api/projects/project-1/freshness?")) {
        const parsed = new URL(url, "http://local");
        const after = Number(parsed.searchParams.get("after"));
        const workingAfter = Number(parsed.searchParams.get("workingAfter"));
        return {
          projectId: "project-1", projectRevision: 1, cursor: 0, contentCursor: 0,
          workingCursor: workingVersion, workingMemoryVersion: workingVersion,
          changed: after !== 0, delta: 0, resetRequired: after > 0,
          workingChanged: workingAfter !== workingVersion,
          workingDelta: Math.max(0, workingVersion - workingAfter),
          workingResetRequired: workingAfter > workingVersion, projectRevisionChanged: false, projectRevisionResetRequired: false,
        };
      }
      throw new Error(`unexpected API call ${url}`);
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } } });
    render(React.createElement(QueryClientProvider, { client }, React.createElement(ProjectDetail)));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Initial working capture")).toBeTruthy();
    expect(screen.getByText("No reviewed project knowledge yet.")).toBeTruthy();

    workingVersion = 2;
    workingText = "WORKING_ONLY_UPDATE";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_500);
      await Promise.resolve();
    });

    expect(screen.getByText("WORKING_ONLY_UPDATE")).toBeTruthy();
    expect(screen.getByText("No reviewed project knowledge yet.")).toBeTruthy();
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("workingAfter=1"))).toBe(true);
    client.clear();
  });
});
