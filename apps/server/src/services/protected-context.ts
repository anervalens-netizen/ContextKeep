import { recordRecovery, RECORD_READ_DEFAULTS } from "./evidence-read-defaults.js";
import { ApiError } from "../lib/errors.js";
import {
  dualContentResultBytes,
  MCP_RESULT_BYTE_BUDGET,
} from "../lib/result-budget.js";
import type { ServiceDeps } from "./import.js";
import { requireRecord } from "./memory-management.js";
import { taskDossier } from "./operational-dossier.js";
import { summarizeContextSection } from "./context-packing.js";

type Dossier = ReturnType<typeof taskDossier>;
export type ContextRedactor = <T>(value: T) => T;
const MAX_CONTEXT_CHARS = 60_000;

function fits(value: unknown, budget: number) {
  return (
    JSON.stringify(value).length <= budget &&
    dualContentResultBytes(value) <= MCP_RESULT_BYTE_BUDGET
  );
}

function requireCore(value: unknown, budget: number, actionRecordId: string) {
  // The recommended budget is part of the serialized core. Account for a
  // decimal-width change so the exact retry still fits.
  const charsWithoutBudget =
    JSON.stringify(value).length - String(budget).length;
  const firstEstimate = charsWithoutBudget + String(charsWithoutBudget).length;
  const requiredChars = charsWithoutBudget + String(firstEstimate).length;
  if (
    requiredChars > MAX_CONTEXT_CHARS ||
    dualContentResultBytes(value) > MCP_RESULT_BYTE_BUDGET
  ) {
    throw new ApiError(
      413,
      "protected_context_requires_detail_reads",
      `The protected core exceeds the response ceiling. Read get_record with recordId=${actionRecordId}, includeUnreviewed=true, evidenceOffset=${RECORD_READ_DEFAULTS.evidenceOffset}, and evidenceLimit=${RECORD_READ_DEFAULTS.evidenceLimit} for the action or checkpoint. Use get_task for state and list_blockers for blocker details.`,
    );
  }
  if (requiredChars > budget) {
    throw new ApiError(
      413,
      "protected_context_budget_too_small",
      `Set totalContextBudgetChars to at least ${requiredChars} for this current state.`,
    );
  }
}

function currentDossier(deps: ServiceDeps, d: Dossier) {
  const fullAction = (action: string | null, recordId?: string) => {
    if (action === null || !recordId) return action;
    const value = JSON.parse(requireRecord(deps, recordId).valueJson ?? "{}");
    return typeof value.nextAction === "string" ? value.nextAction : action;
  };
  const {
    items: runs,
    fingerprint: _fingerprint,
    ...unresolved
  } = d.unresolvedExecutions;
  const { items: blockers, ...blockerPage } = d.blockers;
  const executionPage = {
    ...unresolved,
    items: runs.map((run) => ({
      id: run.id,
      revision: run.revision,
      status: run.status,
      verification: run.verification,
      evidenceValidity: run.evidenceValidity.status,
      reconciliation: run.reconciliation?.disposition ?? null,
    })),
    omitted: unresolved.total - unresolved.returned,
    recovery: { ...unresolved.recovery, protectCurrent: true },
  };
  const blockerItems = blockers.map((blocker) => ({
    blockerId: blocker.blockerId,
    category: blocker.category,
    checkpointRecordId: blocker.checkpointRecordId,
    checkpointStatus: blocker.checkpointStatus,
    detailOmitted: true,
    recovery: recordRecovery(blocker.checkpointRecordId),
  }));
  return {
    projectId: d.projectId,
    taskId: d.taskId,
    taskRevision: d.taskRevision,
    title: d.title,
    taskReviewStatus: d.taskReviewStatus,
    state: d.state,
    stateSource: d.stateSource,
    stateProvenance: d.stateProvenance,
    stateToken: d.stateToken,
    expectedProgressRecordId: d.progress?.recordId ?? null,
    summary: null,
    summarySource: d.summarySource,
    summaryOmitted: d.summarySource !== null,
    summaryRecovery:
      d.summarySource && recordRecovery(d.summarySource.recordId),
    nextAction: fullAction(d.nextAction, d.nextActionSource?.recordId),
    nextActionSource: d.nextActionSource,
    ownerAction: d.ownerAction,
    followUp: d.followUp && {
      checkpointRecordId: d.followUp.checkpointRecordId,
      recordedAt: d.followUp.recordedAt,
      provenance: d.followUp.provenance,
      nextAction: fullAction(
        d.followUp.nextAction,
        d.followUp.checkpointRecordId,
      ),
      recovery: recordRecovery(d.followUp.checkpointRecordId),
    },
    checkpoint: d.checkpoint && {
      recordId: d.checkpoint.recordId,
      recordedAt: d.checkpoint.recordedAt,
      reviewStatus: d.checkpoint.reviewStatus,
      provenance: d.checkpoint.provenance,
      detailOmitted: true,
      recovery: recordRecovery(d.checkpoint.recordId),
    },
    currentEvidenceValidity: d.currentEvidenceValidity,
    needsAttention: d.needsAttention,
    attention: d.attention,
    lifecycleSuppressed: d.lifecycleSuppressed,
    lifecycleSuppressionReason: d.lifecycleSuppressionReason,
    unresolvedExecutionCount: d.unresolvedExecutionCount,
    unresolvedExecutions: executionPage,
    blockers: {
      ...blockerPage,
      items: blockerItems,
      returned: blockerItems.length,
      omitted: blockerPage.activeCount - blockerItems.length,
      recovery: {
        ...blockerPage.recovery,
        offset: blockerPage.nextOffset ?? 0,
      },
    },
    recovery: { tool: "get_task", projectId: d.projectId, taskId: d.taskId },
    actionRecovery:
      d.nextActionSource && recordRecovery(d.nextActionSource.recordId),
    semantics:
      "Read-only task state. Proposed reports retain their review status. Inspect uncertain executions before acting.",
  };
}

