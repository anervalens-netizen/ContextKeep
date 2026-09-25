import { create } from "zustand";

/**
 * Theme management — applies [data-theme="light|dark|auto"] on <html> and
 * persists the explicit user choice in localStorage. The "auto" choice
 * resolves through `prefers-color-scheme` via CSS media queries (see
 * styles.css + codex-theme.css).
 */

export type ThemeChoice = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "ck:theme";
const ATTR = "data-theme";

function readPersisted(): ThemeChoice {
  if (typeof window === "undefined") return "auto";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  return "auto";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === "auto") return systemPrefersDark() ? "dark" : "light";
  return choice;
}

function apply(choice: ThemeChoice): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const resolved = resolve(choice);
  document.documentElement.setAttribute(ATTR, choice);
  document.documentElement.dataset.resolvedTheme = resolved;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", resolved === "dark" ? "#171717" : "#f5f5f5");
  }
  return resolved;
}

interface ThemeState {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
  init: () => void;
  onSystemChange: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  choice: "auto",
  resolved: "light",
  setChoice: (next) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
    const resolved = apply(next);
    set({ choice: next, resolved });
  },
  init: () => {
    if (typeof window === "undefined") return;
    const choice = readPersisted();
    const resolved = apply(choice);
    set({ choice, resolved });
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (): void => {
      if (get().choice === "auto") {
        const next = apply("auto");
        set({ resolved: next });
      }
    };
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", listener);
    } else if (typeof (mql as MediaQueryList & {
      addListener?: (cb: () => void) => void;
    }).addListener === "function") {
      (mql as MediaQueryList & {
        addListener: (cb: () => void) => void;
      }).addListener(listener);
    }
  },
  onSystemChange: () => {
    if (get().choice === "auto") {
      const next = apply("auto");
      set({ resolved: next });
    }
  },
}));
