import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDto, WorkspaceReconciliationDto } from "@contextkeep/shared";

let currentPath = "/projects/project-1";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock }));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children?: React.ReactNode } & Record<string, unknown>) => {
      let href = to;
      if (params?.projectId) href = href.replace("$projectId", params.projectId);
      return ReactModule.createElement("a", { href, ...rest }, children as React.ReactNode);
    },
    Outlet: () => ReactModule.createElement("div", { "data-testid": "route-outlet" }, "CENTER CONTENT"),
    useLocation: () => ({ pathname: currentPath }),
  };
});

// This is the canonical shell rendered by router.tsx. Keep these tests
// attached to the production component so UI refactors cannot leave a green
// suite exercising the legacy AppShell.tsx instead (audit F15).
const { AppShell, NAV_ITEMS, isActiveNav } = await import("../src/components/AppShell.js");

const project: ProjectDto = {
  id: "project-1",
  name: "unihub-retail",
  aliases: [],
  parentId: null,
  description: null,
  lifecycle: "active",
  lifecycleRecordId: null,
  revision: 1,
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-11T08:00:00.000Z",
};

const reconciliation: WorkspaceReconciliationDto = {
  generatedAt: "2026-09-11T09:00:00.000Z",
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
      lastGitActivity: "2026-09-11T08:30:00.000Z",
      lastObservedActivity: "2026-09-11T08:30:00.000Z",
      projectId: "project-1",
      projectName: "unihub-retail",
      projectLifecycle: "active",
      ignored: false,
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      lastSeenAt: "2026-09-11T09:00:00.000Z",
      createdAt: "2026-09-10T00:00:00.000Z",
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


function renderShell(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(AppShell, {
        authenticated: true,
        showInstall: false,
        installGateReason: "",
        onInstall: vi.fn(async () => undefined),
        onLogout: vi.fn(async () => undefined),
        onDeleteLocalData: vi.fn(async () => ({
          status: "complete" as const,
          summary: { queued: 0, inFlight: 0, conflicts: 0, unknownOutcome: 0, reviewRequired: 0, unsafeCount: 0 },
          errors: [] as [],
          removedCaches: [],
        })),
      }),
    ),
  );
}

beforeEach(() => {
  currentPath = "/projects/project-1";
  window.localStorage.clear();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/projects") return [project];
    if (url === "/api/workspaces/reconciliation") return reconciliation;
    throw new Error(`unexpected API call ${url}`);
  });
});
afterEach(() => cleanup());

describe("M4.3 production application shell", () => {
  it("keeps the five primary destinations and exact root matching", () => {
    expect(NAV_ITEMS.map((item) => item.to)).toEqual(["/", "/inbox", "/import", "/corrections", "/search"]);
    expect(isActiveNav("/", "/")).toBe(true);
    expect(isActiveNav("/projects/project-1", "/")).toBe(false);
    expect(isActiveNav("/inbox/thread", "/inbox")).toBe(true);
  });

  it("renders the production navigation and center without an AI pane", async () => {
    renderShell();
    const shell = document.querySelector('[data-shell="app"]') as HTMLElement;
    const navigation = document.querySelector('[data-pane="navigation"]') as HTMLElement;
    const center = document.querySelector('[data-pane="center"]') as HTMLElement;
    expect(shell).toBeTruthy();
    expect(shell.className).toContain("lg:grid");
    expect(navigation).toBeTruthy();
    expect(center).toBeTruthy();
    expect(document.querySelector('[data-pane="agent"]')).toBeNull();

    const primary = within(navigation).getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/", "/inbox", "/import", "/corrections", "/search",
    ]);
    expect(within(center).getByTestId("route-outlet").textContent).toBe("CENTER CONTENT");

    const projectLink = await waitFor(() => {
      const match = within(navigation).getAllByRole("link").find((link) => link.getAttribute("href") === "/projects/project-1");
      if (!match) throw new Error("project link not loaded yet");
      return match;
    });
    expect(within(projectLink).getByText("unihub-retail")).toBeTruthy();
    expect(within(projectLink).getByText(/363 sessions/)).toBeTruthy();
    expect(projectLink.getAttribute("aria-current")).toBe("page");
  });

  it("never calls chat APIs and removes only retired chat layout preferences", async () => {
    window.localStorage.setItem("ck:agent:provider", "openai");
    window.localStorage.setItem("ck:agent:effort", "medium");
    window.localStorage.setItem("ck:shell:right-width", "402");
    window.localStorage.setItem("ck:shell:right-collapsed", "1");
    window.localStorage.setItem("ck:last-project", "project-1");
    renderShell();
    await waitFor(() => expect(apiFetchMock.mock.calls.length).toBeGreaterThan(0));
    expect(apiFetchMock.mock.calls.some((call) => String(call[0]).startsWith("/api/agent"))).toBe(false);
    await waitFor(() => expect(window.localStorage.getItem("ck:agent:provider")).toBeNull());
    expect(window.localStorage.getItem("ck:agent:effort")).toBeNull();
    expect(window.localStorage.getItem("ck:shell:right-width")).toBeNull();
    expect(window.localStorage.getItem("ck:shell:right-collapsed")).toBeNull();
    expect(window.localStorage.getItem("ck:last-project")).toBe("project-1");
  });

  it("uses mobile drawers instead of a fixed bottom navigation and closes them with Escape", () => {
    renderShell();
    const mobile = document.querySelector('[data-shell="mobile"]') as HTMLElement;
    expect(mobile).toBeTruthy();
    expect(mobile.className).toContain("lg:hidden");
    expect(document.querySelector('nav.fixed.inset-x-0.bottom-0')).toBeNull();

    fireEvent.click(within(mobile).getByRole("button", { name: "Open navigation" }));
    const navDrawer = document.querySelector('[data-drawer="navigation"]') as HTMLElement;
    expect(navDrawer.className).toContain("translate-x-0");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(navDrawer.className).toContain("-translate-x-full");

    expect(within(mobile).queryByRole("button", { name: "Open ContextKeep AI" })).toBeNull();
    expect(document.querySelector('[data-drawer="agent"]')).toBeNull();
  });

  it("persists pane collapse preference locally", () => {
    renderShell();
    const navigation = document.querySelector('[data-pane="navigation"]') as HTMLElement;
    fireEvent.click(within(navigation).getByRole("button", { name: "Collapse left sidebar" }));
    expect(window.localStorage.getItem("ck:shell:left-collapsed")).toBe("1");
    expect(within(navigation).getByRole("button", { name: "Expand left sidebar" })).toBeTruthy();
  });

  it("uses intended default pane widths when local preferences are absent", () => {
    renderShell();
    const shell = document.querySelector('[data-shell="app"]') as HTMLElement;
    expect(shell.getAttribute("style")).toContain("268px");
    expect(shell.getAttribute("style")).not.toContain("402px");
  });
});
