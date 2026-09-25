import { z } from "zod";
import {
  AuditAction,
  ConflictStatus,
  EvidenceBasis,
  EvidenceRelation,
  ImportStage,
  LifecycleState,
  ProvenanceBasis,
  RecordAuthorityState,
  RecordCurrentnessState,
  RecordFreshnessReason,
  RecordType,
  ReviewStatus,
  SourceKind,
  TaskStatus,
} from "./enums.js";

// ---------------------------------------------------------------------------
// Entity DTOs (server -> client)
// ---------------------------------------------------------------------------

export const ProjectDto = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  parentId: z.string().nullable(),
  description: z.string().nullable(),
  lifecycle: LifecycleState,
  lifecycleRecordId: z.string().nullable(),
  revision: z.number().int(),
  contentVersion: z.number().int().nonnegative(),
  /** A4: present on current server responses; old cached project DTOs default to absent. */
  workingMemoryVersion: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const ExcerptDto = z.object({
  id: z.string(),
  sourceId: z.string(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  text: z.string(),
  exactTextHash: z.string(),
});
export type ExcerptDto = z.infer<typeof ExcerptDto>;

export const EvidenceDto = z.object({
  recordId: z.string(),
  excerptId: z.string(),
  relation: EvidenceRelation,
  observedAt: z.string().nullable(),
  environment: z.string().nullable(),
  artifactRef: z.string().nullable(),
  sourceId: z.string(),
  sourceTitle: z.string().nullable(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  text: z.string(),
});
export type EvidenceDto = z.infer<typeof EvidenceDto>;

export const RecordFreshnessDto = z.object({
  authority: RecordAuthorityState,
  currentness: RecordCurrentnessState,
  progress: TaskStatus.nullable(),
  provenance: EvidenceBasis,
  stale: z.boolean(),
  requiresReview: z.boolean(),
  reasons: z.array(RecordFreshnessReason),
  supportRecordIds: z.array(z.string()),
  possiblyRelatedRecordIds: z.array(z.string()),
});
export type RecordFreshnessDto = z.infer<typeof RecordFreshnessDto>;

export const RecordDto = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  type: RecordType,
  subject: z.string(),
  predicate: z.string().nullable(),
  valueJson: z.unknown().nullable(),
  text: z.string(),
  reviewStatus: ReviewStatus,
  evidenceBasis: EvidenceBasis,
  taskStatus: TaskStatus.nullable(),
  recordedAt: z.string(),
  sourceEventAt: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewDueAt: z.string().nullable(),
  /** A11: volatile fact flag (handoff §12 item 15). When true, the pipeline
   * stamps review_due_at = reviewed_at + CK_VOLATILE_REVIEW_INTERVAL_DAYS on accept. */
  volatile: z.boolean(),
  /** Server-computed: true when volatile=true AND reviewDueAt < now. Drives the
   * in-app review badge without forcing the client to compare timestamps. */
  isOverdue: z.boolean(),
  /** CK-A05 additive model. Optional for legacy cached DTO compatibility. */
  freshness: RecordFreshnessDto.optional(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  evidence: z.array(EvidenceDto),
});
export type RecordDto = z.infer<typeof RecordDto>;

export const SourceDto = z.object({
  id: z.string(),
  kind: SourceKind,
  title: z.string().nullable(),
  originalFilename: z.string().nullable(),
  contentHash: z.string(),
  normalizedHash: z.string(),
  importedAt: z.string(),
  eventAt: z.string().nullable(),
  authorLabel: z.string().nullable(),
  provenanceBasis: ProvenanceBasis,
  projectId: z.string().nullable(),
  redactionState: z.string(),
  excerptCount: z.number().int(),
});
export type SourceDto = z.infer<typeof SourceDto>;

export const SupersessionDto = z.object({
  id: z.string(),
  priorRecordId: z.string(),
  replacementRecordId: z.string(),
  reason: z.string(),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  proposedAt: z.string(),
});
export type SupersessionDto = z.infer<typeof SupersessionDto>;

export const ConflictDto = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  recordIds: z.array(z.string()),
  status: ConflictStatus,
  resolutionRecordId: z.string().nullable(),
  createdAt: z.string(),
});
export type ConflictDto = z.infer<typeof ConflictDto>;

