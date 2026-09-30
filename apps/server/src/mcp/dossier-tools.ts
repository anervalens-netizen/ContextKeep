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
    "Start with the current project dossier: distinct recent tasks, reported progress, next steps, owner input and dependency identities. Keeps historical unscoped checkpoints separate; starts no execution.",
    z.strictObject({ projectId: uuid, ...page }),
    true,
    (i) => projectDossier(deps, i.projectId, i.offset, i.limit),
    result,
  );
  define(
    "resume_task",
    "Prepare compact task-specific resume context from current evidence. Does not execute anything or change selection in other sessions. Read stateToken and preserve taskId in all subsequent work.",
    z.strictObject(scope),
    true,
    (i) => resumeTask(deps, i.projectId, i.taskId),
    result,
  );
  define(
    "report_task_progress",
    "Record evidence-backed operational progress for an existing action/task, including proposed tasks, without changing accepted task progress. Compare expectedProgressRecordId and taskRevision to prevent lost updates between sessions.",
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
    "Read recent task summaries across projects with exact project pagination; retired projects are excluded by default. No health, progress or completeness is inferred from missing data.",
    z.strictObject({ ...page, includeRetired: z.boolean().default(false) }),
    true,
    (i) => portfolioOverview(deps, i.offset, i.limit, i.includeRetired),
    result,
  );
  define(
    "get_operational_timeline",
    "Read unified project/task activity: accepted knowledge, proposed reports, explicit progress and retained execution observations with provenance. Separate from canonical-only timeline. Paginated, no implicit acceptance.",
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
    "Read bounded changes since a UTC timestamp across active/non-retired projects or one project. Use for concise change-only summaries: completed results, blocked work and owner input. Follow nextOffset; never present a partial page as complete.",
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
    "Read identity-backed incoming and outgoing project/device dependencies across the portfolio. Resolves current project names by ID and keeps evidence/review status; does not infer links from text.",
    z.strictObject({ projectId: uuid, ...page }),
    true,
    (i) => projectLinks(deps, i.projectId, i.offset, i.limit),
    result,
  );
  define(
    "link_project",
    "Record an evidence-backed dependency from one project to exactly one other project ID or device ID. Proposed relation only, not automatic lifecycle/health acceptance.",
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
    "Configure off, verify-and-report, or continuation within an already-authorized objective. Compare expectedPolicyRecordId. This stores the policy only: a native host subscription must exist separately before starting the real job.",
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
    "Claim one terminal run revision before processing execution.finished. Stale events, duplicate claims, disabled policies and closed tasks do not run again. Expired claims require explicit reconciliation, never replay of the executor job.",
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
    "Complete a claimed continuation using same-task evidence and a separately verified result, or record that owner input is required. Does not close the task or accept knowledge.",
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
}
