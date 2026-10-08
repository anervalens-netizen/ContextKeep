import { z } from "zod";

export const PanelPreferences = z.strictObject({
  landingView: z
    .enum(["recent", "attention", "active"])
    .meta({ title: "Landing view" }),
  taskVisibility: z
    .enum(["actual_tasks", "all_actions"])
    .meta({ title: "Task visibility" }),
  contextBudget: z
    .enum(["compact", "balanced", "deep"])
    .meta({
      title: "Context depth",
      description: "Character budget preset, not billable tokens.",
    }),
  refreshInterval: z
    .enum(["manual", "15s", "30s", "60s", "120s"])
    .meta({ title: "Refresh interval" }),
  language: z.enum(["ro", "en"]).meta({ title: "Language" }),
});
export type PanelPreferences = z.infer<typeof PanelPreferences>;
export const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {
  landingView: "recent",
  taskVisibility: "actual_tasks",
  contextBudget: "balanced",
  refreshInterval: "30s",
  language: "ro",
};
export const PanelPreferencesPatch = PanelPreferences.partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Set at least one preference.",
  )
  .meta({ minProperties: 1 });