/**
 * Provider usage reported by the adapter for an import (handoff §12 item 13).
 * Null when the adapter reports no cost (manual, or an adapter that did not
 * implement estimateUsage). The pipeline enforces CK_COST_CEILING_USD against
 * `estCostUsd` BEFORE persisting any candidates.
 */
export const ProviderUsageDto = z.object({
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  estCostUsd: z.number(),
  model: z.string().nullable(),
});
export type ProviderUsageDto = z.infer<typeof ProviderUsageDto>;

export const ImportJobDto = z.object({
  id: z.string(),
  sourceId: z.string().nullable(),
  stage: ImportStage,
  adapterId: z.string(),
  adapterVersion: z.string(),
  providerModel: z.string().nullable(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  /** Preflight provider usage reported for this job (handoff §12 item 13). Null when not applicable. */
  providerUsage: ProviderUsageDto.nullable(),
  /** Actual provider usage captured AFTER the call. Null when not applicable. */
  actualUsage: ProviderUsageDto.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ImportJobDto = z.infer<typeof ImportJobDto>;

export const AuditEventDto = z.object({
  id: z.string(),
  actor: z.string(),
  action: AuditAction,
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  timestamp: z.string(),
  beforeRef: z.string().nullable(),
  afterRef: z.string().nullable(),
  detail: z.unknown().nullable(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

// ---------------------------------------------------------------------------
// MCP transport contracts
// ---------------------------------------------------------------------------

export const McpWorkSectionResult = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().min(0),
  returned: z.number().int().min(0),
  omitted: z.number().int().min(0),
  truncated: z.boolean(),
}).passthrough();
export type McpWorkSectionResult = z.infer<typeof McpWorkSectionResult>;

export const WorkContextRecordSummaryDto = z.object({
  recordId: z.string().uuid(),
  revision: z.number().int().min(1).optional(),
  sourceType: z.string().optional(),
  subject: z.string().optional(),
  text: z.string().optional(),
  taskStatus: z.string().nullable().optional(),
  recordedAt: z.string().optional(),
  reviewedAt: z.string().nullable().optional(),
  status: z.string().optional(),
  provenance: z.string().optional(),
  stale: z.boolean().optional(),
  requiresReview: z.boolean().optional(),
  evidenceCount: z.number().int().min(0).optional(),
  evidenceRefs: z.array(z.unknown()).optional(),
}).passthrough();
export type WorkContextRecordSummaryDto = z.infer<typeof WorkContextRecordSummaryDto>;

export const WorkContextRecordSectionDto = McpWorkSectionResult.extend({
  items: z.array(WorkContextRecordSummaryDto),
}).passthrough();
export type WorkContextRecordSectionDto = z.infer<typeof WorkContextRecordSectionDto>;

/** Compact proposal index deliberately does not promise record text. */
export const WorkingIndexDto = WorkContextRecordSummaryDto.extend({
  subject: z.string(),
  revision: z.number().int().positive(),
  status: z.literal("proposed"),
  recordedAt: z.string(),
});
export type WorkingIndexDto = z.infer<typeof WorkingIndexDto>;
export const CurrentStateSectionDto = WorkContextRecordSectionDto.extend({
  scope: z.literal("selected_facts_subset"),
  selectedCount: z.number().int().nonnegative(),
  upstreamOmitted: z.number().int().nonnegative(),
  semantics: z.string(),
});

export const WorkContextCheckpointDto = z.object({
  recordId: z.string().uuid(),
  revision: z.number().int().min(1).optional(),
  recordedAt: z.string(),
  status: z.enum(["proposed", "accepted"]),
  provenance: z.string(),
  checkpoint: z.object({
    summary: z.string().optional(),
    outcome: z.string().optional(),
    nextAction: z.string().nullable().optional(),
    blockers: z.array(z.string()).optional(),
    artifactRefs: z.array(z.string()).optional(),
    artifactRefCount: z.number().int().min(0).optional(),
    capturedAt: z.string().optional(),
  }).passthrough().nullable().optional(),
  checkpointOmitted: z.boolean().optional(),
}).passthrough();
export type WorkContextCheckpointDto = z.infer<typeof WorkContextCheckpointDto>;

export const McpWorkContextResult = z.object({
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    revision: z.number().int().min(1),
    contentVersion: z.number().int().min(0),
    workingMemoryVersion: z.number().int().min(0),
  }).passthrough(),
  freshness: z.object({
    canonicalCursor: z.number().int().min(0),
    workingCursor: z.number().int().min(0),
    canonical: z.object({
      cursor: z.number().int().min(0),
      status: z.string(),
    }).passthrough(),
    working: z.object({
      cursor: z.number().int().min(0),
      status: z.string(),
    }).passthrough(),
  }).passthrough(),
  goals: WorkContextRecordSectionDto,
  actions: WorkContextRecordSectionDto,
  constraints: WorkContextRecordSectionDto,
  openQuestions: WorkContextRecordSectionDto.optional(),
  facts: WorkContextRecordSectionDto.optional(),
  currentState: CurrentStateSectionDto.optional(),
  recentWork: WorkContextRecordSectionDto.optional(),
  workingMemory: WorkContextRecordSectionDto.extend({
    cursor: z.number().int().min(0),
    items: z.array(WorkingIndexDto),
  }).passthrough(),
  recentHandoffs: McpWorkSectionResult.optional(),
  latestCheckpoint: WorkContextCheckpointDto.nullable(),
  blockerState: z.object({
    activeCount: z.number().int().min(0),
    resolvedCount: z.number().int().min(0),
    active: z.array(z.object({
      blockerId: z.string(),
      text: z.string(),
      checkpointRevision: z.number().int().min(1),
    }).passthrough()),
  }).passthrough().optional(),
  indicators: z.object({
    stale: z.boolean(),
    blocked: z.boolean().optional(),
    truncated: z.boolean(),
    unknown: z.array(z.string()),
  }).passthrough(),
  truncated: z.boolean(),
}).passthrough();
export type McpWorkContextResult = z.infer<typeof McpWorkContextResult>;

export const McpToolErrorResult = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    nextAction: z.string(),
    currentRevision: z.number().int().optional(),
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }).passthrough(),
}).passthrough();
export type McpToolErrorResult = z.infer<typeof McpToolErrorResult>;

