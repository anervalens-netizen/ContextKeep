import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  TaskContextActions,
  type TaskHostActions,
} from "../src/components/TaskContextActions.js";
import type { TaskTransport } from "../src/components/TaskPanel.js";
import { HostOperationFence } from "../src/lib/host-operation-fence.js";
afterEach(cleanup);
const selection = { projectId: "project", taskId: "task-a", revision: 1 };
function result(taskId = "task-a") {
  return {
    startsExecution: false as const,
    resumeText: "Synthetic resume",
    dossier: {
      projectId: "project",
      taskId,
      title: "Synthetic task",
      taskRevision: 3,
      stateToken: "fresh-token",
      state: "in_progress",
      stateSource: "reported_progress",
      summary: "Synthetic proof pending",
      nextAction: "Inspect receipt",
      lastReported: {
        recordId: "report",
        reviewStatus: "proposed",
        evidenceBasis: "agent_report",
        recordedAt: "2026-01-01",
      },
      execution: null,
    },
  } as Awaited<ReturnType<NonNullable<TaskTransport["resume"]>>>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function mount(
  host: TaskHostActions,
  resume: NonNullable<TaskTransport["resume"]> = vi.fn(async () => result()),
) {
  return render(
    <TaskContextActions
      selection={selection}
      title="Synthetic task"
      resume={resume}
      host={host}
    />,
  );
}
describe("explicit conversation actions", () => {
  it("reads fresh context once, ignores double click and reports attach only after a host update id", async () => {
    const pending = deferred<{ updateId: string }>(),
      attach = vi.fn(() => pending.promise),
      resume = vi.fn(async () => result());
    mount({ attach }, resume);
    expect(attach).not.toHaveBeenCalled();
    const button = screen.getByRole("button", { name: "Atașează contextul" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toMatchObject({
      taskId: "task-a",
      revision: 3,
      stateToken: "fresh-token",
    });
    expect(screen.queryByText(/Context atașat:/)).toBeNull();
    pending.resolve({ updateId: "host-ack" });
    await screen.findByText("Context atașat: Synthetic task");
  });
  it("does not dispatch an old task after selection changes while resume is pending", async () => {
    const pending = deferred<ReturnType<typeof result>>(),
      attach = vi.fn(),
      resume = vi.fn(() => pending.promise);
    const host = { attach };
    const view = mount(host, resume);
    fireEvent.click(screen.getByRole("button", { name: "Atașează contextul" }));
    view.rerender(
      <TaskContextActions
        selection={{ ...selection, taskId: "task-b" }}
        title="Other task"
        resume={resume}
        host={host}
      />,
    );
    pending.resolve(result());
    await waitFor(() =>
      expect(screen.queryByText("Se verifică starea curentă…")).toBeNull(),
    );
    expect(attach).not.toHaveBeenCalled();
    expect(screen.queryByText(/Context atașat:/)).toBeNull();
  });
  it("never labels an unacknowledged attach successful and offers a copy fallback", async () => {
    mount({ attach: vi.fn(async () => undefined as never) });
    fireEvent.click(screen.getByRole("button", { name: "Atașează contextul" }));
    await screen.findByText(/Confirmarea hostului lipsește/);
    expect(screen.queryByText(/Context atașat:/)).toBeNull();
    expect(screen.getByLabelText("Prompt pentru conversație")).toBeTruthy();
  });
  it("keeps uncertain sends fenced after changing tasks and does not infer execution from an acknowledgement", async () => {
    const fence = new HostOperationFence(),
      wire = vi.fn(async () => {
        throw new Error("timeout");
      });
    const send = vi.fn(() => fence.run("send", wire));
    const view = mount({ send });
    fireEvent.click(screen.getByRole("button", { name: "Continuă în chat" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Continuă în chat" }));
    expect(send).toHaveBeenCalledTimes(1);
    view.unmount();
    mount({ send, messageUncertain: fence.messageUncertain });
    fireEvent.click(screen.getByRole("button", { name: "Continuă în chat" }));
    expect(wire).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("incert");
  });
  it("acknowledges chat acceptance separately and reflects context removal", async () => {
    const host = {
      send: vi.fn(async () => {}),
      attach: vi.fn(async () => ({ updateId: "ack" })),
      currentUpdateId: undefined as string | null | undefined,
    };
    const view = mount(host);
    fireEvent.click(screen.getByRole("button", { name: "Continuă în chat" }));
    await screen.findByText(
      "Mesaj acceptat în conversație. Execuția nu este confirmată.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Atașează contextul" }));
    await screen.findByText("Context atașat: Synthetic task");
    view.rerender(
      <TaskContextActions
        selection={selection}
        title="Synthetic task"
        resume={async () => result()}
        host={{ ...host, currentUpdateId: null }}
      />,
    );
    await screen.findByText(
      "Contextul atașat a fost eliminat din conversație.",
    );
  });
  it("does not send through unsupported host methods", async () => {
    mount({});
    fireEvent.click(screen.getByRole("button", { name: "Continuă în chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Atașează contextul" }));
    expect(screen.queryByText(/Mesaj acceptat/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copiază promptul" }));
    await screen.findByLabelText("Prompt pentru conversație");
  });
});
describe("app-wide host operation fence", () => {
  it("does not treat a host error result as message acceptance", async () => {
    const fence = new HostOperationFence();
    await expect(
      fence.run("send", async () => ({ isError: true })),
    ).rejects.toThrow("did not accept");
    expect(fence.messageUncertain).toBe(true);
  });
  it("serializes operations and retains send uncertainty across consumers", async () => {
    const fence = new HostOperationFence(),
      pending = deferred<void>(),
      second = vi.fn(async () => {});
    const first = fence.run("send", () => pending.promise);
    await expect(fence.run("attach", second)).rejects.toThrow();
    expect(second).not.toHaveBeenCalled();
    pending.reject(new Error("timeout"));
    await expect(first).rejects.toThrow("timeout");
    await expect(fence.run("send", second)).rejects.toThrow();
    expect(fence.messageUncertain).toBe(true);
    expect(second).not.toHaveBeenCalled();
    await fence.run("attach", second);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

it("applies context depth to excerpt size while preserving exact identity and no-replay instructions", async () => {
  const lengths: number[] = [];
  for (const contextBudget of ["compact", "balanced", "deep"] as const) {
    const data = result();
    data.dossier.summary = "S".repeat(6000);
    data.dossier.nextAction = "N".repeat(4000);
    const attach = vi.fn(async () => ({ updateId: "ack" }));
    const rendered = render(
      <TaskContextActions
        selection={selection}
        title="Synthetic task"
        resume={async () => data}
        host={{ attach }}
        contextBudget={contextBudget}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Atașează contextul" }));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const payload = attach.mock.calls[0][0];
    expect(payload.text).toContain('"taskId":"task-a"');
    expect(payload.text).toContain('"revision":3');
    expect(payload.text).toContain("nu repeta execuții existente");
    expect(payload.provenance.report).toEqual(data.dossier.lastReported);
    lengths.push(payload.text.length);
    rendered.unmount();
  }
  expect(lengths[0]).toBeLessThan(lengths[1]);
  expect(lengths[1]).toBeLessThan(lengths[2]);
});
