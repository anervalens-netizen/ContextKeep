import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUiStore } from "../src/state/ui.js";

const { apiFetchMock, setPrivateReadsPausedMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  setPrivateReadsPausedMock: vi.fn(),
}));
vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  setPrivateReadsPausedForAuthTransition: setPrivateReadsPausedMock,
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  QueuedOfflineError: class QueuedOfflineError extends Error {},
}));
vi.mock("../src/lib/install-gate.js", () => ({
  currentInstallGate: () => ({ allowed: true, reason: "" }),
  registerVisit: () => 1,
  captureInstallPrompt: () => () => undefined,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return actual;
});

const LoginPage = (await import("../src/pages/Login.js")).default;

function mount(): ReturnType<typeof render> {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={q}>
      <LoginPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  setPrivateReadsPausedMock.mockReset();
  useUiStore.setState({ conflicts: [], notice: null, queuedCount: 0 });
});

afterEach(cleanup);

describe("Login (F07): successful login resumes preserved 401 mutations", () => {
  it("successful login dispatches ck:retry-offline-queue exactly once after auth + CSRF cookies are active", async () => {
    // auth-status: already set up, not first run
    apiFetchMock.mockImplementation(
      (url: string, opts?: { method?: string; body?: unknown }) => {
        if (url === "/api/auth/status") {
          return Promise.resolve({ authenticated: false, needsSetup: false });
        }
        if (url === "/api/auth/login" && opts?.method === "POST") {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({});
      },
    );
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const input = await screen.findByPlaceholderText(/password/i);
    fireEvent.change(input, { target: { value: "owner-pwd" } });
    const submit = screen.getByRole("button", { name: /sign in/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(retrySpy).toHaveBeenCalledTimes(1);
      expect(setPrivateReadsPausedMock).toHaveBeenCalledWith(false);
    });
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });

  it("failed login does NOT dispatch the retry event", async () => {
    const apiErr = new Error("bad password");
    Object.assign(apiErr, {
      name: "ApiError",
      status: 401,
      code: "unauthorized",
    });
    apiFetchMock.mockImplementation((url: string) => {
      if (url === "/api/auth/status") {
        return Promise.resolve({ authenticated: false, needsSetup: false });
      }
      if (url === "/api/auth/login") {
        return Promise.reject(apiErr);
      }
      return Promise.resolve({});
    });
    const retrySpy = vi.fn();
    window.addEventListener("ck:retry-offline-queue", retrySpy);

    mount();
    const input = await screen.findByPlaceholderText(/password/i);
    fireEvent.change(input, { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    // Wait briefly to allow any spurious dispatch.
    await new Promise((r) => setTimeout(r, 50));
    expect(retrySpy).not.toHaveBeenCalled();
    window.removeEventListener("ck:retry-offline-queue", retrySpy);
  });
});