// ---------------------------------------------------------------------------
// Brief + timeline (handoff §4 journey A)
// ---------------------------------------------------------------------------

export const BriefLifecycleDto = z.object({
  state: LifecycleState,
  recordId: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewDueAt: z.string().nullable(),
});
export type BriefLifecycleDto = z.infer<typeof BriefLifecycleDto>;

/** Every statement in the brief links to its evidence excerpts (M0 scope 5). */
export const BriefStatementDto = z.object({
  record: RecordDto,
  evidence: z.array(EvidenceDto),
});
export type BriefStatementDto = z.infer<typeof BriefStatementDto>;

export const BriefDto = z.object({
  project: ProjectDto,
  lifecycle: BriefLifecycleDto,
  description: z.string().nullable(),
  facts: z.array(BriefStatementDto),
  decisions: z.array(BriefStatementDto),
  constraints: z.array(BriefStatementDto),
  openQuestions: z.array(BriefStatementDto),
  actions: z.array(BriefStatementDto),
  lastReviewedAt: z.string().nullable(),
  generatedAt: z.string(),
  revision: z.number().int(),
  contentVersion: z.number().int().nonnegative(),
});
export type BriefDto = z.infer<typeof BriefDto>;

export const TimelineEntryDto = z.object({
  record: RecordDto,
  supersededBy: z
    .object({ recordId: z.string(), confirmedAt: z.string().nullable(), reason: z.string() })
    .nullable(),
  supersedes: z.array(
    z.object({ recordId: z.string(), confirmedAt: z.string().nullable(), reason: z.string() }),
  ),
});
export type TimelineEntryDto = z.infer<typeof TimelineEntryDto>;

export const TimelineDto = z.object({
  projectId: z.string(),
  entries: z.array(TimelineEntryDto),
});
export type TimelineDto = z.infer<typeof TimelineDto>;

