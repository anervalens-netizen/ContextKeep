import { afterEach, describe, expect, it, vi } from "vitest";
import { offlineDb } from "../src/lib/offline/db.js";
import { saveToCache, saveToCacheBestEffort } from "../src/lib/offline/mirror.js";
import {
  isLocalDataAccessPaused,
  isLocalDataStorageUnavailable,
  setLocalDataAccessPaused,
} from "../src/lib/offline/local-data-state.js";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    await expect(saveToCache("synthetic-denied", {})).rejects.toThrow(/paused/i);
    await expect(saveToCacheBestEffort("synthetic-denied", {})).resolves.toBe(false);
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
  it("does not announce resume when persisted pause removal is denied", async () => {
    const messages: { type: string }[] = [];
    vi.stubGlobal("BroadcastChannel", class {
      postMessage(message: { type: string }): void { messages.push(message); }
      close(): void {}
    });
    expect(setLocalDataAccessPaused(true)).toBe(true);
    messages.length = 0;
    const removal = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic remove denied", "SecurityError");
    });
    expect(isLocalDataStorageUnavailable()).toBe(false);
    expect(setLocalDataAccessPaused(false)).toBe(false);
    expect(window.localStorage.getItem("ck:local-data-paused")).toBe("1");
    expect(isLocalDataAccessPaused()).toBe(true);
    expect(messages).toEqual([{ type: "pause" }]);
    await expect(offlineDb()).rejects.toThrow(/paused/i);
    removal.mockRestore();
    expect(setLocalDataAccessPaused(false)).toBe(true);
    expect(isLocalDataAccessPaused()).toBe(false);
    expect(messages.at(-1)).toEqual({ type: "resume" });
  });

});
