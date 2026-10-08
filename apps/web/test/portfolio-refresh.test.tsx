import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  PortfolioNow,
  type PortfolioPage,
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
const page = (name: string, nextOffset: number | null = 20): PortfolioPage => ({
  items: [
    {
      id: name,
      name,
      lifecycle: "active",
      tasks: [],
      taskCount: 0,
      moreTasks: false,
    },
  ],
  total: 2,
  nextOffset,
});
describe("bounded portfolio refresh", () => {
  it("loads one page at a time, retries its failure and returns to the previous offset", async () => {
    const load = vi.fn(async (offset = 0) => {
      if (offset === 20) throw new Error("offline");
      return page("First");
    });
    render(
      <PortfolioNow
        load={load}
        onProject={() => {}}
        refreshIntervalMs={null}
      />,
    );
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Proiectele următoare" }),
    );
    await act(async () => {});
    expect(load).toHaveBeenLastCalledWith(20);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
    load.mockImplementation(async (offset) =>
      page(offset === 20 ? "Second" : "First", offset === 20 ? null : 20),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizează portofoliul" }),
    );
    await act(async () => {});
    expect(screen.getByText("Second")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Proiectele anterioare" }),
    );
    await act(async () => {});
    expect(load).toHaveBeenLastCalledWith(0);
    expect(screen.getByText("First")).toBeTruthy();
  });
  it("coalesces refresh triggers, stops while hidden and ignores a replaced loader", async () => {
    let finish!: (value: PortfolioPage) => void;
    const load = vi.fn(
      () =>
        new Promise<PortfolioPage>((r) => {
          finish = r;
        }),
    );
    const ui = render(<PortfolioNow load={load} onProject={() => {}} />);
    await act(async () => {
      vi.advanceTimersByTime(45000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizează portofoliul" }),
    );
    expect(load).toHaveBeenCalledTimes(1);
    const fresh = vi.fn(async () => page("Current"));
    ui.rerender(<PortfolioNow load={fresh} onProject={() => {}} />);
    await act(async () => {
      finish(page("Obsolete"));
    });
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.queryByText("Obsolete")).toBeNull();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      vi.advanceTimersByTime(45000);
    });
    expect(fresh).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fresh).toHaveBeenCalledTimes(2);
  });
});
