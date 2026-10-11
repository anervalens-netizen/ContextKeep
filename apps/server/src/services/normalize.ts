/**
 * Normalize imported text (handoff §8 step 2):
 * strip BOM and wrapping noise, normalize newlines, collapse whitespace runs,
 * keep paragraph boundaries, NFC-normalize (Romanian diacritics preserved
 * byte-stable and searchable).
 */
import { ApiError } from "../lib/errors.js";

export function normalizeText(raw: string): string {
  if (raw.includes("\u0000")) throw new ApiError(400, "unsupported_text_character", "Text must not contain NUL.");
  let t = raw.replace(/^\uFEFF/, "");
  t = t.normalize("NFC");
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/\u00a0/g, " ");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/ *\n */g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}
