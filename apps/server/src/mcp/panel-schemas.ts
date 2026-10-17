import { z } from "zod";

// Shared with the host-contract browser fixture; keep its validation identical
// to the schemas registered by the live MCP server.
export const PanelProjectsInput = z.strictObject({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(50),
  q: z.string().trim().min(1).max(200).optional(),
});
export const PanelTasksInput = PanelProjectsInput.extend({
  projectId: z.string().uuid().describe("Project UUID returned by list_projects; do not invent IDs."),
  selection: z.enum(["all_actions", "actual_tasks"]).default("actual_tasks"),
  view: z.enum(["recent", "attention", "active"]).optional(),
});
