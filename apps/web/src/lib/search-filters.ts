export const recordTypes = ["fact", "decision", "action", "constraint", "question"] as const;

// Preserve invalid URL values so the UI can explain them instead of widening
// a shared search. Date inputs themselves cannot display malformed dates.
function urlValue(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type SearchFilters = {
  q?: string;
  includeHistorical?: boolean;
  projectId?: string;
  scope?: string;
  recordType?: string;
  recordedFrom?: string;
  recordedTo?: string;
  limit?: string | number;
};

export function validateSearchFilters(search: Record<string, unknown>): SearchFilters {
  const rawLimit = urlValue(search.limit);
  return {
    q: typeof search.q === "string" ? search.q : undefined,
    includeHistorical: search.includeHistorical === true || search.includeHistorical === "true" ? true : undefined,
    projectId: urlValue(search.projectId),
    scope: urlValue(search.scope),
    recordType: urlValue(search.recordType),
    recordedFrom: urlValue(search.recordedFrom),
    recordedTo: urlValue(search.recordedTo),
    limit: rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit,
  };
}

export function isRecordedDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function searchFilterError(search: ReturnType<typeof validateSearchFilters>): string | null {
  if (search.scope && !["canonical", "working", "all"].includes(search.scope)) return `Invalid memory scope: “${search.scope}”.`;
  if (search.recordType && !recordTypes.some(type => type === search.recordType)) return `Invalid record type: “${search.recordType}”.`;
  for (const [label, value] of [["Recorded from", search.recordedFrom], ["Recorded to", search.recordedTo]]) {
    if (value && !isRecordedDate(value)) return `${label}: “${value}” is not a valid UTC recorded date (YYYY-MM-DD).`;
  }
  if (search.recordedFrom && search.recordedTo && search.recordedFrom > search.recordedTo) return `Recorded from (${search.recordedFrom}) must be on or before Recorded to (${search.recordedTo}), in UTC.`;
  const limit = search.limit ?? 50;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) return `Invalid result limit: “${limit}”. Use an integer from 1 to 200.`;
  return null;
}

export type SearchIdentity = {
  query: string;
  includeHistorical: boolean;
  projectId: string | null;
  scope?: "canonical" | "working" | "all";
  recordType?: string;
  recordedFrom?: string;
  recordedTo?: string;
  limit?: number;
};

export const isDefaultSearchWindow = (input: SearchIdentity): boolean =>
  !input.recordType && !input.recordedFrom && !input.recordedTo && (input.limit ?? 50) === 50;

export const searchIdentityParts = (input: SearchIdentity) => [
  input.query, input.includeHistorical, input.projectId, input.scope ?? "canonical",
  input.recordType || null, input.recordedFrom || null, input.recordedTo || null, input.limit ?? 50,
];

export function searchCacheScope(input: SearchIdentity): string {
  // The v2 scope represents exactly the unfiltered 50-result window.
  if (isDefaultSearchWindow(input)) return `search:q=${input.query}:historical=${input.includeHistorical}:project=${input.projectId || "*"}:scope=${input.scope ?? "canonical"}`;
  return `search:v3:${JSON.stringify(searchIdentityParts(input))}`;
}
