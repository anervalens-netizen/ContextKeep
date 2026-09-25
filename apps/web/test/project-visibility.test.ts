import { describe, expect, it } from "vitest";
import type { ProjectDto } from "@contextkeep/shared";
import { partitionProjectVisibility } from "../src/lib/project-visibility.js";

function project(id: string, lifecycle: ProjectDto["lifecycle"]): ProjectDto {
  return {
    id,
    name: id,
    aliases: [],
    parentId: null,
    description: null,
    lifecycle,
    lifecycleRecordId: null,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

describe("active-first project visibility", () => {
  it("shows only lifecycle=active by default and keeps every other lifecycle collapsible", () => {
    const result = partitionProjectVisibility([
      project("active-a", "active"),
      project("planned-a", "planned"),
      project("paused-a", "paused"),
      project("unknown-a", "unknown"),
      project("retired-a", "retired"),
      project("active-b", "active"),
    ]);

    expect(result.active.map((item) => item.id)).toEqual(["active-a", "active-b"]);
    expect(result.inactive.map((item) => item.id)).toEqual([
      "planned-a",
      "paused-a",
      "unknown-a",
      "retired-a",
    ]);
  });
});
