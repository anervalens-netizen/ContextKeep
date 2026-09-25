import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChangelogOverlay } from "../src/components/ChangelogOverlay.js";
import { ConflictOverlay } from "../src/components/ConflictOverlay.js";
import { useUiStore } from "../src/state/ui.js";


afterEach(() => {
  cleanup();
  useUiStore.setState({ conflicts: [], notice: null });
});

describe("F16 material accessibility finalization", () => {
  it("exposes Changelog as a labelled modal, focuses Close and handles Escape", () => {
    const onClose = vi.fn();
    render(<ChangelogOverlay open onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Changelog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close changelog" })).toBe(document.activeElement);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("announces persisted offline conflicts as an actionable alert region", () => {
    useUiStore.setState({
      conflicts: [
        {
          seq: 99,
          mutation: {
            seq: 5,
            method: "POST",
            url: "/api/projects",
            body: { name: "blocked" },
            enqueuedAt: new Date().toISOString(),
            label: "create project",
            idempotencyKey: "a11y-conflict-key-aaaaaaaa",
          },
          status: 409,
          code: "idempotency_outcome_unknown",
          message: "This change may already have been applied.",
          detectedAt: new Date().toISOString(),
        },
      ],
    });
    render(<ConflictOverlay />);
    const region = screen.getByRole("alert", { name: "Offline conflicts" });
    expect(region.getAttribute("aria-live")).toBe("assertive");
    expect(screen.getByText(/may already have been applied/i)).toBeTruthy();
  });

});
