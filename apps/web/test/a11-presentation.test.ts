import { describe, expect, it } from "vitest";
import { ApiError, TransportTimeoutError } from "../src/lib/api.js";
import { describeReadError, formatLocalDateTime } from "../src/lib/presentation.js";

describe("CK-A11 presentation semantics", () => {
  it("distinguishes timeout, auth, API failure and offline/no-cache reads", () => {
    expect(describeReadError(new TransportTimeoutError(20_000), "Project overview")).toMatch(/timed out/i);
    expect(describeReadError(new ApiError(401, "unauthorized", "expired"), "Project overview")).toMatch(/sign-in/i);
    expect(describeReadError(new ApiError(500, "server_error", "boom"), "Project overview")).toBe("Project overview failed: boom");
    expect(describeReadError(new TypeError("Failed to fetch"), "Project overview")).toMatch(/offline.*no verified local copy/i);
  });

  it("uses the local formatter for valid timestamps and preserves invalid values", () => {
    expect(formatLocalDateTime("2026-09-23T14:40:28.884Z")).not.toContain("T14:40");
    expect(formatLocalDateTime("not-a-date")).toBe("not-a-date");
    expect(formatLocalDateTime(null)).toBe("unknown");
  });
});
