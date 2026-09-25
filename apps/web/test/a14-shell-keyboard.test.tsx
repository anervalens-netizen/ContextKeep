import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellUi } from "../src/components/useShellUi.js";

function Harness(): React.ReactNode {
  const ui = useShellUi("/");
  return (
    <div>
      <button
        ref={ui.drawerTriggerRef}
        type="button"
        onClick={() => ui.setLeftDrawer(true)}
      >
        Open navigation
      </button>
      <button
        type="button"
        role="separator"
        aria-label="Resize left sidebar"
        aria-valuemin={220}
        aria-valuemax={360}
        aria-valuenow={ui.leftWidth}
        onKeyDown={ui.resizeLeftKeyboard}
      />
      <aside
        ref={ui.drawerRef}
        role="dialog"
        aria-modal={ui.leftDrawer ? true : undefined}
        aria-hidden={!ui.leftDrawer}
        tabIndex={-1}
      >
        <button type="button">First drawer action</button>
        <button type="button">Last drawer action</button>
      </aside>
      <span data-testid="drawer-state">
        {ui.leftDrawer ? "open" : "closed"}
      </span>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 390,
  });
  // Explicit unit geometry fixture; browser smoke checks actual CSS/layout.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    function (this: HTMLElement) {
      const rects =
        this.hidden || this.style.display === "none"
          ? []
          : [new DOMRect(0, 0, 120, 30)];
      return Object.assign(rects, {
        item: (index: number) => rects[index] ?? null,
      }) as DOMRectList;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CK-A14 keyboard shell controls", () => {
  it("focuses and traps the drawer, Escape closes it, and focus returns to the trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    fireEvent.click(trigger);

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "First drawer action" }),
      ),
    );
    const first = screen.getByRole("button", { name: "First drawer action" });
    const last = screen.getByRole("button", { name: "Last drawer action" });

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("drawer-state").textContent).toBe("closed"),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("resizes the desktop separator with Arrow/Home/End and persists accessible values", () => {
    render(<Harness />);
    const separator = screen.getByRole("separator", {
      name: "Resize left sidebar",
    });
    expect(separator.getAttribute("aria-valuenow")).toBe("268");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(localStorage.getItem("ck:shell:left-width")).toBe("280");

    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator.getAttribute("aria-valuenow")).toBe("220");

    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe("360");
  });
  it("keeps Shift+Tab inside the drawer when the dialog itself is focused", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    await waitFor(() =>
      expect(screen.getByTestId("drawer-state").textContent).toBe("open"),
    );
    screen.getByRole("dialog").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Last drawer action" }),
    );
  });

  it("closes the mobile drawer when crossing the desktop breakpoint", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getByTestId("drawer-state").textContent).toBe("open");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(screen.getByTestId("drawer-state").textContent).toBe("closed"),
    );
  });
});
