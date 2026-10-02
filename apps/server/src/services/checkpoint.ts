export type BlockerCategory =
  "blocking" | "deferred" | "verification" | "legacy";
export type BlockerMention = {
  text: string;
  category: BlockerCategory;
  logicalKey?: string;
};
export type BlockerMetadata = {
  category: BlockerCategory | null;
  logicalKey: string | null;
};

export interface WorkingCheckpoint {
  kind: "working_checkpoint";
  taskId?: string;
  projectLevelIntent?: "project_note";
  blockerMetadata?: BlockerMetadata[];
  summary?: string;
  outcome?: string;
  nextAction: string | null;
  blockers: string[];
  artifactRefs: string[];
  capturedAt?: string;
}

/** Parse checkpoint metadata from raw DB JSON or an already-decoded DTO value. */
export function parseWorkingCheckpoint(
  value: unknown,
): WorkingCheckpoint | null {
  let decoded = value;
  if (typeof value === "string") {
    if (!value) return null;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    return null;
  const candidate = decoded as Record<string, unknown>;
  if (candidate.kind !== "working_checkpoint") return null;
  return {
    kind: "working_checkpoint",
    ...(typeof candidate.taskId === "string"
      ? { taskId: candidate.taskId }
      : {}),
    ...(typeof candidate.summary === "string"
      ? { summary: candidate.summary }
      : {}),
    ...(typeof candidate.outcome === "string"
      ? { outcome: candidate.outcome }
      : {}),
    ...(candidate.projectLevelIntent === "project_note"
      ? { projectLevelIntent: "project_note" as const }
      : {}),
    ...(Array.isArray(candidate.blockerMetadata)
      ? {
          blockerMetadata: candidate.blockerMetadata.map((item: unknown) => {
            const metadata =
              item && typeof item === "object"
                ? (item as Record<string, unknown>)
                : {};
            return {
              category: [
                "blocking",
                "deferred",
                "verification",
                "legacy",
              ].includes(String(metadata.category))
                ? (metadata.category as BlockerCategory)
                : null,
              logicalKey:
                typeof metadata.logicalKey === "string"
                  ? metadata.logicalKey
                  : null,
            };
          }),
        }
      : {}),
    nextAction:
      typeof candidate.nextAction === "string" ? candidate.nextAction : null,
    blockers: Array.isArray(candidate.blockers)
      ? candidate.blockers.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    artifactRefs: Array.isArray(candidate.artifactRefs)
      ? candidate.artifactRefs.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    ...(typeof candidate.capturedAt === "string"
      ? { capturedAt: candidate.capturedAt }
      : {}),
  };
}

/** Stable semantic identity for one working-capture event; excludes capturedAt. */
export function checkpointIdentity(value: WorkingCheckpoint | null): string {
  if (!value) return "working_capture";
  return JSON.stringify({
    kind: value.kind,
    ...(value.taskId ? { taskId: value.taskId } : {}),
    ...(value.projectLevelIntent
      ? { projectLevelIntent: value.projectLevelIntent }
      : {}),
    ...(value.blockerMetadata
      ? { blockerMetadata: value.blockerMetadata }
      : {}),
    summary: value.summary ?? null,
    outcome: value.outcome ?? null,
    nextAction: value.nextAction,
    blockers: value.blockers,
    artifactRefs: value.artifactRefs,
  });
}
