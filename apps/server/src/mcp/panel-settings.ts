import { z } from "zod";
import {
  PanelPreferences,
  PanelPreferencesPatch,
  readPanelPreferences,
  updatePanelPreferences,
} from "../services/panel-preferences.js";

export const PANEL_SETTINGS_CAPABILITY = {
  readTool: "settings.read",
  updateTool: "settings.update",
};
export const PANEL_SETTINGS_CAPABILITIES = {
  extensions: { "openai/settings": PANEL_SETTINGS_CAPABILITY },
  experimental: { "openai/settings": PANEL_SETTINGS_CAPABILITY },
};
const schema = z.toJSONSchema(PanelPreferences, { target: "draft-7" });
const layout = [
  {
    kind: "group",
    title: "ContextKeep",
    items: Object.keys(PanelPreferences.shape).map((property) => ({
      kind: "property",
      property,
    })),
  },
];
export const SettingsReadResult = z.object({
  schema: z.record(z.string(), z.unknown()),
  layout: z.array(z.unknown()),
  values: PanelPreferences,
});
export const SettingsUpdateInput = z.strictObject({
  set: PanelPreferencesPatch,
});
export const SettingsUpdateResult = z.object({ values: PanelPreferences });
export function readPanelSettings(file: string) {
  return { schema, layout, values: readPanelPreferences(file) };
}
export function updatePanelSettings(file: string, set: unknown) {
  return { values: updatePanelPreferences(file, set) };
}
