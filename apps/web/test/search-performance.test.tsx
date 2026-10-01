import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDto, RecordDto, SearchResultDto } from "@contextkeep/shared";
import Search from "../src/pages/Search.js";
import Projects from "../src/pages/Projects.js";
import Import from "../src/pages/Import.js";
import Corrections from "../src/pages/Corrections.js";
import Inbox from "../src/pages/Inbox.js";
import { useShellData } from "../src/components/useShellData.js";
import { setPrivateReadsPausedForAuthTransition } from "../src/lib/api.js";
import { offlineDb } from "../src/lib/offline/db.js";
import * as mirror from "../src/lib/offline/mirror.js";
import { searchCacheScope, validateSearchFilters } from "../src/lib/search-filters.js";

// jsdom has no layout; render all rows to assert exact record visibility.
vi.mock("../src/components/VirtualList.js", () => ({
  VirtualList: ({ items, renderRow, emptyText }: any) => <div>{items.length ? items.map((item: any) => <React.Fragment key={item.id}>{renderRow(item)}</React.Fragment>) : emptyText}</div>,
}));

const fetchedAt = "2026-09-25T12:00:00.000Z";
const project = (id: string, name: string): ProjectDto => ({
  id, name, aliases: [], parentId: null, description: null, lifecycle: "active",
  lifecycleRecordId: null, revision: 1, contentVersion: 1, createdAt: fetchedAt, updatedAt: fetchedAt,
});
const projects = [project("alpha", "Project Alpha"), project("beta", "Project Beta")];
function record(projectId: string, query: string, working: boolean): RecordDto {
  return {
    id: `${projectId}-${query}-${working}`, projectId, projectName: null,
    type: "fact", subject: query, predicate: null, valueJson: null,
    text: `${projectId}: ${query} ${working ? "proposal" : "accepted evidence"}`,
    reviewStatus: working ? "proposed" : "accepted", evidenceBasis: "agent_report",
    taskStatus: null, recordedAt: fetchedAt, sourceEventAt: null, effectiveFrom: null,
    effectiveTo: null, reviewedAt: null, reviewDueAt: null, volatile: false,
    isOverdue: false, revision: 1, createdAt: fetchedAt, updatedAt: fetchedAt, evidence: [],
  };
}
function result(query = "release", projectId = "alpha", scope = "canonical"): SearchResultDto {
  return {
    query, mode: "discovery", match: "terms", scope: scope as SearchResultDto["scope"], includeHistorical: false,
    records: scope === "working" ? [] : [record(projectId, query, false)],
    workingRecords: scope === "canonical" ? [] : [record(projectId, query, true)],
    projects: [], sources: [], tookMs: 1,
  };
}
function response(data: unknown, init?: RequestInit): Response {
  return new Response(JSON.stringify(data), { headers: {
    "content-type": "application/json",
    "x-contextkeep-data-source": "network-v1",
    "x-contextkeep-fetched-at": fetchedAt,
    "x-contextkeep-response-id": new Headers(init?.headers).get("x-contextkeep-request-id") ?? "",
  } });
}

const fetchMock = vi.fn<typeof fetch>();
const clients: QueryClient[] = [];
let availableProjects: ProjectDto[];
function serve(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === "/api/projects") {
    if (init?.method === "POST") {
      availableProjects = [...availableProjects, project("gamma", JSON.parse(String(init.body)).name)];
      return Promise.resolve(response(availableProjects.at(-1), init));
    }
    return Promise.resolve(response(availableProjects, init));
  }
  if (url.startsWith("/api/search?")) {
    const params = new URLSearchParams(url.split("?")[1]);
    return Promise.resolve(response(result(params.get("q")!, params.get("projectId") ?? "alpha", params.get("scope")!), init));
  }
  if (url === "/api/workspaces/reconciliation") return Promise.resolve(response({ items: [], unresolved: 0, seededProjectIds: [] }, init));
  if (url.startsWith("/api/portfolio?")) return Promise.resolve(response({ items: [], total: 75, nextOffset: 50 }, init));
  if (url === "/api/meta") return Promise.resolve(response({ appVersion: "test", schemaVersion: 1, adapters: [] }, init));
  if (url.startsWith("/api/inbox?")) return Promise.resolve(response({ candidates: [], total: 0, byProject: [] }, init));
  throw new Error(`Unexpected fixture request: ${url}`);
}
function ShellProbe() {
  const shell = useShellData();
  return <><nav aria-label="Sidebar"><Link to="/search">Search</Link></nav><output data-testid="shell-projects">{shell.projects.map(p => p.name).join(", ")} {shell.projectsStatus}</output><Outlet /></>;
}
async function mount(entries = ["/search?q=release&projectId=alpha"], shell = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, gcTime: Infinity } } });
  clients.push(client);
  const root = createRootRoute({ component: shell ? ShellProbe : Outlet });
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/search", validateSearch: validateSearchFilters, component: Search }),
    createRoute({ getParentRoute: () => root, path: "/", component: Projects }),
    createRoute({ getParentRoute: () => root, path: "/import", validateSearch: (s) => s, component: Import }),
    createRoute({ getParentRoute: () => root, path: "/corrections", component: Corrections }),
    createRoute({ getParentRoute: () => root, path: "/inbox", validateSearch: (s) => ({ ...s, page: 1 }), component: Inbox }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: entries }) });
  await router.load();
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return { client, router, ...view };
}
const input = () => screen.getByRole("searchbox", { name: "Search memory" }) as HTMLInputElement;
const selection = () => screen.getByRole("combobox", { name: "Filter by project" }) as HTMLSelectElement;
const searchRequests = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/search?"));
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function cacheSearch(projectId: string | null, scope: "canonical" | "working" | "all", query = "release") {
  await mirror.saveToCache(mirror.searchKey({ query, includeHistorical: false, projectId, scope }), result(query, projectId ?? "global", scope), {
    fetchedAt, scope: `search:q=${query}:historical=false:project=${projectId ?? "*"}:scope=${scope}`,
  });
}

