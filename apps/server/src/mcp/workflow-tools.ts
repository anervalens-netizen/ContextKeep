import { createTask } from "../services/create-task.js";
import type { ActorCtx } from "../services/import.js";
import { z } from "zod";
import type { ServiceDeps } from "../services/import.js";
import {
  reconcileUncertainRun,
  reserveRun,
  beginRun,
  attachJob,
  observeRun,
  verifyRun,
  getTaskView,
  listTasks,
} from "../services/workflow.js";
const scope = { projectId: z.string().uuid(), taskId: z.string().uuid() };
const run = { ...scope, runId: z.string().uuid() };
const write = {
  idempotencyKey: z.string().uuid(),
  clientId: z.string().min(1).max(80),
  sessionId: z.string().min(1).max(160),
};
type Define = <S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  readOnly: boolean,
  run: (input: z.output<S>) => unknown | Promise<unknown>,
  contract: z.ZodType,
) => void;
const result = z.object({}).passthrough();
export function registerWorkflowTools(define: Define, deps: ServiceDeps, actorFor: (input: {clientId: string; sessionId: string; idempotencyKey: string}) => ActorCtx) {
  define("create_task", "Create an evidence-linked proposed task, never execution. Reuse the key only for retries; distinct keys preserve equal-title tasks.",
    z.strictObject({projectId: scope.projectId, ...write, title: z.string().trim().min(1).max(400), objective: z.string().trim().min(1).max(8000), status: z.enum(["open", "in_progress", "blocked"]).default("open"), evidenceText: z.string().trim().min(1).max(64000).nullable().default(null)}), false, i => createTask(deps, i, actorFor(i)), result);
  define(
    "list_tasks",
    "List all_actions (legacy) or actual_tasks. Optional q matches literal title text for reuse candidates. Filtered totals and provenance retained.",
    z.strictObject({
      projectId: scope.projectId,
      selection: z.enum(["all_actions", "actual_tasks"]).default("all_actions"),
      q: z.string().trim().min(1).max(200).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(50),
    }),
    true,
    (i) => listTasks(deps, i.projectId, i.offset, i.limit, i.selection, i.q),
    result,
  );
  define(
    "get_task",
    "Read one task, its own checkpoint, blockers, runs and evidence. Selecting a task starts no execution.",
    z.strictObject({
      ...scope,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    true,
    (i) => getTaskView(deps, i),
    result,
  );
  define(
    "reserve_run",
    "Persist correlation and verification criteria before starting an executor job. Reuse operationKey and the SHA-256 inputHash on retry.",
    z.strictObject({
      ...scope,
      ...write,
      operationKey: z.string().min(1).max(200),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      device: z.string().min(1).max(100),
      identity: z.enum(["owner", "root", "interactive"]),
      criteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
    }),
    false,
    (i) => reserveRun(deps, i),
    result,
  );
  define(
    "begin_run",
    "Reserve one start attempt with a revision fence. A crash leaves job_start_uncertain: inspect by operation key, never automatically restart.",
    z.strictObject({ ...run, ...write, revision: z.number().int().min(1) }),
    false,
    (i) => beginRun(deps, i),
    result,
  );
  define(
    "attach_run_job",
    "Correlate the executor receipt with its pre-existing start reservation.",
    z.strictObject({
      ...run,
      ...write,
      inputHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      leaseToken: z.string().uuid(),
      externalJobId: z.string().min(1).max(200),
    }),
    false,
    (i) => attachJob(deps, i),
    result,
  );
  define(
    "reconcile_uncertain_run",
    "Reconcile job_start_uncertain without replay. Requires exact reserved identity and inspected evidence. Attach an exact existing externalJobId, or explicitly conclude not_started/lost with evidence. Missing bounded history never proves non-start. No executor is invoked and verification remains separate.",
    z.strictObject({
      ...run, ...write, revision: z.number().int().min(1),
      operationKey: z.string().min(1).max(200), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      device: z.string().min(1).max(100), identity: z.enum(["owner", "root", "interactive"]),
      disposition: z.enum(["attached", "not_started", "lost"]),
      externalJobId: z.string().trim().min(1).max(200).nullable(),
      evidenceText: z.string().trim().min(1).max(64000),
      evidenceSource: z.string().trim().min(1).max(1000), observedAt: z.string().datetime(),
    }), false,
    i => reconcileUncertainRun(deps, i, { actor: `owner:mcp:${i.clientId}:${i.sessionId}`, requestId: i.idempotencyKey }), result,
  );
  define(
    "observe_run",
    "Record a terminal executor observation, not verification or task completion. Event identity is stable and contains no commands or raw logs.",
    z.strictObject({
      ...run,
      ...write,
      eventKey: z.string().min(1).max(200),
      externalJobId: z.string().min(1).max(200),
      device: z.string().min(1).max(100),
      identity: z.enum(["owner", "root", "interactive"]),
      status: z.enum(["completed", "failed", "cancelled", "lost"]),
      exitCode: z.number().int().nullable(),
      observedAt: z.string().datetime(),
    }),
    false,
    (i) => observeRun(deps, i),
    result,
  );
  define(
    "verify_run",
    "Verify the inspected terminal run using a same-task report bound by runEvidence to its exact revision and executor receipt. Current proof validity is separate. Never closes tasks or accepts knowledge.",
    z.strictObject({
      ...run,
      ...write,
      revision: z.number().int().min(1),
      recordId: z.string().uuid(),
      verdict: z.enum(["passed", "failed"]),
    }),
    false,
    (i) => verifyRun(deps, i),
    result,
  );
}
