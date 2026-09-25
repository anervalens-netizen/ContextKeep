export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.min(Math.max(asSeconds * 1000, 0), 60_000); // clamp to [0, 60s]
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - now, 0), 60_000);
  }
  return undefined;
}

export function inboxDecisionNeedsFreshReview(row: {
  method: string;
  url: string;
  body?: unknown;
}): boolean {
  if (row.method.toUpperCase() !== "POST" || row.url !== "/api/inbox/decide")
    return false;
  if (!row.body || typeof row.body !== "object" || Array.isArray(row.body))
    return true;
  const items = (row.body as Record<string, unknown>)["items"];
  if (!Array.isArray(items) || items.length === 0) return true;
  return items.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate["recordId"] !== "string" ||
      !Number.isInteger(candidate["revision"]) ||
      (candidate["revision"] as number) < 1
    );
  });
}