export function protectedTaskResume(
  deps: ServiceDeps,
  projectId: string,
  taskId: string,
  offset: number | undefined,
  limit: number | undefined,
  depth: string,
  budget: number,
  redact: ContextRedactor,
) {
  return deps.sqlite.transaction(() => {
    const d = taskDossier(deps, projectId, taskId, {
      offset,
      limit: limit ?? 5,
    });
    const core = currentDossier(deps, d);
    const result = redact({
      dossier: core,
      format: "structured",
      protectCurrent: true,
      depth,
      startsExecution: false,
      contextBudgetChars: budget,
      truncated: true,
      omitted: [
        "historicalDetails",
        ...(d.checkpoint
          ? [{ field: "checkpoint", ...recordRecovery(d.checkpoint.recordId) }]
          : []),
        ...(d.summarySource
          ? [{ field: "summary", ...recordRecovery(d.summarySource.recordId) }]
          : []),
      ],
    });
    requireCore(
      result,
      budget,
      d.nextActionSource?.recordId ?? d.checkpoint?.recordId ?? taskId,
    );
    return result;
  })();
}

export function protectedWorkContext(
  deps: ServiceDeps,
  projectId: string,
  taskId: string,
  payload: Record<string, unknown>,
  budget: number,
  redact: ContextRedactor,
) {
  const d = taskDossier(deps, projectId, taskId, { limit: 5 });
  const core = currentDossier(deps, d);
  const checkpoint = core.checkpoint;
  const project = payload.project as {
    id: string;
    name: string;
    revision: number;
    contentVersion: number;
    workingMemoryVersion: number;
  };
  const names = [
    "constraints",
    "currentState",
    "actions",
    "goals",
    "facts",
    "openQuestions",
    "workingMemory",
    "recentHandoffs",
  ];
  const sections = names.map((name) => {
    const source = summarizeContextSection(payload[name]);
    const items = source.items as unknown[];
    const section = summarizeContextSection({
      ...source,
      items: [],
      truncated: false,
      ...(Number(source.total) > 0
        ? { recovery: { tool: "get_work_context", projectId, taskId } }
        : {}),
    });
    return { name, items, section };
  });
  const result: Record<string, unknown> = redact({
    project: {
      id: project.id,
      name: project.name,
      revision: project.revision,
      contentVersion: project.contentVersion,
      workingMemoryVersion: project.workingMemoryVersion,
    },
    freshness: payload.freshness,
    taskId,
    resumeCapsule: { ...core, checkpoint: undefined },
    latestCheckpoint: checkpoint && {
      ...checkpoint,
      status: checkpoint.reviewStatus,
      checkpoint: null,
      checkpointOmitted: true,
    },
    protectCurrent: true,
    contextBudgetChars: budget,
    truncated: true,
    indicators: {
      stale: (payload.indicators as { stale: boolean }).stale,
      blocked: d.blockers.activeCount > 0,
      truncated: true,
      unknown: ["historical_details_omitted"],
    },
    recovery: { tool: "get_work_context", projectId, taskId },
    omitted: [
      "historicalDetails",
      ...(Number(summarizeContextSection(payload.recentWork).total) > 0
        ? ["recentWorkDetails"]
        : []),
      ...(payload.relations ? ["relations"] : []),
      ...(payload.diagnostics ? ["diagnostics"] : []),
    ],
    ...Object.fromEntries(sections.map(({ name, section }) => [name, section])),
  });
  requireCore(
    result,
    budget,
    d.nextActionSource?.recordId ?? d.checkpoint?.recordId ?? taskId,
  );
  // Fill after the continuity core, with accepted constraints and current
  // observations ahead of working summaries and history. Working prose is
  // recoverable by record ID from the existing non-duplicating index.
  const returnedIds = new Set<string>();
  for (const { name, items } of sections) {
    const section = result[name] as Record<string, unknown>;
    const accepted = section.items as unknown[];
    for (const item of items) {
      const id = (item as { recordId?: string }).recordId;
      if (id && returnedIds.has(id)) continue;
      accepted.push(redact(item));
      result[name] = summarizeContextSection({ ...section, truncated: false });
      if (!fits(result, budget)) {
        accepted.pop();
        result[name] = summarizeContextSection({
          ...section,
          truncated: false,
        });
        break;
      }
      if (id) returnedIds.add(id);
    }
  }
  return result;
}
