import { describe, expect, it } from "vitest";
import { compareInstants, instantKey } from "../src/services/instant.js";

describe("precision-preserving ISO instant keys", () => {
  it.each([
    ["2026-02-01T00:00:00Z", "2026-02-01T00:00:00.000Z", 0],
    ["2026-02-01T00:00Z", "2026-02-01T00:00:00.000Z", 0],
    ["2026-02-01T00:00:00Z", "2026-02-01T00:00:00.1Z", -1],
    ["2026-02-01T00:00:00.1Z", "2026-02-01T00:00:00.1000Z", 0],
    ["2026-02-01T00:00:00.1Z", "2026-02-01T00:00:00.100000000000000001Z", -1],
    ["2026-02-01T00:00:00.0009Z", "2026-02-01T00:00:00.0008Z", 1],
    ["2026-02-01T00:00:00.999999Z", "2026-02-01T00:00:01Z", -1],
    ["2026-02-01T00:00:00.0000001Z", "2026-02-01T02:00:00.00000010+02:00", 0],
    ["2026-01-31T19:00:00.0000001-05:00", "2026-02-01T00:00:00.0000002Z", -1],
    ["2026-02-01T00:00:00Z", "2026-02-01T05:30:00+0530", 0],
  ])("compares %s and %s", (a, b, order) => {
    expect(compareInstants(a, b)).toBe(order);
    expect(compareInstants(b, a) === -order).toBe(true);
  });

  it("leaves legacy non-ISO values unchanged", () => {
    expect(instantKey("unknown")).toBe("unknown");
    expect(instantKey("2026-02-01")).toBe("2026-02-01");
  });
});
