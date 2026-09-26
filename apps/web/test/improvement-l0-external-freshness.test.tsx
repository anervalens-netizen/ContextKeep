import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BriefDto, RecordDto, WorkspaceReconciliationDto } from "@contextkeep/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock, ApiError: class ApiError extends Error {} }));
vi.mock("../src/lib/offline/mirror.js", () => ({ briefKey: (id: string) => `brief:${id}`, readCache: vi.fn().mockResolvedValue(null), saveToCacheBestEffort: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/lib/hooks.js", () => ({ notifyError: vi.fn() }));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return { useParams: () => ({ projectId: "project-1" }), useSearch: () => ({ recordId: undefined, tab: undefined }), useNavigate: () => async () => undefined, Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => ReactModule.createElement("a", { href: to, ...props }, children) };
});

const ProjectDetail = (await import("../src/pages/ProjectDetail.js")).default;
const stamp = "2026-09-17T09:00:00.000Z";
const project = { id: "project-1", name: "ContextKeep", aliases: [], parentId: null, description: null, lifecycle: "active" as const, lifecycleRecordId: null, revision: 1, contentVersion: 0, createdAt: stamp, updatedAt: stamp };
const baseBrief: BriefDto = { project, lifecycle: { state: "active", recordId: null, reviewedAt: null, reviewDueAt: null }, description: null, facts: [], decisions: [], constraints: [], openQuestions: [], actions: [], lastReviewedAt: null, generatedAt: stamp, revision: 1, contentVersion: 0 };
const reconciliation: WorkspaceReconciliationDto = { generatedAt: stamp, total: 0, tracked: 0, linked: 0, ignored: 0, unresolved: 0, codexCatalogAvailable: true, dshCatalogAvailable: true, seededProjectIds: [], items: [] };

function fact(text: string): RecordDto {
  return { id: "record-1", projectId: "project-1", projectName: "ContextKeep", type: "fact", subject: "freshness", predicate: null, valueJson: null, text, reviewStatus: "accepted", evidenceBasis: "owner_declaration", taskStatus: null, recordedAt: stamp, sourceEventAt: null, effectiveFrom: null, effectiveTo: null, reviewedAt: stamp, reviewDueAt: null, volatile: false, isOverdue: false, revision: 1, createdAt: stamp, updatedAt: stamp, evidence: [] };
}

afterEach(() => { cleanup(); vi.useRealTimers(); apiFetchMock.mockReset(); });

describe("L0.1 external freshness regression", () => {
  it("F05: an externally accepted MCP write becomes visible without reload within 16.5s", async () => {
    vi.useFakeTimers();
    let liveBrief = baseBrief;
    let contentVersion = 0;
    let projectRevision = 1;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects/project-1/brief") return liveBrief;
      if (url === "/api/projects/project-1/work-context") return {
        project: { id: "project-1", name: "ContextKeep" },
        freshness: { canonicalCursor: contentVersion, workingCursor: 0 },
        workingMemory: { total: 0, items: [], truncated: false },
        latestCheckpoint: null,
        blockerState: { activeCount: 0, resolvedCount: 0, active: [] },
        indicators: { stale: false, truncated: false, unknown: [] },
      };
      if (url === "/api/meta") return { appVersion: "0.1.0", schemaVersion: 16 };
      if (url === "/api/workspaces/reconciliation") return reconciliation;
      if (url === "/api/projects/project-1/freshness") {
        return {
          projectId: "project-1", projectRevision, cursor: contentVersion, contentCursor: contentVersion,
          workingCursor: 0, workingMemoryVersion: 0, changed: false, delta: 0,
          resetRequired: false, workingChanged: false, workingDelta: 0, workingResetRequired: false, projectRevisionChanged: false, projectRevisionResetRequired: false,
        };
      }
      if (url.startsWith("/api/projects/project-1/freshness?after=")) {
        const parsed = new URL(url, "http://local");
        const after = Number(parsed.searchParams.get("after"));
        const workingAfter = Number(parsed.searchParams.get("workingAfter"));
        expect(workingAfter).toBe(0);
        return {
          projectId: "project-1", projectRevision, cursor: contentVersion, contentCursor: contentVersion,
          workingCursor: 0, workingMemoryVersion: 0,
          changed: after !== contentVersion, delta: Math.max(0, contentVersion - after),
          resetRequired: after > contentVersion, workingChanged: false, workingDelta: 0, workingResetRequired: false,
          projectRevisionChanged: Number(parsed.searchParams.get("projectRevisionAfter")) !== projectRevision,
          projectRevisionResetRequired: Number(parsed.searchParams.get("projectRevisionAfter")) > projectRevision,
        };
      }
      throw new Error(`unexpected API call ${url}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } } });
    render(React.createElement(QueryClientProvider, { client }, React.createElement(ProjectDetail)));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("No reviewed project knowledge yet.")).toBeTruthy();

    contentVersion = 1;
    liveBrief = { ...baseBrief, contentVersion: 1, generatedAt: "2026-09-17T09:00:01.000Z", facts: [{ record: fact("MCP_UPDATE_AFTER_PAGE_LOAD"), evidence: [] }] };
    await act(async () => { await vi.advanceTimersByTimeAsync(16_500); });
    expect(screen.getByText("MCP_UPDATE_AFTER_PAGE_LOAD")).toBeTruthy();

    const timelineKey = ["timeline", "project-1", "paged"];
    client.setQueryData(timelineKey, { entries: [] });
    expect(client.getQueryState(timelineKey)?.isInvalidated).toBe(false);
    projectRevision = 2;
    liveBrief = {
      ...liveBrief,
      project: { ...liveBrief.project, revision: projectRevision, description: "SYNTHETIC_METADATA_PATCH" },
      description: "SYNTHETIC_METADATA_PATCH",
      revision: projectRevision,
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("SYNTHETIC_METADATA_PATCH")).toBeTruthy();
    expect(client.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    client.clear();
  });
});
