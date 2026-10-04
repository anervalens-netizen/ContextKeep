import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  TaskPanel,
  type TaskTransport,
  type TaskView,
} from "../src/components/TaskPanel.js";
import {
  ProjectNow,
  TaskNow,
  type TaskDossier,
  type ProjectDossier,
} from "../src/components/OperationalDossier.js";
afterEach(cleanup);
const dossier: TaskDossier = {
  projectId: "fixture-project",
  taskId: "fixture-task",
  title: "Synthetic task",
  objective: "Synthetic original goal",
  taskRevision: 1,
  state: "in_progress",
  stateSource: "reported_progress",
  summary: "Synthetic current result",
  nextAction: "Inspect existing artifact",
  ownerAction: "Choose fixture input",
  progress: null,
  lastReported: {
    recordId: "report",
    recordedAt: "2026-01-01T00:00:00.000Z",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
  },
  execution: {
    id: "fixture-run",
    status: "completed",
    verification: "pending",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  blockers: { activeCount: 0 },
  continuation: {
    policy: { mode: "verify_and_report", objective: "Inspect" },
    activeSubscriptions: 0,
    ready: false,
  },
  warnings: [],
  stateToken: "state-1",
};
const task = {
  id: "fixture-task",
  subject: "Synthetic task",
  taskStatus: null,
  reviewStatus: "proposed",
  revision: 1,
};
const view: TaskView = {
  task,
  dossier,
  latestCheckpoint: null,
  blockers: { active: [] },
  runs: [],
  records: [],
  pagination: { nextOffset: null },
};
const transport = (resume: TaskTransport["resume"]): TaskTransport => ({
  projects: async () => [],
  tasks: async () => ({ items: [task], nextOffset: null }),
  task: async () => view,
  resume,
});
describe("operational UI", () => {
  it("shows outcome, verification and missing subscription separately; resume is read-only", async () => {
    const resume = vi.fn(async () => ({
      dossier,
      resumeText: "Inspect the retained synthetic result; never rerun it.",
      startsExecution: false as const,
    }));
    const onResume = vi.fn(),
      onSelection = vi.fn();
    render(
      <TaskPanel
        projectId="fixture-project"
        transport={transport(resume)}
        onResume={onResume}
        onSelection={onSelection}
      />,
    );
    await screen.findByRole("option", { name: /Synthetic task/ });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "fixture-task" },
    });
    await screen.findByText("Synthetic current result");
    expect(screen.getByText("Proces terminat · Neverificat")).toBeTruthy();
    expect(screen.getByText(/abonarea ChatGPT lipsește/)).toBeTruthy();
    expect(screen.getByText("Choose fixture input")).toBeTruthy();
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reia lucrarea" }));
    expect(
      ((await screen.findByLabelText("Resume context")) as HTMLTextAreaElement)
        .value,
    ).toContain("never rerun");
    expect(resume).toHaveBeenCalledExactlyOnceWith(
      "fixture-project",
      "fixture-task",
    );
    expect(onSelection).toHaveBeenCalledWith({
      projectId: "fixture-project",
      taskId: "fixture-task",
      revision: 1,
      stateToken: "state-1",
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it("shows an actionless post-closure follow-up summary instead of a blank value", () => {
    render(
      <TaskNow
        dossier={{
          ...dossier,
          state: "done",
          nextAction: null,
          followUp: {
            nextAction: null,
            summary: "Evidence-only follow-up requires reconciliation",
            checkpointRecordId: "follow-up-checkpoint",
            recordedAt: "2026-10-04T09:00:00.000Z",
            provenance: "agent_report",
          },
        }}
      />,
    );
    expect(
      screen.getByText("Evidence-only follow-up requires reconciliation"),
    ).toBeTruthy();
  });

  it("discards late resume context when another task is selected", async () => {
    let resolve: (v: {
      dossier: TaskDossier;
      resumeText: string;
      startsExecution: false;
    }) => void = () => {};
    const promise = new Promise<{
      dossier: TaskDossier;
      resumeText: string;
      startsExecution: false;
    }>((r) => {
      resolve = r;
    });
    const onResume = vi.fn();
    render(
      <TaskPanel
        projectId="fixture-project"
        transport={transport(() => promise)}
        onResume={onResume}
      />,
    );
    await screen.findByRole("option", { name: /Synthetic task/ });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "fixture-task" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reia lucrarea" }),
    );
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "" } });
    resolve({ dossier, resumeText: "Obsolete resume", startsExecution: false });
    await waitFor(() =>
      expect(screen.queryByLabelText("Resume context")).toBeNull(),
    );
    expect(onResume).not.toHaveBeenCalled();
  });
  it("does not call an unavailable project empty", async () => {
    render(
      <ProjectNow
        projectId="fixture-project"
        load={async () => {
          throw new Error("Fixture outage");
        }}
        onTask={vi.fn()}
      />,
    );
    await screen.findByRole("alert");
    expect(
      screen.queryByText("Nu există lucrări în acest proiect."),
    ).toBeNull();
  });
  it("keeps closed tasks out of active cards without losing access to their history", async () => {
    const data: ProjectDossier = {
      project: {
        id: "fixture-project",
        name: "Synthetic",
        lifecycle: "active",
      },
      goals: [],
      tasks: [
        {
          taskId: "fixture-task",
          title: "Closed fixture",
          state: "done",
          summary: "Verified fixture complete",
          nextAction: null,
          ownerAction: null,
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          activeBlockers: 0,
          executionStatus: "completed",
          verification: "passed",
          stateToken: "state",
          taskRevision: 1,
        },
      ],
      pagination: { total: 1, nextOffset: null },
      historicalUnscopedCheckpoints: 2,
      links: { items: [] },
    };
    const select = vi.fn();
    render(
      <ProjectNow
        projectId="fixture-project"
        load={async () => data}
        onTask={select}
      />,
    );
    await screen.findByText(/Nicio lucrare activă/);
    fireEvent.click(screen.getByRole("button", { name: "Toate", exact: true }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Closed fixture/ }),
    );
    expect(select).toHaveBeenCalledWith("fixture-task");
  });
});

