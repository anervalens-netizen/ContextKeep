import { afterEach, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DEFAULT_PANEL_PREFERENCES } from "@contextkeep/shared";
import { PanelSettings } from "../src/components/PanelSettings.js";
afterEach(cleanup);
it("sends only edited fields and acknowledges only after the host confirms", async () => {
  let finish!: () => void;
  const save = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    ),
    reload = vi.fn(async () => {});
  render(
    <PanelSettings
      values={DEFAULT_PANEL_PREFERENCES}
      save={save}
      reload={reload}
    />,
  );
  fireEvent.change(screen.getByLabelText("Actualizare"), {
    target: { value: "manual" },
  });
  const button = screen.getByRole("button", {
    name: "Salvează preferințele",
    hidden: true,
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({ refreshInterval: "manual" });
  expect(screen.queryByText("Preferințe salvate.")).toBeNull();
  finish();
  await waitFor(() =>
    expect(screen.getByText("Preferințe salvate.")).toBeTruthy(),
  );
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
it("does not replay uncertain writes and allows an explicit readback", async () => {
  const save = vi.fn(async () => {
      throw new Error("uncertain");
    }),
    reload = vi.fn(async () => {});
  render(
    <PanelSettings
      values={DEFAULT_PANEL_PREFERENCES}
      save={save}
      reload={reload}
    />,
  );
  fireEvent.change(screen.getByLabelText("Deschidere"), {
    target: { value: "attention" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Salvează preferințele", hidden: true }),
  );
  await screen.findByText(/Confirmarea lipsește/);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Recitește preferințele",
      hidden: true,
    }),
  );
  await screen.findByText("Preferințe recitite.");
  expect(reload).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
});
