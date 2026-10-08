import { createTaskHandoff } from "../services/task-handoff.js";
import { z } from "zod";
import type { ActorCtx, ServiceDeps } from "../services/import.js";
import {
  projectDossier,
  resumeTask,
  reportTaskProgress,
  portfolioOverview,
  operationalTimeline,
  projectLinks,
  linkProject,
} from "../services/operational-dossier.js";
import {
  setContinuationPolicy,
  claimContinuation,
  finishContinuation,
  reconcileContinuation,
} from "../services/continuation.js";

type Define = <S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  readOnly: boolean,
  run: (input: z.output<S>) => unknown | Promise<unknown>,
  contract: z.ZodType,
) => void;
const uuid = z.string().uuid();
const scope = { projectId: uuid, taskId: uuid };
const page = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50).default(20),
};
const write = {
  idempotencyKey: uuid,
  clientId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(160),
};
const result = z.object({}).passthrough();
type Identity = { idempotencyKey: string; clientId: string; sessionId: string };
export function registerDossierTools(
  define: Define,
  deps: ServiceDeps,
  actorFor: (input: Identity) => ActorCtx,
) {
  define(
    "get_project_dossier",
    "Current tasks, outcomes, next steps and owner input; not old history.",
    z.strictObject({
      projectId: uuid,
      ...page,
      view: z.enum(["recent","attention","active"]).optional(),
      q: z.string().trim().min(1).max(200).optional(),
      attentionOffset: z.number().int().min(0).optional(),
      attentionLimit: z.number().int().min(1).max(50).default(10),
      selection: z.enum(["all_actions", "actual_tasks"]).default("all_actions"),
    }),
    true,
    (i) =>
      projectDossier(
        deps,
        i.projectId,
        i.offset,
        i.limit,
        i.attentionOffset ?? null,
        i.attentionLimit,
        i.selection,
        i.view,
        i.q,
      ),
    result,
  );
  define(
    "resume_task",
    "Read-only, task-scoped resume context. Never starts a job.",
    z.strictObject({
      ...scope,
      unresolvedOffset: z.number().int().min(0).optional(),
      unresolvedLimit: z.number().int().min(1).max(50).optional(),
    }),
    true,
    (i) =>
      resumeTask(
        deps,
        i.projectId,
        i.taskId,
        i.unresolvedOffset,
        i.unresolvedLimit,
      ),
    result,
  );
  define(
    "create_task_handoff",
    "Persist a task-scoped operational working export from its dossier. Separates accepted/proposed task identity, reported progress, blockers and execution verification. Never accepts material or starts a job; create_handoff remains canonical only.",
    z.strictObject({ ...scope, ...write }),
    false,
    (i) => createTaskHandoff(deps, i, actorFor(i)),
    result,
  );
  define(
    "report_task_progress",
    "Evidence-backed progress with revision fences; accepted task unchanged.",
    z.strictObject({
      ...scope,
      ...write,
      taskRevision: z.number().int().min(1),
      expectedProgressRecordId: uuid.nullable(),
      status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
      summary: z.string().trim().min(1).max(2000),
      nextAction: z.string().trim().min(1).max(2000).nullable(),
      ownerAction: z.string().trim().min(1).max(2000).nullable(),
      evidenceText: z.string().trim().min(1).max(64000),
    }),
    false,
    (i) => reportTaskProgress(deps, i, actorFor(i)),
    result,
  );
  define(
    "get_portfolio",
    "Paginated recent tasks across projects; retired excluded by default.",
    z.strictObject({ ...page, includeRetired: z.boolean().default(false), selection: z.enum(["all_actions", "actual_tasks"]).default("all_actions") }),
    true,
    (i) => portfolioOverview(deps, i.offset, i.limit, i.includeRetired, i.selection),
    result,
  );
  define(
    "get_operational_timeline",
    "Task/project activity with provenance; never auto-accepts reports.",
    z.strictObject({
      projectId: uuid,
      taskId: uuid.optional(),
      ...page,
      scope: z
        .enum(["all", "canonical", "working", "executions"])
        .default("all"),
    }),
    true,
    (i) => operationalTimeline(deps, { ...i, includeRetired: true }),
    result,
  );
  define(
    "get_changes_digest",
    "Dated changes, with pagination. Missing data is not success.",
    z.strictObject({
      projectId: uuid.optional(),
      since: z.string().datetime(),
      until: z.string().datetime().optional(),
      ...page,
      includeRetired: z.boolean().default(false),
    }),
    true,
    (i) => operationalTimeline(deps, i),
    result,
  );
  define(
    "get_project_links",
    "Identity-backed incoming/outgoing dependencies with provenance.",
    z.strictObject({ projectId: uuid, ...page }),
    true,
    (i) => projectLinks(deps, i.projectId, i.offset, i.limit),
    result,
  );
  define(
    "link_project",
    "Propose a link to exactly one project ID or device ID, with evidence.",
    z.strictObject({
      projectId: uuid,
      targetProjectId: uuid.nullable(),
      deviceId: z.string().trim().min(1).max(100).nullable(),
      relation: z.enum(["depends_on", "blocks", "affects", "runs_on"]),
      evidenceText: z.string().trim().min(1).max(64000),
      ...write,
    }),
    false,
    (i) => linkProject(deps, i, actorFor(i)),
    result,
  );
  define(
    "set_task_continuation",
    "Set a bounded continuation policy; does not create a host subscription.",
    z.strictObject({
      ...scope,
      ...write,
      expectedPolicyRecordId: uuid.nullable(),
      mode: z.enum(["off", "verify_and_report", "continue_authorized"]),
      objective: z.string().trim().min(1).max(2000),
      evidenceText: z.string().trim().min(1).max(64000),
    }),
    false,
    (i) => setContinuationPolicy(deps, i, actorFor(i)),
    result,
  );
  define(
    "claim_continuation",
    "Claim one terminal run revision. Never replay duplicate or stale jobs.",
    z.strictObject({
      ...scope,
      ...write,
      runId: uuid,
      runRevision: z.number().int().min(1),
      consumerId: z.string().min(1).max(160),
    }),
    false,
    (i) => claimContinuation(deps, i),
    result,
  );
  define(
    "finish_continuation",
    "Finish from verified same-task evidence; does not close the task.",
    z.strictObject({
      ...scope,
      ...write,
      runId: uuid,
      runRevision: z.number().int().min(1),
      token: uuid,
      resultRecordId: uuid,
      result: z.enum(["reported", "needs_owner"]),
    }),
    false,
    (i) => finishContinuation(deps, i),
    result,
  );
  define(
    "reconcile_continuation",
    "Resolve an expired claim with fresh evidence and a fence; no job replay.",
    z.strictObject({
      ...scope,
      ...write,
      runId: uuid,
      runRevision: z.number().int().min(1),
      expectedClaimUpdatedAt: z.string().datetime(),
      resultRecordId: uuid,
      result: z.enum(["reported", "needs_owner"]),
    }),
    false,
    (i) => reconcileContinuation(deps, i),
    result,
  );
}
