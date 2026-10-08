import { afterEach, it, expect } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { PanelLocale, translatePanel } from "../src/lib/panel-locale.js";
import { TaskPanel, type TaskTransport } from "../src/components/TaskPanel.js";
afterEach(cleanup);
it("changes controls without translating user content or losing the selected task", async () => {
  const task = {
    id: "task",
    subject: "Ce contează acum",
    taskStatus: "open",
    reviewStatus: "proposed",
    revision: 1,
  };
  const transport: TaskTransport = {
    projects: async () => [{ id: "project", name: "Proiect privat" }],
    tasks: async () => ({ items: [task], nextOffset: null }),
    task: async () => ({
      task,
      latestCheckpoint: null,
      blockers: { active: [] },
      runs: [],
      records: [],
      pagination: { nextOffset: null },
    }),
  };
  const ui = render(
    <PanelLocale.Provider value="en">
      <TaskPanel transport={transport} />
    </PanelLocale.Provider>,
  );
  await screen.findByRole("option", { name: "Proiect privat" });
  expect(screen.getByRole("heading", { name: "Task dossier" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Project"), {
    target: { value: "project" },
  });
  await screen.findByRole("option", { name: /Ce contează acum/ });
  fireEvent.change(screen.getByLabelText("Task"), {
    target: { value: "task" },
  });
  await screen.findByText("No checkpoint for this task.");
  ui.rerender(
    <PanelLocale.Provider value="ro">
      <TaskPanel transport={transport} />
    </PanelLocale.Provider>,
  );
  expect(
    screen.getByRole("heading", { name: "Dosarul taskului" }),
  ).toBeTruthy();
  expect((screen.getByLabelText("Proiect") as HTMLSelectElement).value).toBe(
    "project",
  );
  expect((screen.getByLabelText("Task") as HTMLSelectElement).value).toBe(
    "task",
  );
  await waitFor(() =>
    expect(
      screen.getByText("Niciun checkpoint pentru acest task."),
    ).toBeTruthy(),
  );
  expect(screen.getByRole("option", { name: /Ce contează acum/ })).toBeTruthy();
});
it("preserves unknown content and translates only known presentation text", () => {
  expect(translatePanel("en", "Proprietar: dovadă privată")).toBe(
    "Proprietar: dovadă privată",
  );
  expect(translatePanel("en", "Actualizează taskul")).toBe("Refresh task");
  expect(translatePanel("ro", "Refresh task")).toBe("Actualizează taskul");
});
