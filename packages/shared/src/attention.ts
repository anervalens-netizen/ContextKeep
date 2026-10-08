export type AttentionCategory =
  | "actionable_now"
  | "verification_needed"
  | "owner_optional"
  | "deferred"
  | "historical_integrity";
export type BlockerCategoryCounts = {
  blocking: number;
  verification: number;
  deferred: number;
  legacy: number;
};
export interface TaskAttention {
  items: Array<{
    category: AttentionCategory;
    reason: string;
    count: number;
    requiresAction: boolean;
  }>;
  needsAttention: boolean;
  lifecycleSuppressed: boolean;
  lifecycleSuppressionReason: "project_paused" | "project_retired" | null;
}