// ---------------------------------------------------------------------------
// Import pipeline (handoff §8)
// ---------------------------------------------------------------------------

export const NearDuplicateInfoDto = z.object({
  sourceId: z.string(),
  title: z.string().nullable(),
  similarity: z.number(),
  importedAt: z.string(),
});
export type NearDuplicateInfoDto = z.infer<typeof NearDuplicateInfoDto>;

export const ImportPreviewDto = z.object({
  jobId: z.string(),
  status: z.enum(["created", "duplicate_skipped", "near_duplicate_pending"]),
  source: SourceDto.nullable(),
  duplicateOf: NearDuplicateInfoDto.nullable(),
  nearDuplicates: z.array(NearDuplicateInfoDto),
  excerptCount: z.number().int(),
  candidateCount: z.number().int(),
  warnings: z.array(z.string()),
  /** Preflight provider usage (before network call). Null when no provider usage was reported for this import. */
  providerUsage: ProviderUsageDto.nullable(),
  /** Actual provider usage captured AFTER the call (post-cost ceiling enforcement). Null when the adapter does not track usage or the call did not reach the provider. */
  actualUsage: ProviderUsageDto.nullable(),
  /** The ceiling applied to this import, in USD. Useful for UI surfacing. */
  costCeilingUsd: z.number(),
});
export type ImportPreviewDto = z.infer<typeof ImportPreviewDto>;

/** Extraction adapter output (handoff §8 step 4). */
export const CandidateRecordInput = z.object({
  type: RecordType,
  subject: z.string(),
  predicate: z.string().nullable(),
  valueJson: z.unknown().nullable(),
  text: z.string(),
  evidenceBasis: EvidenceBasis,
  taskStatus: TaskStatus.nullable(),
  sourceEventAt: z.string().nullable(),
  excerptId: z.string(),
  relation: EvidenceRelation,
  confidence: z.number().min(0).max(1).nullable(),
  /** A11: mark this candidate as volatile (its currency expires). Default false. */
  volatile: z.boolean().default(false),
});
export type CandidateRecordInput = z.infer<typeof CandidateRecordInput>;

// ---------------------------------------------------------------------------
// API inputs (client -> server)
// ---------------------------------------------------------------------------

export const SetupInput = z.object({
  password: z.string().min(8).max(256),
});
export type SetupInput = z.infer<typeof SetupInput>;

