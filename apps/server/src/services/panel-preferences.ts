import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  PanelPreferences,
  PanelPreferencesPatch,
  DEFAULT_PANEL_PREFERENCES,
} from "@contextkeep/shared";
export {
  PanelPreferences,
  PanelPreferencesPatch,
  DEFAULT_PANEL_PREFERENCES,
} from "@contextkeep/shared";
const StoredPreferences = z.strictObject({
  version: z.literal(1),
  values: PanelPreferences,
});

/** The single primary process serializes synchronous read/merge/replace operations.
 * No selection, memory records, credentials or authorization settings are stored.
 * Corrupt files fail visibly rather than silently replacing the owner's preferences.
 */
export function readPanelPreferences(file: string): PanelPreferences {
  let content: string;
  try {
    if (fs.statSync(file).size > 8192)
      throw new Error("Preferences file exceeds its size limit.");
    content = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...DEFAULT_PANEL_PREFERENCES };
    throw error;
  }
  return StoredPreferences.parse(JSON.parse(content)).values;
}
export function updatePanelPreferences(
  file: string,
  patch: unknown,
): PanelPreferences {
  const set = PanelPreferencesPatch.parse(patch);
  const values = PanelPreferences.parse({
    ...readPanelPreferences(file),
    ...set,
  });
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    ".panel-preferences-" + randomUUID() + ".tmp",
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ version: 1, values }) + "\n");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    const dir = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
  return readPanelPreferences(file);
}
