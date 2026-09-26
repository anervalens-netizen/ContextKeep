import { ApiError } from "../lib/errors.js";

export type TimelineReadCursor = {
  version: 1;
  kind: "timeline";
  projectId: string;
  eventTime: string;
  recordId: string;
  contentVersion: number;
};

export type ExcerptReadCursor = {
  version: 1;
  kind: "source_excerpts";
  sourceId: string;
  normalizedHash: string;
  startOffset: number;
  excerptId: string;
};

function invalidCursor(): never {
  throw new ApiError(
    400,
    "invalid_read_cursor",
    "The pagination cursor is invalid or no longer applicable.",
  );
}

export function encodeReadCursor(
  cursor: TimelineReadCursor | ExcerptReadCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTimelineCursor(
  raw: string,
  projectId: string,
): TimelineReadCursor {
  const cursor = decodeCursor(raw);
  if (
    cursor.version !== 1 ||
    cursor.kind !== "timeline" ||
    cursor.projectId !== projectId ||
    typeof cursor.eventTime !== "string" ||
    cursor.eventTime.length === 0 ||
    typeof cursor.recordId !== "string" ||
    cursor.recordId.length === 0 ||
    typeof cursor.contentVersion !== "number" ||
    !Number.isSafeInteger(cursor.contentVersion) ||
    cursor.contentVersion < 0
  ) {
    invalidCursor();
  }
  return cursor as TimelineReadCursor;
}

export function decodeExcerptCursor(
  raw: string,
  sourceId: string,
): ExcerptReadCursor {
  const cursor = decodeCursor(raw);
  if (
    cursor.version !== 1 ||
    cursor.kind !== "source_excerpts" ||
    cursor.sourceId !== sourceId ||
    typeof cursor.normalizedHash !== "string" ||
    cursor.normalizedHash.length === 0 ||
    typeof cursor.startOffset !== "number" ||
    !Number.isSafeInteger(cursor.startOffset) ||
    cursor.startOffset < 0 ||
    typeof cursor.excerptId !== "string" ||
    cursor.excerptId.length === 0
  ) {
    invalidCursor();
  }
  return cursor as ExcerptReadCursor;
}

function decodeCursor(raw: string): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024)
    invalidCursor();
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const value: unknown = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalidCursor();
    return value as Record<string, unknown>;
  } catch {
    invalidCursor();
  }
}