beforeEach(async () => {
  localStorage.clear();
  setPrivateReadsPausedForAuthTransition(false);
  onlineManager.setOnline(true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  availableProjects = [...projects];
  fetchMock.mockReset().mockImplementation(serve);
  vi.stubGlobal("fetch", fetchMock);
  const db = await offlineDb();
  await db.clear("cache");
  await db.clear("mutations");
  await db.clear("conflicts");
});
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  setPrivateReadsPausedForAuthTransition(false);
});

describe("search drafts and router navigation", () => {
  it("discards a pending scoped draft when the sidebar Search link clears the filters", async () => {
    const { router } = await mount(["/search?projectId=alpha"]);
    await screen.findByRole("option", { name: "Project Alpha" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "abandoned draft" } });
    await act(async () => { fireEvent.click(screen.getByRole("link", { name: "Search" })); });
    expect(input().value).toBe("");
    expect(selection().value).toBe("");
    await advance(250);
    expect(router.state.location.href).toBe("/search");
    expect(searchRequests()).toHaveLength(0);
  });

  it.each([undefined, "release"])("restores unchanged committed q=%s on explicit programmatic filter navigation", async (q) => {
    const { router } = await mount([`/search?projectId=alpha${q ? `&q=${q}` : ""}`]);
    await screen.findByRole("option", { name: "Project Alpha" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "abandoned draft" } });
    await act(async () => { await router.navigate({ to: "/search", search: { q, projectId: "beta", scope: "working" } }); });
    expect(input().value).toBe(q ?? "");
    await advance(250);
    expect(router.state.location.search).toMatchObject({ projectId: "beta", scope: "working" });
    expect(router.state.location.search.q).toBe(q);
    expect(searchRequests().some(([url]) => String(url).includes("abandoned"))).toBe(false);
    if (!q) expect(searchRequests()).toHaveLength(0);
  });

  it.each([false, true])("does not request or render the old query with a new filter while typing (cached=%s)", async (cached) => {
    const { client } = await mount(["/search?q=release&projectId=alpha"]);
    await screen.findByText("alpha: release accepted evidence");
    if (cached) {
      client.setQueryData(["search", "release", false, "beta", "canonical", "", "", "", 50], {
        data: result("release", "beta"), provenance: { source: "cache", fetchedAt },
      });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "updated" } });
    fireEvent.change(selection(), { target: { value: "beta" } });
    await advance(50);
    expect(input().value).toBe("updated");
    expect(selection().value).toBe("beta");
    expect(searchRequests()).toHaveLength(1);
    expect(screen.queryByText("alpha: release accepted evidence")).toBeNull();
    expect(screen.queryByText("beta: release accepted evidence")).toBeNull();
    expect(screen.queryByText(/Offline — showing the last cached search/)).toBeNull();
    await advance(250);
    expect(searchRequests()).toHaveLength(2);
    const params = new URLSearchParams(String(searchRequests()[1]![0]).split("?")[1]);
    expect(params.get("q")).toBe("updated");
    expect(params.get("projectId")).toBe("beta");
    expect(screen.getByText("beta: updated accepted evidence")).toBeTruthy();
  });

  it("preserves a newer draft when an earlier debounce URL commit arrives late", async () => {
    const { router } = await mount(["/search?projectId=alpha"]);
    const navigate = router.navigate.bind(router);
    let commit!: () => Promise<void>;
    vi.spyOn(router, "navigate").mockImplementationOnce(options => new Promise<void>((resolve, reject) => {
      commit = async () => { await navigate(options).then(resolve, reject); };
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "first draft" } });
    await advance(200);
    expect(commit).toBeDefined();
    fireEvent.change(input(), { target: { value: "newer draft " } });
    await act(async () => { await commit(); });
    expect(router.state.location.search.q).toBe("first draft");
    expect(input().value).toBe("newer draft ");
    await advance(210);
    expect(router.state.location.search.q).toBe("newer draft");
    expect(input().value).toBe("newer draft ");
    expect(lastSearchParams().get("q")).toBe("newer draft");
  });

  it.each(["project", "scope", "historical", "combined"])("preserves a draft through rapid %s changes inside the debounce", async (filter) => {
    const { router } = await mount(["/search"]);
    await screen.findByRole("option", { name: "Project Alpha" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "release plan" } });
    await advance(100);
    if (filter === "project" || filter === "combined") {
      await act(async () => { fireEvent.change(selection(), { target: { value: "alpha" } }); });
    }
    if (filter === "scope" || filter === "combined") {
      await act(async () => { fireEvent.change(screen.getByLabelText("Memory scope"), { target: { value: "working" } }); });
    }
    if (filter === "historical" || filter === "combined") {
      await act(async () => { fireEvent.click(screen.getByLabelText("Include historical (superseded)")); });
    }
    expect(input().value).toBe("release plan");
    expect(searchRequests()).toHaveLength(0);
    await advance(110);
    expect(router.state.location.search.q).toBe("release plan");
    expect(input().value).toBe("release plan");
    const params = new URLSearchParams(String(searchRequests().at(-1)![0]).split("?")[1]);
    expect(params.get("q")).toBe("release plan");
    if (filter === "project" || filter === "combined") expect(params.get("projectId")).toBe("alpha");
    if (filter === "scope" || filter === "combined") expect(params.get("scope")).toBe("working");
    if (filter === "historical" || filter === "combined") expect(params.get("includeHistorical")).toBe("true");
  });

  it("honors direct query changes, Back/Forward and clear/reset instead of replaying a pending draft", async () => {
    const { router } = await mount();
    await screen.findByText("alpha: release accepted evidence");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "abandoned draft" } });
    await act(async () => { await router.navigate({ to: "/search", search: { q: "direct", projectId: "beta" } }); });
    expect(input().value).toBe("direct");
    await advance(250);
    expect(searchRequests().some(([url]) => String(url).includes("abandoned"))).toBe(false);
    await act(async () => { router.history.back(); });
    expect(input().value).toBe("release");
    expect(selection().value).toBe("alpha");
    await act(async () => { router.history.forward(); });
    expect(input().value).toBe("direct");
    expect(selection().value).toBe("beta");
    fireEvent.change(input(), { target: { value: "" } });
    await advance(210);
    expect(router.state.location.search.q).toBeUndefined();
    expect(screen.queryByText("beta: direct accepted evidence")).toBeNull();
    fireEvent.change(input(), { target: { value: "discard this" } });
    await act(async () => { await router.navigate({ to: "/search", search: { projectId: "beta" } }); });
    expect(input().value).toBe("");
    await advance(250);
    expect(searchRequests().some(([url]) => String(url).includes("discard"))).toBe(false);
  });

  it("restores history even when its committed q is unchanged across filter entries", async () => {
    const { router } = await mount(["/search?q=release&projectId=alpha", "/search?q=release&projectId=beta"]);
    await screen.findByText("beta: release accepted evidence");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "pending" } });
    await act(async () => { router.history.back(); });
    expect(input().value).toBe("release");
    expect(selection().value).toBe("alpha");
    await advance(250);
    expect(searchRequests().some(([url]) => String(url).includes("pending"))).toBe(false);
  });

  it("keeps an edited committed query through a filter change and trims only its submitted value", async () => {
    const { router } = await mount();
    await screen.findByText("alpha: release accepted evidence");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "release plan " } });
    await advance(100);
    await act(async () => { fireEvent.change(selection(), { target: { value: "beta" } }); });
    expect(input().value).toBe("release plan ");
    await advance(110);
    expect(router.state.location.search.q).toBe("release plan");
    expect(input().value).toBe("release plan ");
    expect(searchRequests().at(-1)?.[0]).toContain("q=release+plan&");
    expect(searchRequests().at(-1)?.[0]).toContain("projectId=beta");
  });
});

