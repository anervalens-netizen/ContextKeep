import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BriefDto, WorkspaceReconciliationDto } from "@contextkeep/shared";

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
    useSearch: () => ({ recordId: undefined }),
    Link: ({ children, to, search, ...props }: { children: React.ReactNode; to: string; search?: { projectId?: string } }) =>
      ReactModule.createElement("a", { href: search?.projectId ? `${to}?projectId=${encodeURIComponent(search.projectId)}` : to, ...props }, children),
  };
});

const ProjectDetail = (await import("../src/pages/ProjectDetail.js")).default;

const brief: BriefDto = {
  project: {
    id: "project-1",
    name: "unihub-retail",
    aliases: [],
    parentId: null,
    description: null,
    lifecycle: "unknown",
    lifecycleRecordId: null,
    revision: 1,
    createdAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
  },
  lifecycle: { state: "unknown", recordId: null, reviewedAt: null, reviewDueAt: null },
  description: null,
  facts: [],
  decisions: [],
  constraints: [],
  openQuestions: [],
  actions: [],
  lastReviewedAt: null,
  generatedAt: "2026-09-11T10:00:00.000Z",
  revision: 1,
};

const workContext = {
  project: { id: "project-1", name: "unihub-retail" },
  freshness: { canonicalCursor: 4, workingCursor: 7 },
  workingMemory: {
    total: 2,
    truncated: false,
    items: [
      { recordId: "11111111-1111-4111-8111-111111111111", text: "Agent checkpoint proposal", recordedAt: "2026-09-11T09:30:00.000Z", reviewStatus: "proposed", evidenceBasis: "agent_report" },
    ],
  },
  latestCheckpoint: {
    recordId: "22222222-2222-4222-8222-222222222222",
    recordedAt: "2026-09-11T09:35:00.000Z",
    checkpoint: { summary: "Payroll remediation complete", nextAction: "Run final certification", artifactRefs: ["git:abc123"] },
  },
  blockerState: {
    activeCount: 1,
    resolvedCount: 3,
    active: [{ blockerId: "blk:22222222-2222-4222-8222-222222222222:0", text: "Await final certification" }],
  },
  indicators: { stale: true, truncated: false, unknown: [] },
};

const meta = {
  appVersion: "0.1.0",
  schemaVersion: 16,
  backup: {
    status: "fresh",
    latestCreatedAt: "2026-09-11T09:00:00.000Z",
    ageSeconds: 120,
    staleAfterHours: 36,
    manifestPresent: true,
    verificationStatus: "verified",
    latestVerifiedAt: "2026-09-11T09:00:00.000Z",
    latestBackupRestoreTestedAt: "2026-09-11T09:05:00.000Z",
    lastRestoreTestedAt: "2026-09-11T09:05:00.000Z",
  },
};

const reconciliation: WorkspaceReconciliationDto = {
  generatedAt: "2026-09-11T10:00:00.000Z",
  total: 1,
  tracked: 1,
  linked: 0,
  ignored: 0,
  unresolved: 0,
  codexCatalogAvailable: true,
  dshCatalogAvailable: true,
  seededProjectIds: [],
  items: [{
    workspace: {
      id: "workspace-1",
      canonicalKey: "git:github.com/anervalens-netizen/unihub-retail",
      canonicalPath: "/opt/Mobiup/unihub-retail",
      displayName: "unihub-retail",
      gitRemote: "github.com/anervalens-netizen/unihub-retail",
      gitBranch: "main",
      gitHeadSha: "abc123",
      lastGitActivity: "2026-09-11T09:00:00.000Z",
      lastObservedActivity: "2026-09-11T09:00:00.000Z",
      projectId: "project-1",
      projectName: "unihub-retail",
      projectLifecycle: "unknown",
      ignored: false,
      firstSeenAt: "2026-09-10T09:00:00.000Z",
      lastSeenAt: "2026-09-11T09:00:00.000Z",
      createdAt: "2026-09-10T09:00:00.000Z",
      updatedAt: "2026-09-11T09:00:00.000Z",
    },
    status: "tracked",
    history: {
      codexCurrentCount: 231,
      codexArchivedCount: 3,
      codexSummaryCount: 29,
      dshSessionCount: 129,
      lastAgentActivity: "2026-09-11T09:00:00.000Z",
    },
    suggestion: { action: null, projectId: null, projectName: null, confidence: null, reason: null },
  }],
};

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/projects/project-1/brief") return brief;
    if (url === "/api/projects/project-1/work-context") return workContext;
    if (url === "/api/meta") return meta;
    if (url === "/api/workspaces/reconciliation") return reconciliation;
    throw new Error(`unexpected API call ${url}`);
  });
});
afterEach(() => cleanup());

describe("M4 intelligent project overview", () => {
  it("treats mapped Dell agent sessions as primary work history without promoting them to canonical knowledge", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ProjectDetail),
      ),
    );

    expect(await screen.findByText("Your agent work is here. Reviewed knowledge has not been built yet.")).toBeTruthy();
    expect(screen.getByText(/363 mapped agent sessions/)).toBeTruthy();
    expect(screen.getByText(/234 Codex, 129 DSH/)).toBeTruthy();
    expect(screen.getByText(/29 Codex summaries/)).toBeTruthy();
    expect(screen.getByText("Agent work on Dell")).toBeTruthy();
    expect(await screen.findByText("Memory status")).toBeTruthy();
    expect(await screen.findByText("Payroll remediation complete")).toBeTruthy();
    expect(screen.getAllByText(/Await final certification/).length).toBeGreaterThan(0);
    expect(screen.getByText("Agent checkpoint proposal")).toBeTruthy();
    expect(screen.getByText("verified")).toBeTruthy();
    expect(screen.getByText("tested")).toBeTruthy();
    expect(screen.queryByText("None recorded.")).toBeNull();
    expect(screen.getByRole("link", { name: /Add context/ }).getAttribute("href")).toBe("/import?projectId=project-1");
    expect(screen.getByRole("link", { name: /Import manually/ }).getAttribute("href")).toBe("/import?projectId=project-1");
  });
});