describe("needs-attention projection", () => {
  it("surfaces attention that is outside the loaded recent-task page", async () => {
    const attentionTask = {
      taskId: "older-attention",
      title: "Older verified task",
      state: "done",
      summary: "Historical proof changed",
      nextAction: null,
      ownerAction: null,
      lastActivityAt: "2025-12-01T00:00:00.000Z",
      activeBlockers: 0,
      executionStatus: "completed",
      verification: "passed",
      currentEvidenceValidity: "valid",
      unresolvedExecutionCount: 1,
      needsAttention: true,
      attentionReasons: ["unresolved_execution"],
      stateToken: "attention",
      taskRevision: 1,
    };
    const data: ProjectDossier = {
      project: {
        id: "fixture-project",
        name: "Synthetic",
        lifecycle: "active",
      },
      goals: [],
      tasks: [
        {
          ...attentionTask,
          taskId: "recent-done",
          title: "Recent completed task",
          unresolvedExecutionCount: 0,
          needsAttention: false,
          attentionReasons: [],
          stateToken: "recent",
          lastActivityAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      attention: {
        count: 1,
        offset: 0,
        limit: 10,
        tasks: [attentionTask],
        nextOffset: null,
        truncated: false,
        recovery: null,
      },
      pagination: { total: 4, nextOffset: 1 },
      historicalUnscopedCheckpoints: 0,
      links: { items: [] },
    };
    const select = vi.fn();
    render(
      <ProjectNow
        projectId="fixture-project"
        load={async () => data}
        onTask={select}
      />,
    );
    expect(await screen.findByText("Necesită atenție (1)")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Older verified task/ }),
    );
    expect(select).toHaveBeenCalledWith("older-attention");
  });
});

it("loads additional attention pages without requiring later ordinary task pages to carry attention", async () => {
  const baseTask = {
    title: "Needs attention",
    state: "done",
    summary: "Historical proof changed",
    nextAction: null,
    ownerAction: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    activeBlockers: 0,
    executionStatus: "completed",
    verification: "passed",
    currentEvidenceValidity: "valid",
    unresolvedExecutionCount: 1,
    needsAttention: true,
    attentionReasons: ["unresolved_execution"],
    stateToken: "attention",
    taskRevision: 1,
  };
  const first = {
    project: { id: "fixture-project", name: "Synthetic", lifecycle: "active" },
    goals: [],
    tasks: [],
    attention: {
      count: 3,
      offset: 0,
      limit: 2,
      tasks: [
        { ...baseTask, taskId: "attention-1", title: "Attention item 1" },
        { ...baseTask, taskId: "attention-2", title: "Attention item 2" },
      ],
      nextOffset: 2,
      truncated: true,
      recovery: {
        tool: "get_project_dossier",
        projectId: "fixture-project",
        offset: 0,
        limit: 10,
        attentionOffset: 2,
        attentionLimit: 2,
      },
    },
    pagination: { total: 0, nextOffset: null },
    historicalUnscopedCheckpoints: 0,
    links: { items: [] },
  } satisfies ProjectDossier;
  const second = {
    ...first,
    attention: {
      count: 3,
      offset: 2,
      limit: 2,
      tasks: [
        { ...baseTask, taskId: "attention-3", title: "Attention item 3" },
      ],
      nextOffset: null,
      truncated: false,
      recovery: null,
    },
  } satisfies ProjectDossier;
  const load = vi.fn(
    async (_projectId: string, _offset = 0, attentionOffset?: number) =>
      attentionOffset === 2 ? second : first,
  );
  render(
    <ProjectNow
      projectId="fixture-project"
      load={load}
      onTask={() => undefined}
    />,
  );
  expect(await screen.findByText("Necesită atenție (3)")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Mai multe de verificat" }),
  );
  expect(
    await screen.findByRole("button", { name: /Attention item 3/i }),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledWith("fixture-project", 0, 2);
});
