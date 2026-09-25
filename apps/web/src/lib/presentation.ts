export function formatLocalDateTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

export function describeReadError(error: unknown, resource: string): string {
  const value = error && typeof error === "object"
    ? error as { name?: string; status?: number; code?: string; message?: string }
    : {};
  if (value.name === "TransportTimeoutError" || value.code === "transport_timeout") {
    return `${resource} timed out while waiting for the server. The last server-side result may still arrive; retry the read.`;
  }
  if (value.name === "CallerAbortedError" || value.code === "caller_abort") {
    return `${resource} was cancelled before the read completed.`;
  }
  if (value.status === 401 || value.code === "unauthorized") {
    return `${resource} requires sign-in again.`;
  }
  if (value.status === 403) {
    return `${resource} is not available with the current authorization.`;
  }
  if (typeof value.status === "number" && value.status >= 400) {
    return `${resource} failed: ${value.message ?? `HTTP ${value.status}`}`;
  }
  const message = value.message?.toLowerCase() ?? "";
  if (
    error instanceof TypeError ||
    value.name === "UnverifiedDataResponseError" ||
    /failed to fetch|network|offline|connection/.test(message)
  ) {
    return `${resource} is unavailable offline and no verified local copy is available.`;
  }
  return `${resource} could not be loaded.`;
}

export function describeCacheAge(fetchedAt: string | null | undefined): string {
  return fetchedAt ? `Cached snapshot fetched at ${formatLocalDateTime(fetchedAt)}; this is not live freshness.` : "Cached snapshot age is unknown (legacy cache).";
}
