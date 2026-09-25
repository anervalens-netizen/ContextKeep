import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("M3.5 reconciliation UI", () => {
  it("keeps suggestions non-mutating and owner actions explicit", () => {
    const source = fs.readFileSync(path.resolve("src/components/WorkspaceRegistry.tsx"), "utf8");
    expect(source).toContain("Suggestion only — nothing happens until you choose an action.");
    expect(source).toContain("Track as project");
    expect(source).toContain("Link");
    expect(source).toContain("Ignore");
    expect(source).toContain("demo seed");
    expect(source).toContain("/api/workspaces/reconciliation");
  });
});
