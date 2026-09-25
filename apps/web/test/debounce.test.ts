import { afterEach, describe, expect, it, vi } from "vitest";
import { debounce } from "../src/lib/debounce.js";

describe("debounce (handoff §9: search debounce ≤200ms)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses rapid calls into one after the wait window", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("a");
    d("ab");
    d("abc");
    vi.advanceTimersByTime(150);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("abc");
  });

  it("fires again after a new burst", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("x");
    vi.advanceTimersByTime(210);
    d("y");
    vi.advanceTimersByTime(210);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel prevents the pending call", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("x");
    d.cancel();
    vi.advanceTimersByTime(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it("stays within the 200ms budget for the search field", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 200);
    d("query");
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
