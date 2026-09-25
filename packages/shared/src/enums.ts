import { z } from "zod";

/** Handoff §6: lifecycle dimension — what the owner considers the project to be. */
export const lifecycleStates = ["unknown", "planned", "active", "paused", "retired"] as const;
export const LifecycleState = z.enum(lifecycleStates);
export type LifecycleState = z.infer<typeof LifecycleState>;

/** Handoff §6/§7: review status dimension. */
export const reviewStatuses = ["proposed", "accepted", "rejected", "superseded"] as const;
export const ReviewStatus = z.enum(reviewStatuses);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** Handoff §7 Record.type */
export const recordTypes = ["fact", "decision", "action", "constraint", "question"] as const;
export const RecordType = z.enum(recordTypes);
export type RecordType = z.infer<typeof RecordType>;

/** Handoff §6: evidence basis dimension. */
export const evidenceBases = [
  "owner_declaration",
  "agent_report",
  "document",
  "observed_technical",
] as const;
export const EvidenceBasis = z.enum(evidenceBases);
export type EvidenceBasis = z.infer<typeof EvidenceBasis>;

/** Handoff §6: task status; "agent reported done" is a proposal until accepted. */
export const taskStatuses = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export const TaskStatus = z.enum(taskStatuses);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Source kinds (handoff §8 ingest). */
export const sourceKinds = ["paste", "upload", "owner_correction", "system_seed"] as const;
export const SourceKind = z.enum(sourceKinds);
export type SourceKind = z.infer<typeof SourceKind>;

/** Provenance basis (handoff §6 source authority). */
export const provenanceBases = [
  "uploader_metadata",
  "author_label_claimed",
  "owner_review",
  "system",
] as const;
export const ProvenanceBasis = z.enum(provenanceBases);
export type ProvenanceBasis = z.infer<typeof ProvenanceBasis>;

export const conflictStatuses = ["none", "unresolved", "resolved"] as const;
export const ConflictStatus = z.enum(conflictStatuses);
export type ConflictStatus = z.infer<typeof ConflictStatus>;

export const evidenceRelations = ["supports", "contradicts"] as const;
export const EvidenceRelation = z.enum(evidenceRelations);
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;

/** Minimal evidence-backed relation primitive (A5.4). */
export const relationKinds = ["depends_on", "blocks", "affects", "runs_on"] as const;
export const RelationKind = z.enum(relationKinds);
export type RelationKind = z.infer<typeof RelationKind>;

/** CKR-17 deterministic, opt-in context selection diagnostics. */
export const contextDiagnosticReasons = [
  "no_data",
  "no_relevant_match",
  "unreviewed_only",
  "stale",
  "budget_omission",
] as const;
export const ContextDiagnosticReason = z.enum(contextDiagnosticReasons);
export type ContextDiagnosticReason = z.infer<typeof ContextDiagnosticReason>;

/** CK-A05: orthogonal record-memory state, additive to legacy stale/isOverdue. */
export const recordAuthorityStates = ["canonical", "working", "unreviewed", "historical", "rejected", "unknown"] as const;
export const RecordAuthorityState = z.enum(recordAuthorityStates);
export type RecordAuthorityState = z.infer<typeof RecordAuthorityState>;

export const recordCurrentnessStates = [
  "current",
  "review_due",
  "needs_verification",
  "conflicted",
  "future_effective",
  "expired",
  "unknown",
  "not_applicable",
  "historical",
] as const;
export const RecordCurrentnessState = z.enum(recordCurrentnessStates);
export type RecordCurrentnessState = z.infer<typeof RecordCurrentnessState>;

export const recordFreshnessReasons = [
  "review_overdue",
  "newer_observation",
  "possibly_newer_observation",
  "explicit_conflict",
  "effective_not_started",
  "effective_ended",
  "observation_time_unknown",
  "unreviewed_proposal",
  "superseded_history",
] as const;
export const RecordFreshnessReason = z.enum(recordFreshnessReasons);
export type RecordFreshnessReason = z.infer<typeof RecordFreshnessReason>;

export const importStages = [
  "ingested",
  "normalized",
  "chunked",
  "extracted",
  "linked",
  "presented",
  "done",
  "duplicate_skipped",
  "near_duplicate_pending",
  "failed",
] as const;
export const ImportStage = z.enum(importStages);
export type ImportStage = z.infer<typeof ImportStage>;

export const adapterIds = ["manual", "faketest"] as const;
export const AdapterId = z.enum(adapterIds);
export type AdapterId = z.infer<typeof AdapterId>;

/** Predicate reserved for lifecycle records (projection source, handoff §7). */
export const LIFECYCLE_PREDICATE = "lifecycle";

/** Audit actions (A15: every accept/reject/supersession/export is covered). */
export const auditActions = [
  "auth.setup",
  "auth.login",
  "auth.logout",
  "source.imported",
  "source.duplicate_skipped",
  "source.near_duplicate_confirmed",
  "source.extracted_existing",
  "source.extraction_failed",
  "record.proposed",
  "record.accepted",
  "record.rejected",
  "record.edited",
  "record.superseded",
  "supersession.proposed",
  "supersession.confirmed",
  "supersession.cycle_rejected",
  "supersession.precedence_refused",
  "correction.proposed",
  "conflict.created",
  "conflict.resolved",
  "handoff.exported",
  "dump.exported",
  "import_dump.applied",
  "provider_call.refused_disabled",
  "provider_call.refused_not_m0",
  "provider_call.cost_ceiling_exceeded",
  "provider_call.estimate_required",
  "provider_call.estimate_invalid",
  "provider_call.cost_accounting_anomaly",
  "lifecycle.rejected_retired_reactivation",
  "workspace.scan_completed",
  "workspace.linked",
  "workspace.unlinked",
  "workspace.ignored",
  "workspace.unignored",
  "workspace.tracked",
  "connector.source_origin_linked",
  "connector.sync_completed",
  "connector.sync_provider_budget_exceeded",
  "connector.sync_cancelled",
  "connector.sync_retried",
  "connector.sync_resumed",
  "work.captured",
  "backup.created",
  "backup.attempted",
  "backup.completed",
  "backup.failed",
  "restore.performed",
] as const;
export const AuditAction = z.enum(auditActions);
export type AuditAction = z.infer<typeof AuditAction>;
