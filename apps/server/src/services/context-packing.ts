/** Pure packing helpers shared by the bounded work-context packer. */
export function summarizeContextSection(
  section: unknown,
): Record<string, unknown> {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { total: 0, returned: 0, omitted: 0, truncated: false, items: [] };
  }
  const current = section as Record<string, unknown>;
  const items = Array.isArray(current.items) ? current.items : [];
  const total =
    typeof current.total === "number" ? current.total : items.length;
  return {
    ...current,
    items,
    ...(current.permanentCore && typeof current.permanentCore === "object"
      ? (() => {
          const core = current.permanentCore as Record<string, unknown>;
          const requested = Array.isArray(core.requestedRecordIds)
            ? core.requestedRecordIds
            : [];
          const selected = requested.filter((id) =>
            items.some(
              (item) =>
                item &&
                typeof item === "object" &&
                (item as Record<string, unknown>).recordId === id,
            ),
          );
          return {
            permanentCore: {
              ...core,
              selectedCount: selected.length,
              omittedCount: requested.length - selected.length,
              selectedRecordIds: selected,
            },
          };
        })()
      : {}),
    returned: items.length,
    omitted: Math.max(0, total - items.length),
    truncated: current.truncated === true || total > items.length,
  };
}

function clipped(value: unknown, max: number): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** Keep identity, trust, freshness and a recovery pointer before prose. */
export function compactContextRecord(
  raw: unknown,
  maxTextChars: number,
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown>;
  // A zero section budget means "compact this record", not "erase its
  // semantic claim". Keep a small deterministic excerpt so facts/current
  // state remain useful after metadata has been compacted.
  const textChars = maxTextChars > 0 ? Math.min(maxTextChars, 240) : 160;
  return {
    recordId: item.recordId,
    revision: item.revision,
    sourceType: item.sourceType,
    recordedAt: item.recordedAt,
    subject: clipped(item.subject, 160),
    predicate: item.predicate,
    ...(typeof item.text === "string"
      ? { text: clipped(item.text, textChars) }
      : {}),
    taskStatus: item.taskStatus,
    status: item.status,
    provenance: item.provenance,
    stale: item.stale,
    requiresReview: item.requiresReview,
    freshnessReasons: item.freshnessReasons,
    detailOmittedForBudget: true,
    recovery: { tool: "get_record" },
  };
}

export function compactLatestCheckpoint(
  latest: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!latest) return null;
  const checkpoint =
    latest.checkpoint &&
    typeof latest.checkpoint === "object" &&
    !Array.isArray(latest.checkpoint)
      ? (latest.checkpoint as Record<string, unknown>)
      : null;
  return {
    recordId: latest.recordId,
    revision: latest.revision,
    recordedAt: latest.recordedAt,
    status: latest.status,
    provenance: latest.provenance,
    checkpoint: checkpoint
      ? {
          ...(typeof checkpoint.summary === "string"
            ? { summary: checkpoint.summary.slice(0, 240) }
            : {}),
          ...(typeof checkpoint.outcome === "string"
            ? { outcome: checkpoint.outcome.slice(0, 240) }
            : {}),
          nextAction:
            typeof checkpoint.nextAction === "string"
              ? checkpoint.nextAction.slice(0, 300)
              : null,
          blockers: Array.isArray(checkpoint.blockers)
            ? checkpoint.blockers
                .filter((item): item is string => typeof item === "string")
                .slice(0, 2)
                .map((item) => item.slice(0, 180))
            : [],
          ...(typeof checkpoint.artifactRefCount === "number"
            ? { artifactRefCount: checkpoint.artifactRefCount }
            : {}),
        }
      : null,
    ...(checkpoint ? {} : { checkpointOmitted: true }),
    recovery: { tool: "get_record", includeUnreviewed: true },
  };
}
