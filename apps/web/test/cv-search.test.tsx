import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, readCacheMock, saveToCacheMock, navigateMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  readCacheMock: vi.fn(),
  saveToCacheMock: vi.fn().mockResolvedValue(undefined),
  navigateMock: vi.fn(),
}));

type RouteSearch = { q: string; includeHistorical: boolean; projectId: string | undefined; scope: "canonical" | "working" | "all" };
const routeState: { current: RouteSearch } = {
  current: { q: "release", includeHistorical: false, projectId: undefined, scope: "all" },
};

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  isNetworkUnavailableError: (error: unknown) => error instanceof TypeError,
}));
vi.mock("../src/lib/offline/mirror.js", () => ({
  SEARCH_LAST_KEY: "search:last",
  legacyCanonicalSearchKey: (input: any) => `legacy:${JSON.stringify(input)}`,
  searchKey: (input: any) => `search:${JSON.stringify(input)}`,
  readCache: readCacheMock,
  saveToCache: saveToCacheMock,
}));
vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to, ...props }: any) => ReactModule.createElement("a", { href: to, ...props }, children),
    useNavigate: () => navigateMock,
    useSearch: () => routeState.current,
  };
});

const { default: Search } = await import("../src/pages/Search.js");

const record = (id: string, text: string, reviewStatus = "accepted") => ({
  id,
  projectId: "project-1",
  projectName: "ContextKeep",
  type: "fact",
  subject: "release",
  predicate: null,
  text,
  reviewStatus,
  evidenceBasis: reviewStatus === "accepted" ? "owner_declaration" : "agent_report",
  taskStatus: null,
  recordedAt: "2026-09-24T00:00:00.000Z",
  sourceEventAt: null,
  effectiveFrom: null,
  effectiveTo: null,
  reviewedAt: null,
  reviewDueAt: null,
  volatile: false,
  isOverdue: false,
  evidence: [],
});

function result(query: string) {
  return {
    query,
    mode: "discovery",
    match: "terms",
    scope: "all",
    includeHistorical: false,
    records: [record("canonical-1", "Canonical release record")],
    workingRecords: [record("working-1", "Working release proposal", "proposed")],
    projects: [],
    sources: [],
    tookMs: 1,
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Search /></QueryClientProvider>);
}

beforeEach(() => {
  routeState.current = { q: "release", includeHistorical: false, projectId: undefined, scope: "all" };
  apiFetchMock.mockReset();
  readCacheMock.mockReset();
  saveToCacheMock.mockClear();
  navigateMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/projects") return [];
    if (url.startsWith("/api/search?")) return result(new URL(url, "http://contextkeep.local").searchParams.get("q") ?? "");
    throw new Error(`unexpected ${url}`);
  });
});

afterEach(cleanup);

describe("CV04 search scope/cache UI regressions", () => {
  it("uses URL scope/query as the source of truth and keeps canonical and working labels separate", async () => {
    const view = mount();

    expect(await screen.findByText(/Working proposals \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Records \(1\)/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Memory scope" }) as HTMLSelectElement).value).toBe("all");
    expect(screen.queryByText(/A5|A9/)).toBeNull();

    routeState.current = { q: "older", includeHistorical: false, projectId: "project-1", scope: "canonical" };
    view.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Search /></QueryClientProvider>);
    await waitFor(() => expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes("q=older") && String(url).includes("projectId=project-1") && String(url).includes("scope=canonical"))).toBe(true));
    expect((screen.getByRole("combobox", { name: "Memory scope" }) as HTMLSelectElement).value).toBe("canonical");
  });

  it("renders authenticated error classes with actionable semantics instead of offline copy", async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects") return [];
      if (url.startsWith("/api/search?")) throw { name: "ApiError", status: 401, code: "unauthorized", message: "expired" };
      throw new Error(`unexpected ${url}`);
    });
    mount();

    expect(await screen.findByText("Search requires sign-in again.")).toBeTruthy();
    expect(screen.queryByText(/unavailable offline/i)).toBeNull();
  });

  it("uses an exact legacy canonical cache row only for canonical scope and labels it cached", async () => {
    routeState.current = { q: "release", includeHistorical: false, projectId: undefined, scope: "canonical" };
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/projects") return [];
      if (url.startsWith("/api/search?")) throw new TypeError("Failed to fetch");
      throw new Error(`unexpected ${url}`);
    });
    readCacheMock.mockImplementation(async (key: string) => key.startsWith("legacy:")
      ? { value: result("release"), provenance: { fetchedAt: "2026-09-23T23:00:00.000Z" } }
      : null);
    mount();

    await screen.findByText(/Offline — showing the last cached search/);
    expect(readCacheMock.mock.calls.some(([key]) => String(key).startsWith("legacy:"))).toBe(true);
    expect(screen.getByRole("heading", { name: /Records \(1\)/ })).toBeTruthy();
  });
});

it("gives search and project filters explicit accessible names", async () => {
  mount();
  expect(await screen.findByRole("searchbox", { name: "Search memory" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Filter by project" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Memory scope" })).toBeTruthy();
});
