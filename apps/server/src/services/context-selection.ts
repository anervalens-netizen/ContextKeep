export type ContextSelectionRow = { id: string };

/** Keep at least one mandatory guardrail at limit=1; grow slowly with budget. */
export function mandatoryContextQuota(limit: number): number {
  return limit <= 1 ? 1 : Math.max(1, Math.ceil(limit / 3));
}

/**
 * Deterministic selection for task-aware sections. Mandatory rows are already
 * ordered by their semantic priority (in-progress/blocked actions first, or
 * newest constraints). They receive a reserved quota before lexical matches;
 * duplicates are removed without consuming either quota.
 */
export function selectContextRows<T extends ContextSelectionRow>(input: {
  relevantRows: readonly T[];
  mandatoryRows: readonly T[];
  limit: number;
}): T[] {
  const limit = Math.max(1, input.limit);
  const selected: T[] = [];
  const seen = new Set<string>();
  const add = (row: T): void => {
    if (selected.length >= limit || seen.has(row.id)) return;
    seen.add(row.id);
    selected.push(row);
  };
  input.mandatoryRows.slice(0, mandatoryContextQuota(limit)).forEach(add);
  input.relevantRows.forEach(add);
  // A query may have no lexical matches (or only duplicates). Use remaining
  // applicable mandatory rows to fill otherwise-unused slots, while keeping
  // the reserved prefix and its deterministic priority intact.
  input.mandatoryRows.slice(mandatoryContextQuota(limit)).forEach(add);
  return selected;
}
