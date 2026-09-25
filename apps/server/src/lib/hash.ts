import crypto from "node:crypto";

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function recordDedupHash(parts: {
  projectId: string | null;
  type: string;
  subject: string;
  text: string;
  /** Optional semantic discriminator for non-canonical event identities. */
  identity?: string | null;
}): string {
  return sha256(
    [parts.projectId ?? "", parts.type, parts.subject, normalizeForHash(parts.text), parts.identity ?? ""].join("\u0000"),
  );
}

function normalizeForHash(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
