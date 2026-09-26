import { describe, expect, it } from "vitest";
import { validateProjectSearch } from "../src/router.js";

describe("project tab URL search", () => {
  it("accepts only supported tabs and preserves the record deep-link contract", () => {
    expect(validateProjectSearch({ tab: "timeline", recordId: "synthetic-record", other: "kept by router navigation" })).toEqual({
      tab: "timeline",
      recordId: "synthetic-record",
    });
    expect(validateProjectSearch({ tab: "export" })).toEqual({ tab: "export", recordId: undefined });
  });

  it("falls back to the overview tab for invalid or missing values", () => {
    expect(validateProjectSearch({ tab: "unknown" })).toEqual({ tab: undefined, recordId: undefined });
    expect(validateProjectSearch({ tab: 1, recordId: null })).toEqual({ tab: undefined, recordId: undefined });
  });
});