export const LoginInput = z.object({
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const ProjectCreateInput = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(50).default([]),
  parentId: z.string().nullable().default(null),
  description: z.string().max(4000).nullable().default(null),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInput>;

export const ProjectUpdateInput = z.object({
  revision: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  aliases: z.array(z.string().max(200)).max(50).optional(),
  parentId: z.string().nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
});
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInput>;

export const ImportTextInput = z.object({
  text: z.string().min(1).max(4 * 1024 * 1024),
  kind: z.enum(["paste", "upload"]).default("paste"),
  title: z.string().max(400).nullable().default(null),
  originalFilename: z.string().max(400).nullable().default(null),
  projectId: z.string().nullable().default(null),
  /** Free string on purpose: unknown adapters must reach the registry so the
   * refusal is audit-logged (A21); an enum here would 400 before that. */
  adapterId: z.string().min(1).max(64).default("manual"),
  eventAt: z.string().datetime().nullable().default(null),
  authorLabel: z.string().max(200).nullable().default(null),
  /** A1: near-duplicates require explicit confirmation, never silent merge. */
  confirmNearDuplicateOf: z.string().nullable().default(null),
});
export type ImportTextInput = z.infer<typeof ImportTextInput>;

export const ReviewTargetInput = z.object({
  recordId: z.string(),
  /** The exact record revision displayed/read before the owner decides. */
  revision: z.number().int().min(1),
});
export type ReviewTargetInput = z.infer<typeof ReviewTargetInput>;

export const ReviewEditInput = z.object({
  /** Must match the selected ReviewTargetInput revision. */
  revision: z.number().int().min(1),
  text: z.string().min(1).max(8000).optional(),
  subject: z.string().min(1).max(400).optional(),
  type: RecordType.optional(),
  projectId: z.string().nullable().optional(),
  taskStatus: TaskStatus.nullable().optional(),
});
export type ReviewEditInput = z.infer<typeof ReviewEditInput>;

export const ReviewDecisionInput = z.object({
  /** Decisions are revision-bound; IDs without revisions are never accepted. */
  items: z.array(ReviewTargetInput).min(1).max(500),
  action: z.enum(["accept", "reject"]),
  edits: z.record(z.string(), ReviewEditInput).default({}),
});
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInput>;

export const ReviewResultDto = z.object({
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  edited: z.array(z.string()),
  blocked: z.array(
    z.object({ recordId: z.string(), code: z.string(), message: z.string() }),
  ),
});
export type ReviewResultDto = z.infer<typeof ReviewResultDto>;

/** Correction workflow (handoff §4 journey C; A2/A3/A4/A19). */
export const CorrectionInput = z.object({
  statement: z.string().min(1).max(4000),
  projectId: z.string().nullable().default(null),
  scopeProjectIds: z.array(z.string()).max(50).default([]),
  supersedesRecordIds: z.array(z.string()).max(50).default([]),
  lifecycleChange: z
    .object({ projectId: z.string(), state: LifecycleState })
    .nullable()
    .default(null),
  recordType: RecordType.default("fact"),
  subject: z.string().min(1).max(400).default("owner-correction"),
  /** Structured claims (predicate != null) get A2 contradiction enforcement. */
  predicate: z.string().min(1).max(200).nullable().default(null),
  /** Required semantic object when predicate is a multi-valued relation. */
  relationObject: z.string().trim().min(1).max(400).nullable().default(null),
});
export type CorrectionInput = z.infer<typeof CorrectionInput>;

export const CorrectionPreviewDto = z.object({
  jobId: z.string(),
  proposedRecordIds: z.array(z.string()),
  affected: z.array(RecordDto),
  warnings: z.array(z.string()),
});
export type CorrectionPreviewDto = z.infer<typeof CorrectionPreviewDto>;

export const SupersedeConfirmInput = z.object({
  supersessionIds: z.array(z.string()).min(1).max(50),
});
export type SupersedeConfirmInput = z.infer<typeof SupersedeConfirmInput>;

export const HandoffExportInput = z.object({
  projectId: z.string(),
  objective: z.string().max(2000).nullable().default(null),
  contextBudgetChars: z.number().int().min(2000).max(400_000).default(60_000),
});
export type HandoffExportInput = z.infer<typeof HandoffExportInput>;

export const HandoffExportDto = z.object({
  id: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  objective: z.string().nullable(),
  sourceRevision: z.number().int(),
  sourceContentVersion: z.number().int().nonnegative(),
  markdown: z.string(),
  includedRecordIds: z.array(z.string()),
  truncationNotes: z.array(z.string()),
});
export type HandoffExportDto = z.infer<typeof HandoffExportDto>;

export const SearchMode = z.enum(["canonical", "discovery"]);
export type SearchMode = z.infer<typeof SearchMode>;
export const SearchMatch = z.enum(["terms", "phrase"]);
export type SearchMatch = z.infer<typeof SearchMatch>;
/** Retrieval truth boundary. Canonical is the backward-compatible default. */
export const SearchScope = z.enum(["canonical", "working", "all"]);
export type SearchScope = z.infer<typeof SearchScope>;

export const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  mode: SearchMode.default("discovery"),
  match: SearchMatch.default("terms"),
  scope: SearchScope.default("canonical"),
  projectId: z.string().nullable().default(null),
  includeHistorical: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const SearchCompletenessDto = z.object({
  returned: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  mayHaveMore: z.boolean(),
  candidateLimitReached: z.boolean(),
});
export const SearchCompletenessSectionsDto = z.object({
  records: SearchCompletenessDto, workingRecords: SearchCompletenessDto,
  projects: SearchCompletenessDto, sources: SearchCompletenessDto,
});

export const SearchRecordSummaryDto = WorkContextRecordSummaryDto.extend({
  projectId: z.string().uuid().nullable(),
  subject: z.string(),
  text: z.string(),
  type: RecordType,
  reviewStatus: ReviewStatus,
  status: z.string(),
  provenance: EvidenceBasis,
  recordedAt: z.string(),
  stale: z.boolean(),
  requiresReview: z.boolean(),
});
export const McpSearchResultDto = z.object({
  query: z.string(), scope: SearchScope,
  records: z.array(SearchRecordSummaryDto),
  canonicalRecords: z.array(SearchRecordSummaryDto),
  workingRecords: z.array(SearchRecordSummaryDto),
  completeness: SearchCompletenessSectionsDto,
}).passthrough();
export const TimelineEntrySummaryDto = z.object({
  record: RecordDto.omit({ evidence: true, projectName: true }).extend({
    recordId: z.string().uuid(),
    evidenceIds: z.array(z.string().uuid()),
    evidenceCount: z.number().int().nonnegative(),
    textTruncated: z.boolean(),
  }),
  supersededBy: z.object({ recordId: z.string().uuid(), confirmedAt: z.string().nullable(), reason: z.string() }).nullable(),
  supersedes: z.array(z.object({ recordId: z.string().uuid(), confirmedAt: z.string().nullable(), reason: z.string() })),
});

export const SearchResultDto = z.object({
  query: z.string(),
  mode: SearchMode,
  match: SearchMatch,
  scope: SearchScope,
  includeHistorical: z.boolean(),
  records: z.array(RecordDto),
  /** Unreviewed agent_report records; never part of canonical `records`. */
  workingRecords: z.array(RecordDto),
  projects: z.array(ProjectDto),
  sources: z.array(
    z.object({
      source: SourceDto,
      matchedExcerpts: z.array(ExcerptDto).max(5),
    }),
  ),
  completeness: SearchCompletenessSectionsDto,
  tookMs: z.number(),
});
export type SearchResultDto = z.infer<typeof SearchResultDto>;

export const AuthStatusDto = z.object({
  needsSetup: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthStatusDto = z.infer<typeof AuthStatusDto>;

/**
 * Bounded synthesis (handoff §12 item 14). Every claim carries its
 * evidence excerpts so the answer cannot fabricate state outside of
 * ContextKeep evidence. The status marker is one of four explicit
 * outcomes — there is no probabilistic completion path.
 */
export const SynthesisStatus = z.enum(["known", "unknown", "stale", "disputed"]);
export type SynthesisStatus = z.infer<typeof SynthesisStatus>;

export const SynthesisClaimDto = z.object({
  recordId: z.string(),
  text: z.string(),
  reviewStatus: ReviewStatus,
  volatile: z.boolean(),
  reviewDueAt: z.string().nullable(),
  isStale: z.boolean(),
  evidence: z.array(EvidenceDto),
});
export type SynthesisClaimDto = z.infer<typeof SynthesisClaimDto>;

export const SynthesisInput = z.object({
  question: z.string().max(2000),
  projectId: z.string().nullable().default(null),
  includeHistorical: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type SynthesisInput = z.infer<typeof SynthesisInput>;

export const SynthesisDto = z.object({
  question: z.string(),
  status: SynthesisStatus,
  claims: z.array(SynthesisClaimDto),
  /** Present only when status === 'disputed' — record pairs that disagree. */
  contradictions: z
    .array(
      z.object({
        recordIdA: z.string(),
        recordIdB: z.string(),
        subject: z.string(),
        predicate: z.string().nullable(),
      }),
    )
    .default([]),
  generatedAt: z.string(),
});
export type SynthesisDto = z.infer<typeof SynthesisDto>;

export const ApiErrorDto = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});
export type ApiErrorDto = z.infer<typeof ApiErrorDto>;

/** A6: bulk inbox actions report atomically applied counts. */
export const InboxPageDto = z.object({
  candidates: z.array(RecordDto),
  total: z.number().int(),
  byProject: z.array(z.object({ projectId: z.string().nullable(), projectName: z.string().nullable(), count: z.number().int() })),
});
export type InboxPageDto = z.infer<typeof InboxPageDto>;