describe("shared project query and durable scoped search", () => {
  it.each(["direct", "shared"])("preserves the requested import project with a stale offline %s cache and queues its exact ID", async (entry) => {
    await mirror.saveToCache(mirror.PROJECTS_KEY, [projects[0]!], { fetchedAt, scope: "projects:list" });
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline"));
    onlineManager.setOnline(false);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { client, router } = await mount([entry === "shared" ? "/search" : "/import?projectId=beta"]);
    await waitFor(() => expect(client.getQueryData(["projects"])).toMatchObject({ provenance: { source: "cache", fetchedAt } }));
    if (entry === "shared") await act(async () => { await router.navigate({ to: "/import", search: { projectId: "beta" } }); });
    const select = screen.getByRole("combobox", { name: "Import project" }) as HTMLSelectElement;
    expect(select.value).toBe("beta");
    expect(select.selectedOptions[0]?.textContent).toBe("Unavailable project (beta)");
    fireEvent.change(screen.getByPlaceholderText(/Paste Markdown or plain text/), { target: { value: "fact: synthetic offline import" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const db = await offlineDb();
    await waitFor(async () => expect(await db.getAll("mutations")).toMatchObject([
      { method: "POST", url: "/api/imports/text", body: { projectId: "beta", text: "fact: synthetic offline import" }, idempotencyKey: expect.any(String) },
    ]));
    const [queued] = await db.getAll("mutations");
    // Offline rows use an absent deliveryState for queued, without a send lease.
    expect(queued.deliveryState).toBeUndefined();
    expect(queued.inFlightOwner).toBeUndefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false));
    expect(router.state.location.href).toBe("/import?projectId=beta");
    expect(select.value).toBe("beta");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/imports/text")).toBe(false);
  });

  it("allows an authoritative network list to invalidate an unknown import project", async () => {
    availableProjects = [projects[0]!];
    const { client, router } = await mount(["/import?projectId=beta"]);
    await waitFor(() => expect(client.getQueryData(["projects"])).toMatchObject({ provenance: { source: "network", fetchedAt } }));
    const select = screen.getByRole("combobox", { name: "Import project" }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
    expect(select.selectedOptions[0]?.textContent).toBe("Unassigned (no project)");
    onlineManager.setOnline(false);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    fireEvent.change(screen.getByPlaceholderText(/Paste Markdown or plain text/), { target: { value: "fact: synthetic unassigned import" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const db = await offlineDb();
    await waitFor(async () => expect(await db.getAll("mutations")).toMatchObject([
      { method: "POST", url: "/api/imports/text", body: { projectId: null, text: "fact: synthetic unassigned import" }, idempotencyKey: expect.any(String) },
    ]));
    const [queued] = await db.getAll("mutations");
    expect(queued.deliveryState).toBeUndefined();
    expect(queued.inFlightOwner).toBeUndefined();
    await waitFor(() => expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false));
    expect(router.state.location.href).toBe("/import?projectId=beta");
  });

  it.each(["/search", "/"])("deduplicates Shell and %s and keeps a compatible value on other pages", async (path) => {
    const { client, router } = await mount([path]);
    await waitFor(() => expect(screen.getByTestId("shell-projects").textContent).toContain("Project Alpha"));
    expect(client.getQueryData(["projects"])).toEqual({ data: projects, provenance: { source: "network", fetchedAt } });
    for (const to of ["/", "/search", "/import", "/corrections", "/inbox"] as const) {
      await act(async () => { await router.navigate({ to }); });
      expect(screen.queryByText(/Something went wrong/)).toBeNull();
      expect(screen.getByTestId("shell-projects").textContent).toContain("Project Alpha");
    }
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/projects")).toHaveLength(1);
    await waitFor(async () => expect(await mirror.readCache(mirror.PROJECTS_KEY, "projects:list")).toMatchObject({ value: projects, provenance: { fetchedAt } }));
  });

  it("refreshes the shared list after creating a project and preserves partial portfolio/error displays", async () => {
    const { client } = await mount(["/"]);
    await screen.findByRole("heading", { name: "Project Alpha" });
    expect(screen.getByText(/din 75 proiecte/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByPlaceholderText("Project or component name"), { target: { value: "Project Gamma" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "Project Gamma" });
    expect(screen.getByTestId("shell-projects").textContent).toContain("Project Gamma");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/projects" && init?.method === "GET")).toHaveLength(2);
    fetchMock.mockImplementation(async (url, init) => url === "/api/projects"
      ? new Response(JSON.stringify({ error: { code: "unavailable", message: "Synthetic service error" } }), { status: 503 })
      : serve(url, init));
    await act(async () => { await client.invalidateQueries({ queryKey: ["projects"] }); });
    expect(await screen.findByText(/Showing the previously loaded project list/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Project Gamma" })).toBeTruthy();
    expect(screen.queryByText(/no cached copy exists/i)).toBeNull();
  });

  it.each(["canonical", "working"] as const)("shows the selected name and only exact populated %s results offline", async (scope) => {
    await mirror.saveToCache(mirror.PROJECTS_KEY, projects, { fetchedAt, scope: "projects:list" });
    await cacheSearch("alpha", "canonical");
    await cacheSearch("alpha", "working");
    await cacheSearch("beta", scope);
    await cacheSearch(null, scope);
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline transport"));
    onlineManager.setOnline(false);
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { router } = await mount([`/search?q=release&projectId=alpha&scope=${scope}`]);
    const label = scope === "working" ? "proposal" : "accepted evidence";
    await screen.findByText(`alpha: release ${label}`);
    expect(selection().value).toBe("alpha");
    expect(selection().selectedOptions[0]?.textContent).toBe("Project Alpha");
    expect(screen.getByText(/Cached project list/).textContent).toContain("2026");
    expect(screen.getByText(/Offline — showing the last cached search/)).toBeTruthy();
    expect(screen.queryByText(`beta: release ${label}`)).toBeNull();
    expect(screen.queryByText(`global: release ${label}`)).toBeNull();
    expect(screen.queryByText(`alpha: release ${scope === "working" ? "accepted evidence" : "proposal"}`)).toBeNull();
    await act(async () => { await router.navigate({ to: "/search", search: { q: "uncached", projectId: "beta", scope } }); });
    await screen.findByText(/Search is unavailable offline/);
    expect(selection().value).toBe("beta");
    expect(screen.queryByText(/alpha: release/)).toBeNull();
    expect(screen.queryByText(/beta: release/)).toBeNull();
    expect(screen.queryByText(/global: release/)).toBeNull();
  });

  it("shows an unavailable project identity without widening an offline scoped search", async () => {
    await cacheSearch("alpha", "canonical");
    await cacheSearch(null, "canonical");
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline transport"));
    await mount();
    await screen.findByText("alpha: release accepted evidence");
    expect(selection().value).toBe("alpha");
    expect(selection().selectedOptions[0]?.textContent).toBe("Unavailable project (alpha)");
    expect(searchRequests().every(([url]) => String(url).includes("projectId=alpha"))).toBe(true);
    expect(screen.queryByText("global: release accepted evidence")).toBeNull();
  });

  it("retains cached project provenance when navigating from offline search to Projects", async () => {
    await mirror.saveToCache(mirror.PROJECTS_KEY, projects, { fetchedAt, scope: "projects:list" });
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline transport"));
    const { router } = await mount(["/search?projectId=alpha"]);
    await screen.findByText(/Cached project list/);
    await act(async () => { await router.navigate({ to: "/" }); });
    await screen.findByRole("heading", { name: "Project Alpha" });
    expect(screen.getByText(/Offline — showing the last loaded project list/).textContent).toContain("2026");
    expect(screen.getByTestId("shell-projects").textContent).toContain("Cached projects");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/projects")).toHaveLength(1);
  });

  it("never substitutes cached project identities for an authorization rejection", async () => {
    await mirror.saveToCache(mirror.PROJECTS_KEY, projects, { fetchedAt, scope: "projects:list" });
    const readCache = vi.spyOn(mirror, "readCache");
    fetchMock.mockImplementation(async (url, init) => url === "/api/projects"
      ? new Response(JSON.stringify({ error: { code: "forbidden", message: "Synthetic denial" } }), { status: 403 })
      : serve(url, init));
    await mount(["/search?projectId=alpha"]);
    await screen.findByText("Project list is not available with the current authorization.");
    expect(readCache).not.toHaveBeenCalled();
    expect(selection().value).toBe("alpha");
    expect(selection().selectedOptions[0]?.textContent).toBe("Unavailable project (alpha)");
    expect(screen.queryByRole("option", { name: "Project Alpha" })).toBeNull();
    expect(screen.getByTestId("shell-projects").textContent).not.toContain("Project Alpha");
  });
});

describe("search transport cancellation", () => {
  it.each(["abort rejection", "late response"])("aborts obsolete fetches (%s), avoids fallback/retry and retains only the latest result", async (completion) => {
    await cacheSearch("alpha", "canonical", "old");
    const readCache = vi.spyOn(mirror, "readCache");
    const saveCache = vi.spyOn(mirror, "saveToCacheBestEffort");
    let oldSignal: AbortSignal | undefined;
    let releaseOld: (() => void) | undefined;
    fetchMock.mockImplementation((url, init) => {
      if (String(url).includes("q=old&")) {
        oldSignal = init?.signal ?? undefined;
        // Deliberately ignore abort until the late response arrives. The
        // caller must still reject it and must not publish it to the mirror.
        return new Promise((resolve, reject) => {
          if (completion === "abort rejection") oldSignal?.addEventListener("abort", () => reject(new DOMException("Synthetic abort", "AbortError")), { once: true });
          releaseOld = () => resolve(response(result("old"), init));
        });
      }
      return serve(url, init);
    });
    const { client, router } = await mount(["/search?q=old&projectId=alpha"]);
    await waitFor(() => expect(oldSignal).toBeDefined());
    await act(async () => { await router.navigate({ to: "/search", search: { q: "latest", projectId: "beta", scope: "working" } }); });
    expect(oldSignal?.aborted).toBe(true);
    await screen.findByText("beta: latest proposal");
    await act(async () => { releaseOld!(); });
    expect(screen.queryByText("alpha: old accepted evidence")).toBeNull();
    expect(screen.queryByText(/Offline —|Search.*cancelled|Search.*failed/)).toBeNull();
    expect(readCache).not.toHaveBeenCalled();
    expect(saveCache.mock.calls.some(([key]) => String(key).includes('"old"'))).toBe(false);
    expect(searchRequests().filter(([url]) => String(url).includes("q=old&"))).toHaveLength(1);
    expect(client.getQueryState(["search", "old", false, "alpha", "canonical", "", "", "", 50])?.error).toBeNull();
    expect(client.getQueryData(["search", "latest", false, "beta", "working", "", "", "", 50])).toMatchObject({ data: { query: "latest" }, provenance: { source: "network" } });
  });

  it("does not retry, use cached results or display an error for an auth-transition cancellation", async () => {
    await cacheSearch("alpha", "canonical");
    const readCache = vi.spyOn(mirror, "readCache");
    setPrivateReadsPausedForAuthTransition(true);
    const { client } = await mount(["/search?q=release&projectId=alpha"], false);
    await waitFor(() => expect(client.getQueryState(["search", "release", false, "alpha", "canonical", "", "", "", 50])?.status).toBe("error"));
    expect(client.getQueryState(["search", "release", false, "alpha", "canonical", "", "", "", 50])?.fetchFailureCount).toBe(1);
    expect(searchRequests()).toHaveLength(0);
    expect(readCache).not.toHaveBeenCalled();
    expect(screen.queryByText(/Search.*cancelled|Offline —|alpha: release/)).toBeNull();
  });
});

function boundedResult(params: URLSearchParams, total = 80): SearchResultDto {
  const scope = params.get("scope") ?? "canonical";
  const data = result(params.get("q")!, params.get("projectId") ?? "alpha", scope);
  const limit = Number(params.get("limit") ?? 50);
  const rows = (working: boolean) => Array.from({ length: Math.min(limit, total) }, (_, index) => ({
    ...record(params.get("projectId") ?? "alpha", `match ${index + 1}`, working),
    type: (params.get("recordType") ?? "fact") as RecordDto["type"],
  }));
  data.records = scope === "working" ? [] : rows(false);
  data.workingRecords = scope === "canonical" ? [] : rows(true);
  const part = (returned: number, more: boolean) => ({ returned, limit, mayHaveMore: more, candidateLimitReached: total > 200 });
  data.completeness = {
    records: part(data.records.length, scope !== "working" && total > limit),
    workingRecords: part(data.workingRecords.length, scope !== "canonical" && total > limit),
    projects: { ...part(0, false), limit: 20 }, sources: { ...part(0, false), limit: 10 },
  };
  return data;
}
function serveBounded(total = 80) {
  fetchMock.mockImplementation(async (url, init) => String(url).startsWith("/api/search?")
    ? response(boundedResult(new URLSearchParams(String(url).split("?")[1]), total), init)
    : serve(url, init));
}
function lastSearchParams() { return new URLSearchParams(String(searchRequests().at(-1)![0]).split("?")[1]); }

describe("record filters and bounded result windows", () => {
  it("shares every filter and limit through URL, request, query key and exact durable identity", async () => {
    serveBounded();
    const identity = { query: "release", projectId: "beta", includeHistorical: true, scope: "all" as const, recordType: "decision", recordedFrom: "2026-09-01", recordedTo: "2026-09-30", limit: 100 };
    const { client, router } = await mount(["/search?q=release&projectId=beta&includeHistorical=true&scope=all&recordType=decision&recordedFrom=2026-09-01&recordedTo=2026-09-30&limit=100"]);
    await screen.findByText("beta: match 80 accepted evidence");
    expect(lastSearchParams()).toEqual(new URLSearchParams({ q: "release", mode: "discovery", includeHistorical: "true", scope: "all", limit: "100", projectId: "beta", recordType: "decision", recordedFrom: "2026-09-01", recordedTo: "2026-09-30" }));
    expect(client.getQueryData(["search", "release", true, "beta", "all", "decision", "2026-09-01", "2026-09-30", 100])).toMatchObject({ provenance: { source: "network", fetchedAt } });
    expect((screen.getByLabelText("Record type") as HTMLSelectElement).value).toBe("decision");
    expect((screen.getByLabelText("Recorded from (UTC)") as HTMLInputElement).value).toBe("2026-09-01");
    expect((screen.getByLabelText("Recorded to (UTC)") as HTMLInputElement).value).toBe("2026-09-30");
    const { query, ...routeFilters } = identity;
    expect(router.state.location.search).toMatchObject({ ...routeFilters, q: query });
    await waitFor(async () => expect(await mirror.readCache(mirror.searchKey(identity), searchCacheScope(identity))).toMatchObject({ value: { records: expect.any(Array) }, provenance: { fetchedAt } }));
    cleanup();
    client.clear();
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline"));
    await mount([router.state.location.href]);
    await screen.findByText(/Offline — showing the last cached search/);
    expect(screen.getByText("beta: match 80 proposal")).toBeTruthy();
    expect(screen.getByText(/Offline — showing the last cached search/).textContent).toContain("2026");
  });

  it.each(["recordType=fact", "recordedFrom=2026-09-01", "recordedTo=2026-09-30", "limit=100"])("never falls back to unfiltered or smaller legacy windows for %s offline", async (filter) => {
    await cacheSearch("alpha", "canonical");
    await mirror.saveToCache(mirror.legacyCanonicalSearchKey({ query: "release", includeHistorical: false, projectId: "alpha" }), result(), { scope: "search:q=release:historical=false:project=alpha" });
    await mirror.saveToCache(mirror.SEARCH_LAST_KEY, { query: "release", includeHistorical: false, projectId: "alpha", data: result() });
    const read = vi.spyOn(mirror, "readCache");
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline"));
    await mount([`/search?q=release&projectId=alpha&${filter}`]);
    await screen.findByText(/Search is unavailable offline/);
    expect(screen.queryByText(/Offline — showing the last cached search|alpha: release/)).toBeNull();
    expect(read.mock.calls.filter(([key]) => key.startsWith("search:"))).toHaveLength(1);
    expect(read.mock.calls.some(([key]) => key === mirror.SEARCH_LAST_KEY)).toBe(false);
  });

  it("keeps filtered cache boundaries across canonical, working and mixed scopes", async () => {
    const base = { query: "release", includeHistorical: false, projectId: "alpha", recordType: "fact", limit: 100 };
    for (const scope of ["canonical", "working"] as const) {
      const identity = { ...base, scope };
      await mirror.saveToCache(mirror.searchKey(identity), result("release", "alpha", scope), { fetchedAt, scope: searchCacheScope(identity) });
    }
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline"));
    const { router } = await mount(["/search?q=release&projectId=alpha&recordType=fact&limit=100"]);
    await screen.findByText("alpha: release accepted evidence");
    expect(screen.queryByText("alpha: release proposal")).toBeNull();
    await act(async () => { await router.navigate({ to: "/search", search: { q: "release", projectId: "alpha", recordType: "fact", limit: 100, scope: "working" } }); });
    await screen.findByText("alpha: release proposal");
    expect(screen.queryByText("alpha: release accepted evidence")).toBeNull();
    await act(async () => { await router.navigate({ to: "/search", search: { q: "release", projectId: "alpha", recordType: "fact", limit: 100, scope: "all" } }); });
    await screen.findByText(/Search is unavailable offline/);
    expect(screen.queryByText(/alpha: release/)).toBeNull();
  });

  it("replaces 50 with 80 unique results at limit 100 and restores each bounded window through history", async () => {
    serveBounded();
    const { router } = await mount();
    await screen.findByText("alpha: match 50 accepted evidence");
    expect(screen.queryByText("alpha: match 51 accepted evidence")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    await screen.findByText("alpha: match 80 accepted evidence");
    expect(lastSearchParams().get("limit")).toBe("100");
    expect(router.state.location.search.limit).toBe(100);
    expect(screen.getAllByText(/alpha: match \d+ accepted evidence/)).toHaveLength(80);
    expect(screen.getAllByText("alpha: match 1 accepted evidence")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
    await act(async () => { router.history.back(); });
    await screen.findByRole("heading", { name: /Records \(50\)/ });
    expect(screen.queryByText("alpha: match 51 accepted evidence")).toBeNull();
    await act(async () => { router.history.forward(); });
    await screen.findByRole("heading", { name: /Records \(80\)/ });
    expect(router.state.location.search.limit).toBe(100);
  });

  it("offers 50, 100, 150, 200 only and explains the per-group cap and separate discovery limits", async () => {
    serveBounded(300);
    await mount(["/search?q=release&scope=all"]);
    for (const limit of [50, 100, 150, 200]) {
      await screen.findByRole("heading", { name: new RegExp(`^Records \\(${limit}\\)`) });
      expect(lastSearchParams().get("limit")).toBe(String(limit));
      if (limit < 200) fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    }
    expect(screen.getByText(/Showing up to 200 per record group; refine search/)).toBeTruthy();
    expect(screen.getByText(/Discovery projects: up to 20; sources: up to 10/)).toBeTruthy();
    expect(screen.getByText(/Candidate limit reached; additional matches may exist/)).toBeTruthy();
    expect(screen.queryByText(/including before filtering/)).toBeNull();
    expect(screen.queryByText(/No additional matches indicated/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
    expect(searchRequests()).toHaveLength(4);
  });

  it("does not offer record expansion for discovery-only incompleteness", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (!String(url).startsWith("/api/search?")) return serve(url, init);
      const data = boundedResult(new URLSearchParams(String(url).split("?")[1]), 1);
      data.completeness.projects.mayHaveMore = true;
      return response(data, init);
    });
    await mount();
    await screen.findByText(/More discovery matches may exist/);
    expect(screen.queryByRole("button", { name: "Show more results" })).toBeNull();
  });

  it.each(["query", "project", "scope", "historical", "type", "from", "to"])("resets the window to 50 when %s changes", async (filter) => {
    serveBounded(300);
    const { router } = await mount(["/search?q=release&projectId=alpha&limit=100"]);
    await screen.findByRole("heading", { name: /Records \(100\)/ });
    if (filter === "query") fireEvent.change(input(), { target: { value: "new query" } });
    if (filter === "project") fireEvent.change(selection(), { target: { value: "beta" } });
    if (filter === "scope") fireEvent.change(screen.getByLabelText("Memory scope"), { target: { value: "working" } });
    if (filter === "historical") fireEvent.click(screen.getByLabelText("Include historical (superseded)"));
    if (filter === "type") fireEvent.change(screen.getByLabelText("Record type"), { target: { value: "decision" } });
    if (filter === "from") fireEvent.change(screen.getByLabelText("Recorded from (UTC)"), { target: { value: "2026-09-01" } });
    if (filter === "to") fireEvent.change(screen.getByLabelText("Recorded to (UTC)"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect(lastSearchParams().get("limit")).toBe("50"));
    expect(router.state.location.search.limit).toBeUndefined();
    expect(searchRequests()).toHaveLength(2);
  });

  it("preserves the latest draft across rapid type/date/filter changes and commits it after 200ms", async () => {
    const { router } = await mount(["/search?limit=100"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(input(), { target: { value: "first draft" } });
    await advance(80);
    await act(async () => { fireEvent.change(screen.getByLabelText("Record type"), { target: { value: "constraint" } }); });
    fireEvent.change(input(), { target: { value: "newer draft " } });
    await advance(80);
    await act(async () => { fireEvent.change(screen.getByLabelText("Recorded from (UTC)"), { target: { value: "2026-09-01" } }); });
    await act(async () => { fireEvent.change(screen.getByLabelText("Recorded to (UTC)"), { target: { value: "2026-09-30" } }); });
    await act(async () => { fireEvent.change(selection(), { target: { value: "beta" } }); });
    expect(input().value).toBe("newer draft ");
    expect(searchRequests()).toHaveLength(0);
    await advance(121);
    expect(router.state.location.search).toMatchObject({ q: "newer draft", projectId: "beta", recordType: "constraint", recordedFrom: "2026-09-01", recordedTo: "2026-09-30" });
    expect(input().value).toBe("newer draft ");
    expect(lastSearchParams().get("limit")).toBe("50");
    expect(searchRequests()).toHaveLength(1);
  });

  it.each([
    ["recordedFrom=2026-02-30", "2026-02-30"],
    ["recordedTo=not-a-date", "not-a-date"],
    ["recordedFrom=2026-09-30&recordedTo=2026-09-01", "must be on or before"],
    ["recordType=unknown", "unknown"], ["limit=201", "201"], ["limit=1.5", "1.5"],
    ["scope=unknown", "Invalid memory scope"],
  ])("retains invalid URL meaning for %s without searching or reporting offline success", async (filter, message) => {
    await cacheSearch("alpha", "canonical");
    fetchMock.mockImplementation(async (url, init) => url === "/api/projects" ? serve(url, init) : Promise.reject(new TypeError("Synthetic offline")));
    await mount([`/search?q=release&projectId=alpha&${filter}`]);
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(searchRequests()).toHaveLength(0);
    expect(screen.queryByText(/Offline — showing the last cached search|alpha: release/)).toBeNull();
  });

  it.each(["recordType", "recordedFrom", "recordedTo", "scope", "limit"])("rejects raw empty %s without requests or any unfiltered cache fallback", async (field) => {
    await cacheSearch("alpha", "canonical");
    await mirror.saveToCache(mirror.legacyCanonicalSearchKey({ query: "release", includeHistorical: false, projectId: "alpha" }), result(), { scope: "search:q=release:historical=false:project=alpha" });
    await mirror.saveToCache(mirror.SEARCH_LAST_KEY, { query: "release", includeHistorical: false, projectId: "alpha", data: result() });
    const read = vi.spyOn(mirror, "readCache");
    fetchMock.mockRejectedValue(new TypeError("Synthetic offline"));
    const { router } = await mount([`/search?q=release&projectId=alpha&${field}=`]);
    expect((await screen.findByRole("alert")).textContent).toContain("“”");
    expect(new URLSearchParams(router.state.location.searchStr).get(field)).toBe("");
    expect(searchRequests()).toHaveLength(0);
    expect(read.mock.calls.filter(([key]) => key.startsWith("search:"))).toHaveLength(0);
    expect(screen.queryByText(/Offline — showing the last cached search|alpha: release/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset invalid filters" }));
    await screen.findByText("alpha: release accepted evidence");
    expect(new URLSearchParams(router.state.location.searchStr).has(field)).toBe(false);
    expect(lastSearchParams().has(field)).toBe(field === "scope" || field === "limit");
    expect(searchRequests()).toHaveLength(1);
    // The same invalid URL must also hide an already populated query cache.
    read.mockClear();
    fetchMock.mockClear();
    await act(async () => { await router.navigate({ href: `/search?q=release&projectId=alpha&${field}=` }); });
    expect((await screen.findByRole("alert")).textContent).toContain("“”");
    expect(screen.queryByText(/Offline — showing the last cached search|alpha: release/)).toBeNull();
    expect(searchRequests()).toHaveLength(0);
    expect(read.mock.calls.filter(([key]) => key.startsWith("search:"))).toHaveLength(0);
  });

  it.each([
    ["recordType", "Record type", "decision", ""],
    ["recordedFrom", "Recorded from (UTC)", "2026-09-01", ""],
    ["recordedTo", "Recorded to (UTC)", "2026-09-30", ""],
    ["scope", "Memory scope", "working", "canonical"],
  ])("omits %s when its control is reset and preserves an ordinary unfiltered URL", async (field, label, initial, reset) => {
    const { router } = await mount([`/search?q=release&${field}=${initial}&limit=100`]);
    await waitFor(() => expect(searchRequests()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(label), { target: { value: reset } });
    await waitFor(() => expect(router.state.location.href).toBe("/search?q=release"));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(searchRequests()).toHaveLength(2));
    expect(lastSearchParams().get("scope")).toBe("canonical");
    expect(lastSearchParams().get("limit")).toBe("50");
  });

  it("blocks a reversed date edit, restores valid dates via Back, and supports explicit reset", async () => {
    const { router } = await mount(["/search?q=release&recordedFrom=2026-09-01&recordedTo=2026-09-30&limit=100"]);
    await screen.findByText("alpha: release accepted evidence");
    fireEvent.change(screen.getByLabelText("Recorded from (UTC)"), { target: { value: "2026-10-01" } });
    expect((await screen.findByRole("alert")).textContent).toContain("must be on or before");
    expect(screen.queryByText("alpha: release accepted evidence")).toBeNull();
    expect(searchRequests()).toHaveLength(1);
    await act(async () => { router.history.back(); });
    await screen.findByText("alpha: release accepted evidence");
    expect(router.state.location.search.limit).toBe(100);
    expect((screen.getByLabelText("Recorded from (UTC)") as HTMLInputElement).value).toBe("2026-09-01");
    await act(async () => { router.history.forward(); });
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Reset invalid filters" }));
    await waitFor(() => expect(lastSearchParams().has("recordedFrom")).toBe(false));
    expect(lastSearchParams().get("limit")).toBe("50");
  });

  it("aborts a growing window on a filter change and cannot cache its late response", async () => {
    let growingSignal: AbortSignal | undefined;
    let finish!: () => void;
    fetchMock.mockImplementation((url, init) => {
      if (!String(url).startsWith("/api/search?")) return serve(url, init);
      const params = new URLSearchParams(String(url).split("?")[1]);
      if (params.get("limit") === "100") {
        growingSignal = init?.signal ?? undefined;
        return new Promise(resolve => { finish = () => resolve(response(boundedResult(params), init)); });
      }
      return Promise.resolve(response(boundedResult(params), init));
    });
    await mount();
    await screen.findByText("alpha: match 50 accepted evidence");
    fireEvent.click(screen.getByRole("button", { name: "Show more results" }));
    await waitFor(() => expect(growingSignal).toBeDefined());
    fireEvent.change(screen.getByLabelText("Memory scope"), { target: { value: "working" } });
    await screen.findByText("alpha: match 50 proposal");
    expect(growingSignal?.aborted).toBe(true);
    await act(async () => { finish(); });
    expect(screen.queryByText(/accepted evidence/)).toBeNull();
    const identity = { query: "release", includeHistorical: false, projectId: "alpha", limit: 100 };
    expect(await mirror.readCache(mirror.searchKey(identity), searchCacheScope(identity))).toBeNull();
  });
});
