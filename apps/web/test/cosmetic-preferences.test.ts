import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  readCosmeticPreference,
  removeCosmeticPreference,
  writeCosmeticPreference,
} from "../src/lib/cosmetic-preferences.js";
import { useThemeStore } from "../src/state/theme.js";
import { useShellUi } from "../src/components/useShellUi.js";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

afterEach(() => {
  if (localStorageDescriptor) Object.defineProperty(window, "localStorage", localStorageDescriptor);
  document.documentElement.removeAttribute("data-theme");
  delete document.documentElement.dataset.resolvedTheme;
});

describe("cosmetic preference storage", () => {
  it("uses a volatile fallback when the localStorage getter is denied and restores it later", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    writeCosmeticPreference("synthetic:theme", "dark");
    expect(readCosmeticPreference("synthetic:theme")).toBe("dark");

    if (!localStorageDescriptor) throw new Error("localStorage descriptor unavailable");
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
    expect(readCosmeticPreference("synthetic:theme")).toBe("dark");
    expect(window.localStorage.getItem("synthetic:theme")).toBe("dark");

    removeCosmeticPreference("synthetic:theme");
    expect(window.localStorage.getItem("synthetic:theme")).toBeNull();
  });

  it("lets the initial theme render complete when localStorage access is denied", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    useThemeStore.getState().init();
    expect(document.documentElement.getAttribute("data-theme")).toBe("auto");
    expect(document.documentElement.dataset.resolvedTheme).toBe("light");
  });

  it("lets the shell initialize its cosmetic layout defaults when storage is denied", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    const rendered = renderHook(() => useShellUi("/synthetic"));
    expect(rendered.result.current.leftWidth).toBe(268);
    expect(rendered.result.current.leftCollapsed).toBe(false);
    rendered.unmount();
  });

  it("keeps a new choice authoritative when only localStorage writes are denied", () => {
    const key = "synthetic:write-denied";
    const backing = window.localStorage;
    backing.setItem(key, "old");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        return {
          getItem: backing.getItem.bind(backing),
          setItem() {
            throw new DOMException("blocked", "QuotaExceededError");
          },
          removeItem: backing.removeItem.bind(backing),
        } as unknown as Storage;
      },
    });

    writeCosmeticPreference(key, "new");
    expect(readCosmeticPreference(key)).toBe("new");
    if (!localStorageDescriptor) throw new Error("localStorage descriptor unavailable");
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
    expect(readCosmeticPreference(key)).toBe("new");
    expect(backing.getItem(key)).toBe("new");
    backing.removeItem(key);
  });

  it("keeps a removal tombstone authoritative when only localStorage removal is denied", () => {
    const key = "synthetic:remove-denied";
    const backing = window.localStorage;
    backing.setItem(key, "old");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        return {
          getItem: backing.getItem.bind(backing),
          setItem: backing.setItem.bind(backing),
          removeItem() {
            throw new DOMException("blocked", "SecurityError");
          },
        } as unknown as Storage;
      },
    });

    removeCosmeticPreference(key);
    expect(readCosmeticPreference(key)).toBeNull();
    if (!localStorageDescriptor) throw new Error("localStorage descriptor unavailable");
    Object.defineProperty(window, "localStorage", localStorageDescriptor);
    expect(readCosmeticPreference(key)).toBeNull();
    expect(backing.getItem(key)).toBeNull();
  });

  it("honors an external deletion instead of resurrecting the cached value", () => {
    const key = "synthetic:cross-tab-delete";
    writeCosmeticPreference(key, "old");
    window.localStorage.removeItem(key);
    expect(readCosmeticPreference(key)).toBeNull();
  });
});
