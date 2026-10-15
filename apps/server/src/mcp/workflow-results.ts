import { z } from "zod";

const id = z.string().uuid();
const count = z.number().int().nonnegative();
const revision = z.number().int().positive();
const review = z.enum(["proposed", "accepted", "rejected", "superseded"]);
const state = z.enum([
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
  "unknown",
]);
const stateSource = z.enum(["task_record", "reported_progress", "unknown"]);
const object = z.object({}).passthrough();
const source = z
  .object({
    recordId: id,
    recordedAt: z.string(),
    evidenceBasis: z.string(),
    reviewStatus: review,
  })
  .passthrough();
const progress = z
  .object({
    recordId: id,
    taskId: id,
    taskRevision: revision,
    revision,
    status: state,
    summary: z.string(),
    nextAction: z.string().nullable(),
    reviewStatus: review,
    evidenceBasis: z.string(),
  })
  .passthrough();
const run = z
  .object({
    id,
    projectId: id,
    taskId: id,
    revision,
    status: z.enum([
      "reserved",
      "job_start_uncertain",
      "running",
      "completed",
      "failed",
      "cancelled",
      "lost",
    ]),
    externalJobId: z.string().nullable(),
    verification: z.enum(["pending", "passed", "failed"]),
    device: z.string(),
    identity: z.string(),
  })
  .passthrough();
const pagination = z
  .object({ offset: count, limit: revision, nextOffset: count.nullable() })
  .passthrough();
const dossier = z
  .object({
    projectId: id,
    taskId: id,
    taskRevision: revision,
    state,
    stateSource,
    stateProvenance: source,
    taskReviewStatus: review,
    stateToken: z.string(),
    summary: z.string().nullable(),
    nextAction: z.string().nullable(),
    currentEvidenceValidity: z.string().nullable(),
    needsAttention: z.boolean(),
    unresolvedExecutionCount: count,
    unresolvedExecutions: z
      .object({
        total: count,
        returned: count,
        items: z.array(object),
        nextOffset: count.nullable(),
      })
      .passthrough(),
    blockers: z
      .object({
        activeCount: count,
        items: z.array(object),
        nextOffset: count.nullable(),
      })
      .passthrough(),
    expectedProgressRecordId: id.nullable().optional(),
    progress: progress.nullable().optional(),
  })
  .passthrough();
const task = z
  .object({
    id,
    projectId: id,
    subject: z.string(),
    revision,
    reviewStatus: review,
    taskStatus: state.nullable(),
  })
  .passthrough();
const page = z
  .object({
    items: z.array(object),
    total: count,
    offset: count,
    limit: revision,
    nextOffset: count.nullable(),
  })
  .passthrough();
const capture = z
  .object({
    projectId: id,
    outcome: z
      .object({
        recordId: id,
        revision,
        reviewStatus: z.literal("proposed"),
        evidenceBasis: z.literal("agent_report"),
      })
      .passthrough(),
    workingMemoryVersion: count,
  })
  .passthrough();
const runResult = z.object({ run }).passthrough();
const finished = z
  .object({ completed: z.literal(true), resultRecordId: id })
  .passthrough();

/** Required operational fields are validated before writes commit and advertised to callers. */
export const workflowResults: Record<string, z.ZodType> = {
  open_task_panel: z
    .object({
      revision: count,
      view: z.enum(["task", "projects"]),
      startsExecution: z.literal(false),
      bootstrap: z
        .object({
          version: revision,
          preferences: object,
          observedAt: z.string(),
          reads: z.array(
            z.object({
              tool: z.string(),
              arguments: object,
              value: z.unknown(),
            }),
          ),
        })
        .passthrough(),
    })
    .passthrough(),
  create_task: capture.extend({
    taskId: id,
    task,
    startsExecution: z.literal(false),
  }),
  list_tasks: page.extend({
    selection: z.enum(["all_actions", "actual_tasks"]),
    items: z.array(
      task.extend({
        effectiveState: state,
        stateSource,
        operationalProgress: progress.nullable(),
      }),
    ),
  }),
  get_task: z
    .object({
      task,
      dossier,
      latestCheckpoint: object.nullable(),
      blockers: object,
      runs: z.array(run),
      records: z.array(
        z
          .object({
            id,
            revision,
            reviewStatus: review,
            evidenceBasis: z.string(),
          })
          .passthrough(),
      ),
      pagination,
    })
    .passthrough(),
  reserve_run: runResult.extend({ replay: z.boolean() }),
  begin_run: runResult.extend({ leaseToken: id }),
  attach_run_job: runResult,
  reconcile_uncertain_run: runResult.extend({
    evidenceRecordId: id,
    executionStarted: z.literal(false),
    acceptedTaskUnchanged: z.literal(true),
  }),
  observe_run: runResult,
  verify_run: runResult.extend({ taskUpdated: z.literal(false) }),
  get_project_dossier: z
    .object({
      selection: z.enum(["all_actions", "actual_tasks"]),
      project: z.object({ id, revision, lifecycle: z.string() }).passthrough(),
      tasks: z.array(
        z
          .object({
            taskId: id,
            state,
            stateSource,
            taskRevision: revision,
            needsAttention: z.boolean(),
          })
          .passthrough(),
      ),
      pagination,
    })
    .passthrough(),
  resume_task: z
    .object({
      dossier,
      startsExecution: z.literal(false),
      depth: z.enum(["compact", "balanced", "deep"]),
      resumeText: z.string().optional(),
      format: z.enum(["both", "structured"]).optional(),
      contextBudgetChars: count.optional(),
      truncated: z.boolean().optional(),
      omitted: z.array(z.union([z.string(), object])),
    })
    .passthrough(),
  create_task_handoff: z
    .object({
      recordId: id,
      reviewStatus: z.literal("proposed"),
      evidenceBasis: z.literal("agent_report"),
      snapshot: z
        .object({ projectId: id, taskId: id, dossier, resumeText: z.string() })
        .passthrough(),
      acceptedTaskUnchanged: z.literal(true),
      startsExecution: z.literal(false),
    })
    .passthrough(),
  report_task_progress: z
    .object({
      progress,
      recordId: id,
      acceptedTaskUnchanged: z.literal(true),
      workingMemoryVersion: count,
    })
    .passthrough(),
  get_portfolio: page,
  get_operational_timeline: page,
  get_changes_digest: page,
  get_project_links: page,
  link_project: capture,
  set_task_continuation: z
    .object({
      policy: z
        .object({
          recordId: id,
          mode: z.enum(["off", "verify_and_report", "continue_authorized"]),
          revision,
        })
        .passthrough(),
      requiresNativeSubscription: z.boolean(),
      subscriptionCreated: z.literal(false),
    })
    .passthrough(),
  claim_continuation: z.union([
    z.object({ claimed: z.literal(false), reason: z.string() }).passthrough(),
    z
      .object({
        claimed: z.literal(true),
        token: id,
        leaseUntil: z.string(),
        runId: id,
        runRevision: revision,
        externalJobId: z.string().nullable(),
        device: z.string(),
        identity: z.string(),
        criteria: z.array(z.string()),
      })
      .passthrough(),
  ]),
  finish_continuation: finished,
  reconcile_continuation: finished,
};
