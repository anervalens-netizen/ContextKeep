import type { WorkContextCheckpointDto } from "./dto.js";

export type ResumeRecord = {
  recordId: string;
  revision?: number;
  text?: string;
  subject?: string;
  status?: string;
  provenance?: string;
  taskStatus?: string | null;
  stale?: boolean;
  requiresReview?: boolean;
};

export type ResumeFollowUp = {
  checkpointRecordId: string;
  nextAction: string | null;
  summary?: string | null;
  recordedAt?: string | null;
  provenance?: string | null;
  detailOmittedForBudget?: boolean;
  recovery?: {
    tool?: string;
    recordId?: string;
    includeUnreviewed?: boolean;
  } | null;
};

export type ResumeProjection = {
  project: { id: string; name: string };
  decisions: ResumeRecord[];
  constraints: ResumeRecord[];
  actions: ResumeRecord[];
  facts: ResumeRecord[];
  currentState: ResumeRecord[];
  checkpoint: WorkContextCheckpointDto | null;
  nextAction: string | null;
  followUp: ResumeFollowUp | null;
  blockers: string[];
  workingRecordCount: number;
  proposedCheckpoint: boolean;
  cached: boolean;
  cachedAt: string | null;
  truncated: boolean;
  omissionGuidance: string[];
};

type Section = { items?: unknown[]; omitted?: number; recovery?: unknown };

function recordsFrom(section: unknown): ResumeRecord[] {
  if (!section || typeof section !== "object" || Array.isArray(section))
    return [];
  const items = (section as Section).items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is ResumeRecord =>
    Boolean(
      item &&
      typeof item === "object" &&
      typeof (item as ResumeRecord).recordId === "string",
    ),
  );
}

function checkpointFrom(value: unknown): ResumeProjection["checkpoint"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as WorkContextCheckpointDto;
  if (typeof candidate.recordId !== "string") return null;
  // A budgeted context may retain only the pointer and recovery contract.
  // Preserve it as a checkpoint projection instead of turning it into "none".
  return candidate;
}

