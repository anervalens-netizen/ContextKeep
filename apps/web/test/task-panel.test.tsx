import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach } from "vitest";
import {
  TaskPanel,
  type TaskTransport,
  type TaskView,
} from "../src/components/TaskPanel.js";
afterEach(cleanup);
const task = {
  id: "task-a",
  subject: "Verify synthetic result",
  taskStatus: "in_progress",
  reviewStatus: "proposed",
  revision: 2,
};
const view: TaskView = {
  task,
  latestCheckpoint: {
    recordedAt: "2026-01-01T00:00:00.000Z",
    provenance: "agent_report",
    status: "proposed",
    checkpoint: { summary: "Build completed", nextAction: "Inspect artifact" },
  },
  blockers: { active: [] },
  runs: [
    {
      id: "run-a",
      status: "completed",
      verification: "pending",
      externalJobId: "job-a",
      updatedAt: "2026-01-01T00:00:00.000Z",
      criteria: ["Artifact exists"],
    },
  ],
  records: [
    {
      id: "evidence",
      text: "Unreviewed fixture evidence",
      reviewStatus: "proposed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  pagination: { nextOffset: null },
};
describe("shared task dossier", () => {
  it("selects read-only context and shows execution separately from verification", async () => {
    const select = vi.fn(),
      read = vi.fn(async () => view);
    const transport: TaskTransport = {
      projects: async () => [{ id: "project", name: "Synthetic" }],
      tasks: async () => ({ items: [task], nextOffset: null }),
      task: read,
    };
    render(<TaskPanel transport={transport} onSelection={select} />);
    await screen.findByRole("option", { name: "Synthetic" });
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "project" },
    });
    await screen.findByRole("option", { name: /Verify synthetic/ });
    expect(read).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "task-a" },
    });
    await screen.findByText("Verification: pending");
    expect(screen.getByText("Inspect artifact")).toBeTruthy();
    expect(select).toHaveBeenCalledWith({
      projectId: "project",
      taskId: "task-a",
      revision: 2,
    });
  });
  it("does not present an old task response after selection changes", async () => {
    let resolveOld: (value: TaskView) => void = () => {};
    const old = new Promise<TaskView>((resolve) => {
      resolveOld = resolve;
    });
    const transport: TaskTransport = {
      projects: async () => [],
      tasks: async () => ({
        items: [task, { ...task, id: "task-b", subject: "Other task" }],
        nextOffset: null,
      }),
      task: async (_p, t) =>
        t === "task-a"
          ? old
          : {
              ...view,
              task: { ...task, id: "task-b", subject: "Other task" },
              latestCheckpoint: null,
              runs: [],
              records: [],
            },
    };
    render(<TaskPanel transport={transport} projectId="project" />);
    await screen.findByRole("option", { name: /Verify synthetic/ });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "task-a" },
    });
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "task-b" },
    });
    await screen.findByText("No checkpoint for this task.");
    resolveOld(view);
    await waitFor(() =>
      expect(screen.queryByText("Build completed")).toBeNull(),
    );
  });
  it("distinguishes failed task loading from an empty project and recovers on selection", async () => {
    const transport: TaskTransport = {
      projects: async () => [
        { id: "failed", name: "Unavailable project" },
        { id: "empty", name: "Empty project" },
      ],
      tasks: async (projectId) => {
        if (projectId === "failed") throw new Error("Synthetic host failure");
        return { items: [], nextOffset: null };
      },
      task: async () => view,
    };
    render(<TaskPanel transport={transport} />);
    await screen.findByRole("option", { name: "Unavailable project" });
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "failed" },
    });
    await screen.findByRole("alert");
    expect(
      screen.queryByText("No matching tasks. Try another search or view all actions."),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Project"), {
      target: { value: "empty" },
    });
    await screen.findByText("No matching tasks. Try another search or view all actions.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

it("offers bounded reuse search and ignores a page from an obsolete filter", async () => {
  let resolvePage: (value: {items: typeof task[]; nextOffset: null}) => void = () => {};
  const page = new Promise<{items: typeof task[]; nextOffset: null}>(resolve => {resolvePage=resolve;});
  const tasks = vi.fn(async (_project: string, offset = 0, options?: {selection?: string;q?: string}) => {
    if (offset === 1) return page;
    if (options?.q) return {items:[{...task,id:"task-b",subject:"Matched candidate"}],nextOffset:null};
    return {items:[task],nextOffset:1};
  });
  render(<TaskPanel projectId="project" transport={{projects:async()=>[],tasks,task:async()=>view}} />);
  await screen.findByRole("option",{name:/Verify synthetic/});
  expect(tasks).toHaveBeenLastCalledWith("project",0,{selection:"actual_tasks"});
  fireEvent.click(screen.getByRole("button",{name:"More tasks"}));
  fireEvent.change(screen.getByLabelText("Search tasks"),{target:{value:"Matched"}});
  fireEvent.click(screen.getByRole("button",{name:"Caută"}));
  await screen.findByRole("option",{name:/Matched candidate/});
  expect(tasks).toHaveBeenLastCalledWith("project",0,{selection:"actual_tasks",q:"Matched"});
  resolvePage({items:[{...task,id:"late",subject:"Obsolete page"}],nextOffset:null});
  await waitFor(()=>expect(screen.queryByRole("option",{name:/Obsolete page/})).toBeNull());
  fireEvent.change(screen.getByLabelText("Task selection"),{target:{value:"all_actions"}});
  await waitFor(()=>expect(tasks).toHaveBeenLastCalledWith("project",0,{selection:"all_actions",q:"Matched"}));
});
