import type {
  TaskAttention,
  BlockerCategoryCounts,
  AttentionCategory,
} from "@contextkeep/shared";
export interface AttentionInput {
  state: string;
  lifecycle: string;
  blockerCounts: BlockerCategoryCounts;
  liveExecutions: number;
  verificationRequired: number;
  invalidEvidence: number;
  reconciliationNeeded: number;
  followUp: boolean;
  ownerAction: boolean;
}
export function classifyTaskAttention(input: AttentionInput): TaskAttention {
  const items: TaskAttention["items"] = [];
  const lifecycleSuppressed =
    input.lifecycle === "paused" || input.lifecycle === "retired";
  const terminal = input.state === "done" || input.state === "cancelled";
  const add = (
    category: AttentionCategory,
    reason: string,
    count: number,
    requiresAction: boolean,
  ) => {
    if (count > 0) items.push({ category, reason, count, requiresAction });
  };
  const workCategory = terminal
    ? "historical_integrity"
    : lifecycleSuppressed
      ? "deferred"
      : "actionable_now";
  add(
    workCategory,
    "blocked_state",
    Number(input.state === "blocked"),
    !lifecycleSuppressed,
  );
  add(
    workCategory,
    "active_blocker",
    input.blockerCounts.blocking,
    !lifecycleSuppressed,
  );
  add(
    "verification_needed",
    "verification_blocker",
    input.blockerCounts.verification,
    true,
  );
  add("deferred", "deferred_blocker", input.blockerCounts.deferred, false);
  // Unclassified history is visible without inventing present urgency.
  add(
    "historical_integrity",
    "legacy_blocker",
    input.blockerCounts.legacy,
    false,
  );
  // These must remain visible even for closed tasks or paused/retired projects.
  add("actionable_now", "unresolved_execution", input.liveExecutions, true);
  add(
    "verification_needed",
    "unresolved_execution",
    input.verificationRequired,
    true,
  );
  add(
    "historical_integrity",
    "invalid_execution_evidence",
    input.invalidEvidence,
    true,
  );
  add(
    "verification_needed",
    "continuation_reconciliation",
    input.reconciliationNeeded,
    true,
  );
  add(
    "historical_integrity",
    "post_closure_follow_up",
    Number(input.followUp),
    true,
  );
  add("owner_optional", "owner_action", Number(input.ownerAction), false);
  return {
    items,
    needsAttention: items.some((item) => item.requiresAction),
    lifecycleSuppressed,
    lifecycleSuppressionReason: lifecycleSuppressed
      ? input.lifecycle === "paused"
        ? "project_paused"
        : "project_retired"
      : null,
  };
}
