import type { ActorCtx, ServiceDeps } from "./import.js";
import { captureWork } from "./capture-work.js";
import { requireRecord } from "./memory-management.js";
import { toRecordDto } from "./mappers.js";

export function createTask(
  deps: ServiceDeps,
  input: {
    projectId: string;
    title: string;
    objective: string;
    status: "open" | "in_progress" | "blocked";
    evidenceText: string | null;
    clientId: string;
    sessionId: string;
    idempotencyKey: string;
  },
  ctx: ActorCtx,
) {
  return deps.sqlite.transaction(() => {
    // The MCP atomic write receipt binds the complete payload to this key.
    // Distinct explicit intents never coalesce through generic text dedup.
    const capture = captureWork(
      deps,
      {
        projectId: input.projectId,
        subject: input.title,
        title: input.title,
        outcome: input.objective,
        evidenceText: input.evidenceText,
        eventAt: null,
        recordType: "action",
        initialTaskStatus: input.status,
        dedupIdentity: `explicit_task:${input.clientId}:${input.idempotencyKey}`,
        progressUpdates: [],
      },
      ctx,
    );
    const task = toRecordDto(requireRecord(deps, capture.outcome.recordId));
    return { ...capture, taskId: task.id, task, startsExecution: false };
  })();
}
