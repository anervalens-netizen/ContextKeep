import { describe, expect, it } from "vitest";
import { selectContextRows } from "../src/services/context-selection.js";

describe("CV independent review: mandatory selection", () => {
  it("backfills spare slots with applicable mandatory records when lexical matches are absent", () => {
    const mandatoryRows = [{ id: "newest" }, { id: "second" }, { id: "third" }];
    expect(selectContextRows({ mandatoryRows, relevantRows: [], limit: 5 })).toEqual(mandatoryRows);
  });
  it("does not let a duplicate lexical match leave available mandatory context unused", () => {
    const mandatoryRows = [{ id: "newest" }, { id: "second" }, { id: "third" }];
    expect(selectContextRows({ mandatoryRows, relevantRows: [{ id: "newest" }], limit: 5 }).map(r => r.id))
      .toEqual(["newest", "second", "third"]);
  });
});
