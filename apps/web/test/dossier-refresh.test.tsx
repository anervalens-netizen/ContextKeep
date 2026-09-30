import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  ProjectNow,
  TaskNow,
  type ProjectDossier,
  type TaskDossier,
} from "../src/components/OperationalDossier.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const task = (id: string, title = id) => ({
  taskId: id,
  title,
  state: "in_progress",
  summary: null,
  nextAction: null,
  ownerAction: null,
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  activeBlockers: 0,
  executionStatus: null,
  verification: null,
  stateToken: title,
  taskRevision: 1,
});
function page(
  projectId: string,
  rows: ReturnType<typeof task>[],
  offset = 0,
): ProjectDossier {
  return {
    project: { id: projectId, name: projectId, lifecycle: "active" },
    goals: [],
    tasks: rows.slice(offset, offset + 2),
    pagination: {
      total: rows.length,
      nextOffset: offset + 2 < rows.length ? offset + 2 : null,
    },
    historicalUnscopedCheckpoints: 0,
    links: { items: [] },
  };
}
const tick = () =>
  act(async () => {
    vi.advanceTimersByTime(15000);
  });
describe("project dossier paging stays live", () => {
  it("refreshes every loaded page and follows moved page boundaries without duplicate cards", async () => {
    let rows = [
      task("one", "Old first"),
      task("two"),
      task("three"),
      task("four"),
    ];
    const load = vi.fn(async (id: string, offset = 0) =>
      page(id, rows, offset),
    );
    await act(async () => {
      render(<ProjectNow projectId="fixture" load={load} onTask={() => {}} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Mai multe lucrări" }),
      );
    });
    expect(screen.getByText("four")).toBeTruthy();
    rows = [
      task("four", "Updated fourth"),
      task("one", "Updated first"),
      task("two"),
      task("three"),
    ];
    const before = load.mock.calls.length;
    await tick();
    expect(load.mock.calls.length).toBe(before + 2);
    expect(screen.getAllByText("Updated first")).toHaveLength(1);
    expect(screen.getByText("Updated fourth")).toBeTruthy();
    expect(screen.queryByText("Old first")).toBeNull();
    expect(screen.getByText("three")).toBeTruthy();
  });
  it("continues polling after a failed next page and permits a later retry", async () => {
    let fail = true,
      rows = [task("one", "Old first"), task("two"), task("three")];
    const load = vi.fn(async (id: string, offset = 0) => {
      if (offset && fail) throw new Error("Synthetic pagination outage");
      return page(id, rows, offset);
    });
    await act(async () => {
      render(<ProjectNow projectId="fixture" load={load} onTask={() => {}} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Mai multe lucrări" }),
      );
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    rows = [task("one", "Updated first"), task("two"), task("three")];
    await tick();
    expect(screen.getByText("Updated first")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fail = false;
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Mai multe lucrări" }),
      );
    });
    expect(screen.getByText("three")).toBeTruthy();
  });
  it("discards old in-flight pages when switching projects", async () => {
    let release: (p: ProjectDossier) => void = () => {};
    const deferred = new Promise<ProjectDossier>((resolve) => {
      release = resolve;
    });
    const oldRows = [task("one"), task("two"), task("three")];
    const load = vi.fn(async (id: string, offset = 0) =>
      id === "old" && offset
        ? deferred
        : page(
            id,
            id === "old" ? oldRows : [task("new", "New project task")],
            offset,
          ),
    );
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <ProjectNow projectId="old" load={load} onTask={() => {}} />,
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Mai multe lucrări" }),
      );
    });
    await act(async () => {
      view.rerender(
        <ProjectNow projectId="new" load={load} onTask={() => {}} />,
      );
    });
    await act(async () => {
      release(page("old", oldRows, 2));
    });
    expect(screen.getByText("New project task")).toBeTruthy();
    expect(screen.queryByText("three")).toBeNull();
    await tick();
    expect(screen.getByText("New project task")).toBeTruthy();
  });
  it("does not interpret configured subscriptions or historical verification as current success", () => {
    const dossier: TaskDossier = {
      projectId: "fixture",
      taskId: "task",
      title: "Synthetic task",
      objective: "Inspect",
      taskRevision: 1,
      state: "done",
      stateSource: "reported_progress",
      summary: "Historical completion",
      nextAction: null,
      ownerAction: null,
      progress: null,
      lastReported: null,
      execution: {
        id: "run",
        status: "completed",
        verification: "passed",
        evidenceValidity: { status: "retracted" },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      blockers: { activeCount: 0 },
      continuation: {
        policy: { mode: "verify_and_report", objective: "Inspect" },
        activeSubscriptions: 1,
        ready: true,
        health: {
          pendingDeliveries: 0,
          failedDeliveries: 0,
          oldestPendingAt: null,
          reconciliationNeeded: 0,
          lastDelivery: null,
        },
      },
      warnings: [],
      stateToken: "synthetic",
    };
    render(<TaskNow dossier={dossier} />);
    expect(
      screen.getByText("Dovadă retrasă — verdict doar istoric"),
    ).toBeTruthy();
    expect(screen.getByText(/Nicio livrare înregistrată/)).toBeTruthy();
  });
});
