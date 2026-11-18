import { ApiError } from "../lib/errors.js";

interface BoundedSearch {
  records: Array<Record<string, unknown>>;
  workingRecords: Array<Record<string, unknown>>;
  completeness: {
    records: {
      returned: number;
      mayHaveMore: boolean;
      candidateLimitReached: boolean;
      limit: number;
    };
    workingRecords: {
      returned: number;
      mayHaveMore: boolean;
      candidateLimitReached: boolean;
      limit: number;
    };
  };
  [name: string]: unknown;
}

function clip(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  return value.length <= limit ? value : value.slice(0, limit) + "…";
}

function card(record: Record<string, unknown>): Record<string, unknown> {
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const checkpoint =
    record.checkpoint &&
    typeof record.checkpoint === "object" &&
    !Array.isArray(record.checkpoint)
      ? (record.checkpoint as Record<string, unknown>)
      : null;
  const {
    text,
    evidence: _evidence,
    checkpoint: _checkpoint,
    ...core
  } = record;
  return {
    ...core,
    text: clip(text, 144) ?? "",
    textOmitted: typeof text === "string" && text.length > 144,
    evidence: [],
    evidenceOmittedCount: evidence.length,
    evidenceOmitted: evidence.length > 0,
    checkpoint: checkpoint
      ? {
          kind: checkpoint.kind,
          ...(checkpoint.taskId ? { taskId: checkpoint.taskId } : {}),
          nextAction: clip(checkpoint.nextAction, 180),
          summary: clip(checkpoint.summary, 100),
        }
      : null,
    checkpointDetailOmitted: checkpoint !== null,
    detailTool: "get_record",
    detailArgs: {
      recordId: record.recordId,
      ...(record.reviewStatus === "proposed"
        ? { includeUnreviewed: true }
        : {}),
    },
  };
}

/** The protected search core is never silently dropped to satisfy a byte limit. */
export function packSearchCards(
  source: BoundedSearch,
  maxResultBytes: number,
): BoundedSearch {
  const originalRecords = source.records.length;
  const originalWorking = source.workingRecords.length;
  const packed: BoundedSearch = {
    ...source,
    compact: true,
    representation: "cards",
    records: source.records.map(card),
    workingRecords: source.workingRecords.map(card),
    completeness: {
      ...source.completeness,
      records: { ...source.completeness.records },
      workingRecords: { ...source.completeness.workingRecords },
    },
  };
  delete packed.canonicalRecords;
  packed.budget = {
    requestedBytes: maxResultBytes,
    actualBytes: 0,
    totalRecordsBeforePacking: originalRecords,
    totalWorkingBeforePacking: originalWorking,
    omittedRecords: 0,
    omittedWorking: 0,
    truncated: [...packed.records, ...packed.workingRecords].some(
      (row) =>
        row.textOmitted === true ||
        row.evidenceOmitted === true ||
        row.checkpointDetailOmitted === true,
    ),
    recoverDetailsWith: "get_record",
  };
  const budget = packed.budget as Record<string, string | number | boolean>;
  const serializedSize = (): number => {
    // This byte contract is for structuredContent, not MCP JSON-RPC framing.
    const size = Buffer.byteLength(JSON.stringify(packed), "utf8");
    budget.actualBytes = size;
    return Buffer.byteLength(JSON.stringify(packed), "utf8");
  };
  while (serializedSize() > maxResultBytes) {
    const canRemoveAccepted =
      packed.records.length > (originalRecords > 0 ? 1 : 0);
    const canRemoveWorking =
      packed.workingRecords.length > (originalWorking > 0 ? 1 : 0);
    if (!canRemoveAccepted && !canRemoveWorking) {
      throw new ApiError(
        422,
        "search_budget_too_small",
        "Search summary cannot preserve an identifiable first result from every requested truth scope. Increase maxResultBytes or narrow the query.",
      );
    }
    if (
      canRemoveAccepted &&
      (!canRemoveWorking ||
        packed.records.length >= packed.workingRecords.length)
    ) {
      packed.records.pop();
    } else {
      packed.workingRecords.pop();
    }
    budget.omittedRecords = originalRecords - packed.records.length;
    budget.omittedWorking = originalWorking - packed.workingRecords.length;
    budget.truncated = true;
    packed.completeness.records.returned = packed.records.length;
    packed.completeness.workingRecords.returned = packed.workingRecords.length;
    packed.completeness.records.mayHaveMore ||=
      (budget.omittedRecords as number) > 0;
    packed.completeness.workingRecords.mayHaveMore ||=
      (budget.omittedWorking as number) > 0;
  }
  serializedSize();
  if ((budget.actualBytes as number) > maxResultBytes) {
    throw new ApiError(
      422,
      "search_budget_too_small",
      "Search summary exceeds maxResultBytes. Increase the budget or narrow the query.",
    );
  }
  return packed;
}

export function enforceSearchResultBytes(
  result: unknown,
  maxResultBytes: number,
): void {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxResultBytes) {
    throw new ApiError(
      422,
      "search_budget_exceeded",
      "The full search result exceeds maxResultBytes. Use representation=cards, increase the budget, or narrow the query.",
    );
  }
}
