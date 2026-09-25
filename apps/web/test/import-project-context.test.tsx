import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDto } from "@contextkeep/shared";

let searchProjectId: string | undefined = "project-1";
const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../src/lib/api.js", () => ({
  apiFetch: apiFetchMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../src/lib/hooks.js", () => ({
  isQueued: () => false,
  reportQueued: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/offline/queue.js", () => ({
  listConflicts: vi.fn(async () => []),
  dismissConflict: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-router", async () => {
  const R = await import("react");
  return {
    useSearch: () => ({ projectId: searchProjectId }),
    Link: ({ children, to, ...props }: any) => R.createElement("a", { href: to, ...props }, children),
  };
});

const { default: ImportPage } = await import("../src/pages/Import.js");

const projects: ProjectDto[] = [{
  id: "project-1",
  name: "Project One",
  aliases: [],
  parentId: null,
  description: null,
  lifecycle: "active",
  lifecycleRecordId: null,
  revision: 1,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
}];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ImportPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  searchProjectId = "project-1";
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/meta") return { adapters: [{ id: "manual", label: "Manual", enabled: true }] };
    if (url === "/api/projects") return projects;
    if (url === "/api/imports/text") return {
      status: "created",
      excerptCount: 1,
      candidateCount: 0,
      source: { id: "source-1" },
      warnings: [],
    };
    throw new Error(`unexpected API call ${url}`);
  });
});
afterEach(cleanup);

describe("import project context", () => {
  it("preselects a valid project from the route and uses it on the first submit", async () => {
    mount();
    expect(await screen.findByDisplayValue("Project One")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Paste Markdown or plain text/), {
      target: { value: "fact: scoped import" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      const call = apiFetchMock.mock.calls.find((entry) => entry[0] === "/api/imports/text");
      expect(call).toBeTruthy();
      expect(call![1].body.projectId).toBe("project-1");
    });
  });

  it("falls back to unassigned when the route project id is not present", async () => {
    searchProjectId = "missing-project";
    mount();

    await waitFor(() => {
      const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      expect(select.value).toBe("");
    });
  });
});
