import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layout } from "../src/components/Layout.js";
import { lazyPage } from "../src/lib/lazy-page.js";
import { apiFetch, setPrivateReadsPausedForAuthTransition } from "../src/lib/api.js";
import { setLocalDataAccessPaused } from "../src/lib/offline/local-data-state.js";
import { useUiStore } from "../src/state/ui.js";

// Keep the actual auth/privacy gate; simplify only shell presentation.
vi.mock("../src/components/AppShell.js", () => ({ AppShell: () => <Outlet /> }));

const fetchMock = vi.fn<typeof fetch>();
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function PrivatePage() {
  const query = useQuery({ queryKey: ["private-fixture"], queryFn: () => apiFetch<{ message: string }>("/api/projects") });
  return <p>{query.data?.message ?? "Private page waiting"}</p>;
}
function dataResponse(init?: RequestInit) {
  return new Response(JSON.stringify({ message: "Authenticated page data" }), { headers: {
    "x-contextkeep-data-source": "network-v1",
    "x-contextkeep-fetched-at": "2026-09-25T12:00:00.000Z",
    "x-contextkeep-response-id": new Headers(init?.headers).get("x-contextkeep-request-id")!,
  } });
}
async function mount(loader: () => Promise<{ default: () => React.ReactNode }>) {
  const root = createRootRoute({ component: Layout });
  const page = createRoute({ getParentRoute: () => root, path: "/", ...lazyPage(loader) });
  const login = createRoute({ getParentRoute: () => root, path: "/login", component: () => <p>Sign-in screen</p> });
  const router = createRouter({ routeTree: root.addChildren([page, login]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  await router.load();
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
beforeEach(() => {
  localStorage.clear();
  setLocalDataAccessPaused(false);
  setPrivateReadsPausedForAuthTransition(false);
  useUiStore.getState().setOffline(false);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setLocalDataAccessPaused(false);
  vi.unstubAllGlobals();
});

describe("public route code preloading with the existing auth gate", () => {
  it("starts code and authentication independently and fetches private data only after authentication", async () => {
    const code = deferred<{ default: () => React.ReactNode }>();
    const auth = deferred<Response>();
    const loader = vi.fn(() => code.promise);
    fetchMock.mockImplementation((url, init) => String(url) === "/api/auth/status" ? auth.promise : Promise.resolve(dataResponse(init)));
    await mount(loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/status"]);
    expect(screen.getByText("Loading ContextKeep…")).toBeTruthy();
    await act(async () => { code.resolve({ default: PrivatePage }); });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/status"]);
    expect(screen.queryByText("Private page waiting")).toBeNull();
    await act(async () => { auth.resolve(new Response(JSON.stringify({ authenticated: true, needsSetup: false }))); });
    expect(await screen.findByText("Authenticated page data")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/status", "/api/projects"]);
  });

  it("keeps authentication responsive when route code is slow", async () => {
    const code = deferred<{ default: () => React.ReactNode }>();
    fetchMock.mockImplementation(async (url, init) => String(url) === "/api/auth/status"
      ? new Response(JSON.stringify({ authenticated: true, needsSetup: false })) : dataResponse(init));
    await mount(() => code.promise);
    await screen.findByText("Loading…");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/status"]);
    await act(async () => { code.resolve({ default: PrivatePage }); });
    expect(await screen.findByText("Authenticated page data")).toBeTruthy();
  });

  it("redirects unauthenticated users without mounting preloaded private pages", async () => {
    const loader = vi.fn(async () => ({ default: PrivatePage }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ authenticated: false, needsSetup: false })));
    const router = await mount(loader);
    await screen.findByText("Sign-in screen");
    expect(router.state.location.pathname).toBe("/login");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/auth/status"]);
    expect(screen.queryByText("Private page waiting")).toBeNull();
  });

  it("honors the local privacy pause even when route code has been preloaded", async () => {
    setLocalDataAccessPaused(true);
    const loader = vi.fn(async () => ({ default: PrivatePage }));
    await mount(loader);
    await screen.findByText("Local ContextKeep data cleared");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a failed speculative import to retry when the authenticated route mounts", async () => {
    const auth = deferred<Response>();
    const loader = vi.fn<() => Promise<{ default: typeof PrivatePage }>>()
      .mockRejectedValueOnce(new Error("Synthetic chunk failure"))
      .mockResolvedValue({ default: PrivatePage });
    fetchMock.mockImplementation((url, init) => String(url) === "/api/auth/status" ? auth.promise : Promise.resolve(dataResponse(init)));
    await mount(loader);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await act(async () => { auth.resolve(new Response(JSON.stringify({ authenticated: true, needsSetup: false }))); });
    await screen.findByText("Authenticated page data");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
