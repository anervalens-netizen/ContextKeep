import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("../src/lib/api.js", () => ({ apiFetch: apiFetchMock }));

const { ShellAccountControls } = await import("../src/components/ShellAccountControls.js");

function mount(props: Partial<React.ComponentProps<typeof ShellAccountControls>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLogout = props.onLogout ?? vi.fn(async () => undefined);
  const onDeleteLocalData = props.onDeleteLocalData ?? vi.fn(async () => ({
    status: "complete" as const,
    summary: { queued: 0, inFlight: 0, conflicts: 0, unknownOutcome: 0, reviewRequired: 0, unsafeCount: 0 },
    errors: [] as [],
    removedCaches: [],
  }));
  render(
    <QueryClientProvider client={client}>
      <ShellAccountControls
        authenticated
        showInstall={false}
        installGateReason=""
        onInstall={async () => undefined}
        onLogout={onLogout}
        onDeleteLocalData={onDeleteLocalData}
      />
    </QueryClientProvider>,
  );
  return { onLogout, onDeleteLocalData };
}

beforeEach(() => {
  apiFetchMock.mockResolvedValue({});
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("CK-A14 account/local data controls", () => {
  it("keeps sign-out separate from local-data deletion", async () => {
    const { onLogout, onDeleteLocalData } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Account & app" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    expect(onDeleteLocalData).not.toHaveBeenCalled();
  });

  it("blocks default deletion and requires a distinct explicit discard action", async () => {
    const onDeleteLocalData = vi.fn()
      .mockResolvedValueOnce({
        status: "blocked",
        summary: { queued: 1, inFlight: 0, conflicts: 1, unknownOutcome: 1, reviewRequired: 0, unsafeCount: 2 },
        errors: [],
      })
      .mockResolvedValueOnce({
        status: "complete",
        summary: { queued: 1, inFlight: 0, conflicts: 1, unknownOutcome: 1, reviewRequired: 0, unsafeCount: 2 },
        errors: [],
        removedCaches: [],
      });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount({ onDeleteLocalData });

    fireEvent.click(screen.getByRole("button", { name: "Account & app" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete data on this device" }));

    expect(await screen.findByText(/Deletion blocked:/)).toBeTruthy();
    expect(onDeleteLocalData).toHaveBeenNthCalledWith(1, false);
    fireEvent.click(screen.getByRole("button", { name: "Discard unsynced local items and delete" }));
    await waitFor(() => expect(onDeleteLocalData).toHaveBeenNthCalledWith(2, true));
  });
});