function mergeRecords(...groups: ResumeRecord[][]): ResumeRecord[] {
  const byId = new Map<string, ResumeRecord>();
  for (const group of groups) {
    for (const item of group) {
      const previous = byId.get(item.recordId);
      if (!previous) {
        byId.set(item.recordId, { ...item });
        continue;
      }
      byId.set(item.recordId, {
        ...previous,
        ...item,
        text: previous.text ?? item.text,
        subject: previous.subject ?? item.subject,
        stale: previous.stale === true || item.stale === true,
        requiresReview:
          previous.requiresReview === true || item.requiresReview === true,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Typed, deterministic semantic projection used by the owner resume UI and
 * portable/MCP handoff renderers. It only projects already-selected context;
 * it never queries, ranks, or promotes working memory.
 */
export function projectResumeContext(context: {
  project: { id: string; name: string };
  goals?: unknown;
  constraints?: unknown;
  actions?: unknown;
  facts?: unknown;
  currentState?: unknown;
  latestCheckpoint?: unknown;
  latestNextAction?: unknown;
  resumePointersOmittedForBudget?: boolean;
  resumeCapsule?: { nextAction?: unknown; followUp?: unknown } | null;
  latestBlockers?: unknown;
  workingMemory?: { total?: number };
  indicators?: { truncated?: boolean };
  truncated?: boolean;
  cached?: boolean;
  cachedAt?: string | null;
}): ResumeProjection {
  const checkpoint = checkpointFrom(context.latestCheckpoint);
  const hasLatestNextAction = Object.prototype.hasOwnProperty.call(
    context,
    "latestNextAction",
  );
  const capsuleHasNextAction =
    context.resumeCapsule !== null &&
    typeof context.resumeCapsule === "object" &&
    Object.prototype.hasOwnProperty.call(context.resumeCapsule, "nextAction");
  const capsuleNextAction =
    typeof context.resumeCapsule?.nextAction === "string"
      ? context.resumeCapsule.nextAction
      : capsuleHasNextAction && context.resumeCapsule?.nextAction === null
        ? null
        : undefined;
  const useCapsule =
    capsuleHasNextAction &&
    (context.resumePointersOmittedForBudget === true || !hasLatestNextAction);
  const nextAction = useCapsule
    ? (capsuleNextAction ?? null)
    : typeof context.latestNextAction === "string"
      ? context.latestNextAction
      : hasLatestNextAction && context.latestNextAction === null
        ? null
        : (checkpoint?.checkpoint?.nextAction ?? null);
  const rawFollowUp = context.resumeCapsule?.followUp;
  const followUp =
    rawFollowUp &&
    typeof rawFollowUp === "object" &&
    !Array.isArray(rawFollowUp) &&
    typeof (rawFollowUp as Record<string, unknown>).checkpointRecordId ===
      "string"
      ? {
          checkpointRecordId: (rawFollowUp as Record<string, unknown>)
            .checkpointRecordId as string,
          nextAction:
            typeof (rawFollowUp as Record<string, unknown>).nextAction ===
            "string"
              ? ((rawFollowUp as Record<string, unknown>).nextAction as string)
              : null,
          ...(typeof (rawFollowUp as Record<string, unknown>).summary ===
            "string" ||
          (rawFollowUp as Record<string, unknown>).summary === null
            ? {
                summary: (rawFollowUp as Record<string, unknown>).summary as
                  string | null,
              }
            : {}),
          ...(typeof (rawFollowUp as Record<string, unknown>).recordedAt ===
          "string"
            ? {
                recordedAt: (rawFollowUp as Record<string, unknown>)
                  .recordedAt as string,
              }
            : {}),
          ...(typeof (rawFollowUp as Record<string, unknown>).provenance ===
          "string"
            ? {
                provenance: (rawFollowUp as Record<string, unknown>)
                  .provenance as string,
              }
            : {}),
          ...((rawFollowUp as Record<string, unknown>)
            .detailOmittedForBudget === true
            ? { detailOmittedForBudget: true }
            : {}),
          ...((rawFollowUp as Record<string, unknown>).recovery &&
          typeof (rawFollowUp as Record<string, unknown>).recovery ===
            "object" &&
          !Array.isArray((rawFollowUp as Record<string, unknown>).recovery)
            ? {
                recovery: (rawFollowUp as Record<string, unknown>)
                  .recovery as ResumeFollowUp["recovery"],
              }
            : {}),
        }
      : null;
  const blockers = Array.isArray(context.latestBlockers)
    ? context.latestBlockers.filter(
        (item): item is string => typeof item === "string",
      )
    : (checkpoint?.checkpoint?.blockers ?? []);
  const omissionGuidance: string[] = [];
  if (context.truncated === true || context.indicators?.truncated === true) {
    omissionGuidance.push(
      "Some context was omitted for the requested budget; use the record recovery links for the complete entries.",
    );
  }
  if (
    context.currentState &&
    typeof context.currentState === "object" &&
    "scope" in context.currentState &&
    context.currentState.scope === "selected_facts_subset"
  ) {
    omissionGuidance.push(
      "Current state is a selected-facts subset, not a census; zero selected does not mean zero existing.",
    );
  }
  if (checkpoint?.checkpointOmitted === true) {
    omissionGuidance.push(
      "Checkpoint details were omitted for the requested budget; open the checkpoint record to recover them.",
    );
  }
  return {
    project: context.project,
    decisions: recordsFrom(context.goals),
    constraints: recordsFrom(context.constraints),
    actions: recordsFrom(context.actions),
    facts: recordsFrom(context.facts),
    currentState: recordsFrom(context.currentState),
    checkpoint,
    nextAction,
    followUp,
    blockers,
    workingRecordCount: context.workingMemory?.total ?? 0,
    proposedCheckpoint: checkpoint?.status === "proposed",
    cached: context.cached === true,
    cachedAt: context.cachedAt ?? null,
    truncated:
      context.truncated === true || context.indicators?.truncated === true,
    omissionGuidance,
  };
}

function recordLine(label: string, item: ResumeRecord): string {
  const identity = `${item.recordId}${item.revision === undefined ? "" : ` r${item.revision}`}`;
  const trust = [item.status, item.provenance].filter(Boolean).join("/");
  return `- ${label} [${identity}${trust ? ` ${trust}` : ""}]: ${item.text ?? item.subject ?? "(text unavailable)"}`;
}

/** Stable plain-text copy/handoff rendering. */
export function renderResumeText(projection: ResumeProjection): string {
  const lines = [
    `Project: ${projection.project.name} (${projection.project.id})`,
  ];
  if (projection.checkpoint) {
    lines.push(
      `Checkpoint: ${projection.checkpoint.recordId} revision: ${projection.checkpoint.revision ?? "unknown"} recordedAt: ${projection.checkpoint.recordedAt} provenance: ${projection.checkpoint.provenance} status: ${projection.checkpoint.status}`,
    );
    if (projection.proposedCheckpoint)
      lines.push(
        "WARNING: checkpoint is proposed working memory, not canonical truth.",
      );
    const checkpoint = projection.checkpoint.checkpoint;
    if (checkpoint?.summary)
      lines.push(`Checkpoint summary: ${checkpoint.summary}`);
    if (checkpoint?.outcome && checkpoint.outcome !== checkpoint.summary)
      lines.push(`Outcome: ${checkpoint.outcome}`);
  }
  if (projection.nextAction)
    lines.push(`Next action: ${projection.nextAction}`);
  if (projection.followUp) {
    const metadata = [
      projection.followUp.recordedAt
        ? `recordedAt=${projection.followUp.recordedAt}`
        : null,
      projection.followUp.provenance
        ? `provenance=${projection.followUp.provenance}`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      `Post-closure follow-up: checkpoint ${projection.followUp.checkpointRecordId}${metadata ? ` ${metadata}` : ""}`,
    );
    if (projection.followUp.summary)
      lines.push(`Follow-up summary: ${projection.followUp.summary}`);
    lines.push(
      projection.followUp.nextAction
        ? `Follow-up action: ${projection.followUp.nextAction}`
        : "Follow-up action: none; reconcile the checkpoint before starting new work.",
    );
    if (
      projection.followUp.detailOmittedForBudget ||
      projection.followUp.recovery
    ) {
      const recoveryRecord =
        projection.followUp.recovery?.recordId ??
        projection.followUp.checkpointRecordId;
      lines.push(
        `RECOVERY: open follow-up checkpoint ${recoveryRecord} with ${projection.followUp.recovery?.tool ?? "get_record"} for complete details.`,
      );
    }
  }
  projection.blockers.forEach((blocker) => lines.push(`Blocker: ${blocker}`));
  const renderRecords = (label: string, records: ResumeRecord[]): void => {
    for (const item of records) {
      lines.push(recordLine(label, item));
      if (item.stale === true)
        lines.push(
          `  WARNING: ${item.recordId} is stale and needs freshness review.`,
        );
      else if (item.requiresReview === true)
        lines.push(`  WARNING: ${item.recordId} requires owner review.`);
    }
  };
  renderRecords("Decision", projection.decisions);
  renderRecords("Constraint", projection.constraints);
  renderRecords("Action", projection.actions);
  for (const item of mergeRecords(projection.facts, projection.currentState)) {
    const label = projection.facts.some(
      (fact) => fact.recordId === item.recordId,
    )
      ? "Fact/state"
      : "Current state";
    lines.push(recordLine(label, item));
    if (item.stale === true)
      lines.push(
        `  WARNING: ${item.recordId} is stale and needs freshness review.`,
      );
    else if (item.requiresReview === true)
      lines.push(`  WARNING: ${item.recordId} requires owner review.`);
  }
  lines.push(`Unreviewed working records: ${projection.workingRecordCount}`);
  projection.omissionGuidance.forEach((note) =>
    lines.push(`RECOVERY: ${note}`),
  );
  if (projection.cached)
    lines.push(
      `WARNING: copied from a cached snapshot${projection.cachedAt ? ` fetchedAt=${projection.cachedAt}` : " (original fetch time unavailable)"}; this is not live freshness.`,
    );
  return lines.join("\n");
}
