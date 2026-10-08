import { afterEach, describe, expect, it, vi } from "vitest";
import { schedulePanelRefresh } from "../src/lib/panel-refresh.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("panel refresh lifecycle", () => {
  it("skips hidden intervals, refreshes on visibility and removes all triggers on disposal", () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const read = vi.fn(),
      stop = schedulePanelRefresh(read, 15000);
    vi.advanceTimersByTime(30000);
    expect(read).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(30000);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("manual mode never schedules an automatic request", () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const read = vi.fn(),
      stop = schedulePanelRefresh(read, null);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(120000);
    expect(read).not.toHaveBeenCalled();
    stop();
  });
});
