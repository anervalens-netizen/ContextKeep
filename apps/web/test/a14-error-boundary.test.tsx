import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary.js";

afterEach(cleanup);

describe("CK-A14 recoverable render boundary", () => {
  it("recovers a failed view without claiming or performing queue deletion", () => {
    let shouldThrow = true;
    function Child(): React.ReactNode {
      if (shouldThrow) throw new Error("synthetic view failure");
      return <p>Recovered view</p>;
    }

    render(
      <AppErrorBoundary>
        <Child />
      </AppErrorBoundary>,
    );

    expect(screen.getByTestId("app-error-boundary")).toBeTruthy();
    expect(screen.getByText(/did not clear or discard the offline mutation queue/i)).toBeTruthy();
    expect(screen.queryByText(/A9|A19/)).toBeNull();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try view again" }));
    expect(screen.getByText("Recovered view")).toBeTruthy();
  });
});
