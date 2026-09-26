import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { offlineDb } from "../src/lib/offline/db.js";
import {
  isLocalDataAccessPaused,
  setLocalDataAccessPaused,
} from "../src/lib/offline/local-data-state.js";

const { fetchMock, navigate } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("../src/lib/api.js", () => ({
  apiFetch: fetchMock,
  isNetworkUnavailableError: () => false,
  setPrivateReadsPausedForAuthTransition: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
  useNavigate: () => navigate,
  Outlet: () => <div>Login content</div>,
}));
vi.mock("../src/components/AppShell.js", () => ({
  AppShell: () => <div>Authenticated server shell</div>,
}));
vi.mock("../src/lib/install-gate.js", () => ({
  captureInstallPrompt: () => () => {},
  currentInstallGate: () => ({ allowed: false, reason: "synthetic" }),
}));
const { Layout } = await import("../src/components/Layout.js");
const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  setLocalDataAccessPaused(false);
  vi.clearAllMocks();
});

describe("denied-storage startup", () => {
  it("offers an explicit online view without claiming cleanup or resuming local persistence", async () => {
    window.localStorage.setItem("ck:local-data-paused", "1");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    fetchMock.mockResolvedValue({ configured: true, authenticated: true });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Layout />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Browser storage unavailable" }),
    ).toBeTruthy();
    expect(screen.queryByText("Local ContextKeep data cleared")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Continue online without local storage",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Authenticated server shell")).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/status",
      expect.any(Object),
    );
    expect(isLocalDataAccessPaused()).toBe(true);
    await expect(offlineDb()).rejects.toThrow("paused");
    client.clear();
  });
  it("offers online-only recovery when reads work but privacy marker removal fails", async () => {
    setLocalDataAccessPaused(true);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic removal refusal", "SecurityError");
    });
    fetchMock.mockResolvedValue({ authenticated: true, needsSetup: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Layout /></QueryClientProvider>);
    expect(screen.getByText("Local ContextKeep data cleared")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue using ContextKeep" }));
    expect(await screen.findByText("Browser storage unavailable")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("ck:local-data-paused")).toBe("1");
    expect(isLocalDataAccessPaused()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue online without local storage" }));
    expect(await screen.findByText("Authenticated server shell")).toBeTruthy();
    expect(isLocalDataAccessPaused()).toBe(true);
    await expect(offlineDb()).rejects.toThrow(/paused/i);
    client.clear();
  });

});
