import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const LEFT_MIN = 220;
const LEFT_MAX = 360;
const LEFT_DEFAULT = 268;
const LEFT_KEY_STEP = 12;
const RETIRED_CHAT_KEYS = [
  "ck:agent:provider",
  "ck:agent:effort",
  "ck:shell:right-width",
  "ck:shell:right-collapsed",
] as const;

function clampLeft(value: number): number {
  return Math.min(LEFT_MAX, Math.max(LEFT_MIN, value));
}

function storedNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function storedBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]',
  )].filter((element) => {
    if (element.tabIndex < 0 || element.closest('[inert],[hidden],[aria-hidden="true"]')) return false;
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    for (let parent = element.parentElement; parent && parent !== container; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open) {
        const summary = parent.querySelector(":scope > summary");
        if (!summary?.contains(element)) return false;
      }
    }
    return true;
  });
}

export function useShellUi(pathname: string) {
  const [leftWidth, setLeftWidth] = useState(() => clampLeft(storedNumber("ck:shell:left-width", LEFT_DEFAULT)));
  const [leftCollapsed, setLeftCollapsed] = useState(() => storedBoolean("ck:shell:left-collapsed", false));
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    setLeftDrawer(false);
  }, [pathname]);

  useEffect(() => {
    for (const key of RETIRED_CHAT_KEYS) window.localStorage.removeItem(key);
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = (): void => {
      if (desktop.matches) setLeftDrawer(false);
    };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!leftDrawer) {
      const trigger = drawerTriggerRef.current;
      if (drawerWasOpen.current && trigger && trigger.getClientRects().length > 0) trigger.focus();
      drawerWasOpen.current = false;
      return;
    }
    drawerWasOpen.current = true;
    const container = drawerRef.current;
    if (!container) return;

    const focusables = focusableElements(container);
    (focusables[0] ?? container).focus();

    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setLeftDrawer(false);
        return;
      }
      if (event.key !== "Tab") return;
      const current = focusableElements(container);
      if (current.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = current[0]!;
      const last = current[current.length - 1]!;
      const active = document.activeElement;
      const outsideSequence = !current.some((element) => element === active);
      if (event.shiftKey && (active === first || outsideSequence)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outsideSequence)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [leftDrawer]);

  const collapseLeft = (): void => {
    const next = !leftCollapsed;
    setLeftCollapsed(next);
    window.localStorage.setItem("ck:shell:left-collapsed", next ? "1" : "0");
  };

  const persistLeftWidth = (value: number): void => {
    const next = clampLeft(value);
    setLeftWidth(next);
    window.localStorage.setItem("ck:shell:left-width", String(next));
  };

  const resizeLeft = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    const start = event.clientX;
    const initialWidth = leftWidth;
    let last = initialWidth;
    const move = (moveEvent: PointerEvent): void => {
      last = clampLeft(initialWidth + (moveEvent.clientX - start));
      setLeftWidth(last);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.localStorage.setItem("ck:shell:left-width", String(last));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const resizeLeftKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = leftWidth - LEFT_KEY_STEP;
    if (event.key === "ArrowRight") next = leftWidth + LEFT_KEY_STEP;
    if (event.key === "Home") next = LEFT_MIN;
    if (event.key === "End") next = LEFT_MAX;
    if (next === null) return;
    event.preventDefault();
    persistLeftWidth(next);
  };

  return {
    leftWidth,
    leftCollapsed,
    leftDrawer,
    changelogOpen,
    drawerRef,
    drawerTriggerRef,
    setLeftDrawer,
    setChangelogOpen,
    collapseLeft,
    resizeLeft,
    resizeLeftKeyboard,
    columns: `${leftCollapsed ? 54 : leftWidth}px ${leftCollapsed ? 0 : 5}px minmax(0,1fr)`,
  };
}
