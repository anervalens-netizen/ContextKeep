import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDto, WorkspaceReconciliationDto } from "@contextkeep/shared";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  PROJECTS_KEY: "projects:last",
  readCache: vi.fn(async () => null),
  saveToCacheBestEffort: vi.fn(async () => undefined),
}));
vi.mock("../src/components/WorkspaceRegistry.js", () => ({
  WorkspaceRegistry: () => React.createElement("div", { "data-testid": "workspace-registry" }),
}));
vi.mock("../src/lib/hooks.js", () => ({
  isQueued: () => false,
  notifyError: vi.fn(),
  reportQueued: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-router", async () => {
  const R = await import("react");
  return {
    Link: ({ to, params, children, ...rest }: any) =>
      R.createElement(
        "a",
        { href: params?.projectId ? to.replace("$projectId", params.projectId) : to, ...rest },
        children,
      ),
    useNavigate: () => vi.fn(),
  };
});

const { default: Projects } = await import("../src/pages/Projects.js");

function project(id: string, lifecycle: ProjectDto["lifecycle"]): ProjectDto {
  return {
    id,
    name: id,
    aliases: [],
    parentId: null,
    description: null,
    lifecycle,
    lifecycleRecordId: null,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

const projects = [
  { ...project("active-one", "active"), aliases: ["active-alias", "ao"] },
  project("active-two", "active"),
  project("paused-one", "paused"),
  project("retired-one", "retired"),
];

const reconciliation: WorkspaceReconciliationDto = {
  generatedAt: "2026-09-18T00:00:00.000Z",
  total: 2,
  tracked: 2,
  linked: 0,
  ignored: 0,
  unresolved: 0,
  codexCatalogAvailable: true,
  dshCatalogAvailable: true,
  seededProjectIds: [],
  items: [{
    workspace: {
      id: "workspace-active", canonicalKey: "git:active", canonicalPath: "/opt/active-one", displayName: "active-one",
      gitRemote: "github.com/example/active-one", gitBranch: "main", gitHeadSha: "abc",
      lastGitActivity: "2026-09-18T00:00:00.000Z", lastObservedActivity: "2026-09-18T00:00:00.000Z",
      projectId: "active-one", projectName: "active-one", projectLifecycle: "active", ignored: false,
      firstSeenAt: "2026-09-18T00:00:00.000Z", lastSeenAt: "2026-09-18T00:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
    },
    status: "tracked",
    history: {
      codexCurrentCount: 0,
      codexArchivedCount: 0,
      codexSummaryCount: 2,
      dshSessionCount: 0,
      lastSessionActivity: null,
      lastAgentActivity: "2026-09-18T01:00:00.000Z",
    },
    suggestion: { action: null, projectId: null, projectName: null, confidence: null, reason: null },
  }, {
    workspace: {
      id: "workspace-session", canonicalKey: "git:session", canonicalPath: "/opt/active-two", displayName: "active-two",
      gitRemote: "github.com/example/active-two", gitBranch: "main", gitHeadSha: "def",
      lastGitActivity: "2026-09-18T00:00:00.000Z", lastObservedActivity: "2026-09-18T00:00:00.000Z",
      projectId: "active-two", projectName: "active-two", projectLifecycle: "active", ignored: false,
      firstSeenAt: "2026-09-18T00:00:00.000Z", lastSeenAt: "2026-09-18T00:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
    },
    status: "tracked",
    history: {
      codexCurrentCount: 1,
      codexArchivedCount: 0,
      codexSummaryCount: 0,
      dshSessionCount: 0,
      lastSessionActivity: "2026-09-18T00:30:00.000Z",
      lastAgentActivity: "2026-09-18T00:30:00.000Z",
    },
    suggestion: { action: null, projectId: null, projectName: null, confidence: null, reason: null },
  }],
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Projects />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/projects") return projects;
    if (url === "/api/workspaces/reconciliation") return reconciliation;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

describe("projects active-first UI", () => {
  it("keeps only active projects in the main grid and collapses every other lifecycle", async () => {
    mount();
    expect(await waitFor(() => within(document.body).getByText("Active projects"))).toBeTruthy();
    const inactiveSummary = within(document.body).getByText("Inactive / historical projects (2)");
    const details = inactiveSummary.closest("details") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);

    const activeHeading = within(document.body).getByText("Active projects").closest("section") as HTMLElement;
    expect(within(activeHeading).getByText("active-one")).toBeTruthy();
    expect(within(activeHeading).getByText("active-two")).toBeTruthy();
    expect(within(activeHeading).getByText("Aliases: active-alias, ao")).toBeTruthy();
    expect(within(activeHeading).getByText("2 Codex summaries")).toBeTruthy();

    const cardLinks = Array.from(activeHeading.querySelectorAll("li > a"));
    expect(cardLinks.slice(0, 2).map((link) => link.getAttribute("href"))).toEqual([
      "/projects/active-two",
      "/projects/active-one",
    ]);
    const summaryOnlyCard = cardLinks.find((link) => link.getAttribute("href") === "/projects/active-one") as HTMLElement;
    expect(within(summaryOnlyCard).queryByText(/^Worked /)).toBeNull();
    expect(within(summaryOnlyCard).getByText(/^Repo activity /)).toBeTruthy();
    expect(within(activeHeading).queryByText("paused-one")).toBeNull();
    expect(within(activeHeading).queryByText("retired-one")).toBeNull();

    expect(within(details).getByText("paused-one")).toBeTruthy();
    expect(within(details).getByText("retired-one")).toBeTruthy();
  });
});
