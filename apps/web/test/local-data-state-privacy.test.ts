import { afterEach, describe, expect, it } from "vitest";
import { offlineDb } from "../src/lib/offline/db.js";
import {
  isLocalDataAccessPaused,
  setLocalDataAccessPaused,
} from "../src/lib/offline/local-data-state.js";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

afterEach(() => {
  if (localStorageDescriptor) Object.defineProperty(window, "localStorage", localStorageDescriptor);
  setLocalDataAccessPaused(false);
  window.localStorage.removeItem("ck:local-data-paused");
});

describe("local-data privacy pause", () => {
  it("fails closed when the prior persisted pause cannot be read", async () => {
    window.localStorage.setItem("ck:local-data-paused", "1");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(isLocalDataAccessPaused()).toBe(true);
    await expect(offlineDb()).rejects.toThrow(/paused/i);
  });

  it("preserves an in-memory pause and resumes only after storage is restored", () => {
    setLocalDataAccessPaused(true);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    expect(isLocalDataAccessPaused()).toBe(true);

    if (!localStorageDescriptor) throw new Error("localStorage descriptor unavailable");
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
    setLocalDataAccessPaused(false);
    expect(isLocalDataAccessPaused()).toBe(false);
  });
});
