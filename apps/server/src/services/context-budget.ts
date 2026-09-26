import type { ContextDiagnosticReason } from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import {
  compactContextRecord,
  compactLatestCheckpoint,
  summarizeContextSection,
} from "./context-packing.js";
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
export type WorkContextSectionDiagnostic = {
  eligibleTotal: number;
  selectedBeforeBudget: number;
  returnedAfterBudget: number;
  omittedAfterBudget: number;
  omissionReason: ContextDiagnosticReason | null;
};

export type WorkContextDiagnostics = {
  mode: "deterministic_lexical_fts";
  reasons: ContextDiagnosticReason[];
  taskSelection: {
    matchReason: "deterministic_lexical_fts" | null;
    canonicalRecordIds: string[];
    workingRecordIds: string[];
    staleRecordIds: string[];
    freshnessReason: "stale" | null;
  };
  sections: Record<string, WorkContextSectionDiagnostic>;
};

export function fitWorkContext(
  payload: Record<string, unknown>,
  budget: number | undefined,
): Record<string, unknown> {
  const size = (value: unknown) => JSON.stringify(value).length;
  const candidate: Record<string, unknown> = JSON.parse(
    JSON.stringify({
      ...payload,
      ...(budget === undefined ? {} : { contextBudgetChars: budget }),
      truncated: false,
    }),
  ) as Record<string, unknown>;

  // CK-A02: semantic selection must not depend on whether diagnostics were
  // requested. Remove diagnostics while fitting content and reserve a small,
  // fixed envelope for them in both modes.
  const diagnostics =
    candidate.diagnostics &&
    typeof candidate.diagnostics === "object" &&
    !Array.isArray(candidate.diagnostics)
      ? (candidate.diagnostics as unknown as WorkContextDiagnostics)
      : undefined;
  delete candidate.diagnostics;
  // Reserve a fixed envelope so diagnostics cannot influence semantic
  // selection at the same budget.
  const DIAGNOSTICS_RESERVE_CHARS = 512;
  const semanticBudget =
    budget === undefined
      ? undefined
      : Math.max(0, budget - DIAGNOSTICS_RESERVE_CHARS);
  const preserveCompactClaims = budget === undefined || budget >= 6000;

  const sectionNames = [
    "goals",
    "actions",
    "constraints",
    "openQuestions",
    "facts",
    "currentState",
    "recentWork",
    "workingMemory",
    "recentHandoffs",
  ];

  const sectionSummary = summarizeContextSection;

  for (const name of sectionNames) {
    if (candidate[name] !== undefined)
      candidate[name] = sectionSummary(candidate[name]);
  }

  const syncDiagnostics = (target: Record<string, unknown>): void => {
    if (!diagnostics) return;
    let budgetOmitted = false;
    for (const name of sectionNames) {
      const diagnostic = diagnostics.sections?.[name];
      if (!diagnostic) continue;
      const section = target[name] as Record<string, unknown> | undefined;
      const returned =
        section && Array.isArray(section.items) ? section.items.length : 0;
      diagnostic.returnedAfterBudget = returned;
      diagnostic.omittedAfterBudget = Math.max(
        0,
        diagnostic.eligibleTotal - returned,
      );
      if (returned < diagnostic.selectedBeforeBudget) {
        diagnostic.omissionReason = "budget_omission";
        budgetOmitted = true;
      }
    }
    diagnostics.reasons = diagnostics.reasons.filter(
      (reason) => reason !== "budget_omission",
    );
    if (budgetOmitted) diagnostics.reasons.push("budget_omission");
  };

  const compactDiagnostics = () =>
    diagnostics
      ? {
          mode: diagnostics.mode,
          reasons: diagnostics.reasons,
          taskSelection: diagnostics.taskSelection,
          sections: Object.fromEntries(
            Object.entries(diagnostics.sections).filter(
              ([, value]) =>
                value.selectedBeforeBudget > 0 ||
                value.omissionReason === "budget_omission",
            ),
          ),
        }
      : undefined;

  const minimalDiagnostics = () =>
    diagnostics
      ? {
          mode: diagnostics.mode,
          reasons: diagnostics.reasons,
          taskSelection: {
            matchReason: diagnostics.taskSelection.matchReason,
            canonicalRecordIds:
              diagnostics.taskSelection.canonicalRecordIds.slice(0, 2),
            workingRecordIds: diagnostics.taskSelection.workingRecordIds.slice(
              0,
              2,
            ),
            staleRecordIds: diagnostics.taskSelection.staleRecordIds.slice(
              0,
              2,
            ),
            freshnessReason: diagnostics.taskSelection.freshnessReason,
          },
          omittedForBudget: true,
        }
      : undefined;

  const finalize = (
    target: Record<string, unknown>,
  ): Record<string, unknown> => {
    if (target.constraints)
      target.constraints = sectionSummary(target.constraints);
    syncDiagnostics(target);
    if (!diagnostics) return target;
    const variants = [
      diagnostics,
      compactDiagnostics(),
      minimalDiagnostics(),
    ].filter(Boolean);
    for (const variant of variants) {
      const withDiagnostics = { ...target, diagnostics: variant };
      if (budget === undefined || size(withDiagnostics) <= budget)
        return withDiagnostics;
    }
    throw new ApiError(
      413,
      "context_budget_unrepresentable",
      "Context budget cannot represent the selected context plus the requested diagnostics envelope.",
    );
  };

  syncDiagnostics(candidate);
  if (budget === undefined) return finalize(candidate);
  if (semanticBudget !== undefined && size(candidate) <= semanticBudget)
    return finalize(candidate);

  const markTruncated = () => {
    candidate.truncated = true;
    const current = candidate.indicators;
    const indicators =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    const unknown = Array.isArray(indicators.unknown)
      ? indicators.unknown.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (!unknown.includes("context_budget_omitted_optional_content")) {
      unknown.push("context_budget_omitted_optional_content");
    }
    candidate.indicators = { ...indicators, truncated: true, unknown };
  };
  markTruncated();

  const fits = (): boolean => {
    syncDiagnostics(candidate);
    return semanticBudget !== undefined && size(candidate) <= semanticBudget;
  };

  const addRecovery = (
    name: string,
    section: Record<string, unknown>,
    removed: unknown,
  ): void => {
    const removedObject =
      removed && typeof removed === "object" && !Array.isArray(removed)
        ? (removed as Record<string, unknown>)
        : undefined;
    const recordId =
      typeof removedObject?.recordId === "string"
        ? removedObject.recordId
        : null;
    if (recordId) {
      const existing = Array.isArray(section.budgetOmittedRecordIds)
        ? section.budgetOmittedRecordIds.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      if (!existing.includes(recordId) && existing.length < 3)
        existing.push(recordId);
      section.budgetOmittedRecordIds = existing;
    }
    if (
      [
        "goals",
        "actions",
        "constraints",
        "openQuestions",
        "facts",
        "currentState",
      ].includes(name)
    ) {
      section.recovery = { tool: "search_context", scope: "canonical" };
    } else if (["recentWork", "workingMemory"].includes(name)) {
      section.recovery = { tool: "search_context", scope: "working" };
    }
  };

  const trimSection = (name: string, minimumItems = 0): boolean => {
    const section = candidate[name] as Record<string, unknown> | undefined;
    if (!section || !Array.isArray(section.items)) return fits();
    const items = section.items as unknown[];
    while (items.length > minimumItems && !fits()) {
      const removed = items.pop();
      addRecovery(name, section, removed);
      const total =
        typeof section.total === "number" ? section.total : items.length;
      section.returned = items.length;
      section.omitted = Math.max(0, total - items.length);
      section.truncated = true;
    }
    return fits();
  };

  // Drop non-authoritative prose before dropping records. Task selection has
  // already happened, so a very long input task cannot evict canonical truth.
  for (const key of [
    "objective",
    "goalSemantics",
    "recentWorkSemantics",
    "generatedAt",
    "limits",
  ]) {
    if (candidate[key] === undefined) continue;
    delete candidate[key];
    if (key === "task") candidate.taskOmittedForBudget = true;
    if (fits()) return finalize(candidate);
  }
  if (typeof candidate.task === "string" && candidate.task.length > 512) {
    delete candidate.task;
    candidate.taskOmittedForBudget = true;
    if (fits()) return finalize(candidate);
  }

  // Lowest priority: history and the verbose proposal view. workingMemory
  // is only a compact resume index over those same records, so preserve it
  // longer than recentWork instead of paying twice for the same proposal.
  for (const name of ["recentHandoffs", "recentWork"]) {
    if (trimSection(name)) return finalize(candidate);
  }

  // Relations can be re-read through search_relations; keep the canonical
  // resume core before this derived task view when the budget is tight.
  if (candidate.relations !== undefined) {
    delete candidate.relations;
    if (fits()) return finalize(candidate);
  }

  // Questions/state/facts are useful canonical context but rank below explicit
  // operational guardrails and accepted task-relevant decisions. Compact
  // verbose detail before removing whole records.
  const compactContextSection = (name: string): boolean => {
    const section = candidate[name] as Record<string, unknown> | undefined;
    if (!section || !Array.isArray(section.items)) return fits();
    section.items = section.items.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      return compactContextRecord(raw, 0);
    });
    return fits();
  };
  for (const name of ["openQuestions", "currentState", "facts"]) {
    if (compactContextSection(name)) return finalize(candidate);
  }
  if (trimSection("openQuestions")) return finalize(candidate);
  if (trimSection("currentState", preserveCompactClaims ? 1 : 0))
    return finalize(candidate);
  if (trimSection("facts", preserveCompactClaims ? 1 : 0))
    return finalize(candidate);

  // Compact canonical detail before removing the last useful working pointers.
  // The working index is unreviewed continuity, not canonical authority, but
  // its record IDs/provenance are often the only pointer to the next action.
  const compactCanonicalSection = (name: string): boolean => {
    const section = candidate[name] as Record<string, unknown> | undefined;
    if (!section || !Array.isArray(section.items)) return fits();
    section.items = section.items.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      return compactContextRecord(raw, 360);
    });
    return fits();
  };
  for (const name of ["actions", "goals", "constraints"]) {
    if (compactCanonicalSection(name)) return finalize(candidate);
  }

  // If canonical detail alone cannot fit, trim the compact working index only
  // after the canonical claims have had their deterministic detail reduction.
  if (trimSection("workingMemory")) return finalize(candidate);

  // Before omitting any authoritative resume-core record, switch to a
  // smaller structural projection. This avoids spending a tight budget on
  // duplicate/optional envelope fields while dropping the constraint itself.
  syncDiagnostics(candidate);
  const project = candidate.project as Record<string, unknown> | undefined;
  const freshness = candidate.freshness;
  const latest = candidate.latestCheckpoint as
    Record<string, unknown> | null | undefined;
  const compactLatest = compactLatestCheckpoint(latest);
  const requiredSection = (name: string) => {
    const section = sectionSummary(candidate[name]);
    if (name === "currentState")
      section.semantics =
        "Selected facts only; zero selected is not zero existing.";
    else delete section.semantics;
    return section;
  };
  const compact: Record<string, unknown> = {
    project: project
      ? {
          id: project.id,
          name:
            typeof project.name === "string"
              ? clip(project.name, 160)
              : project.name,
          ...(typeof project.name === "string" && project.name.length > 160
            ? { nameTruncated: true }
            : {}),
          lifecycle: project.lifecycle,
          revision: project.revision,
          contentVersion: project.contentVersion,
          workingMemoryVersion: project.workingMemoryVersion,
        }
      : null,
    freshness,
    goals: requiredSection("goals"),
    actions: requiredSection("actions"),
    constraints: requiredSection("constraints"),
    facts: requiredSection("facts"),
    currentState: requiredSection("currentState"),
    workingMemory: requiredSection("workingMemory"),
    latestCheckpoint: compactLatest,
    latestNextAction:
      typeof candidate.latestNextAction === "string"
        ? clip(candidate.latestNextAction, 360)
        : (candidate.latestNextAction ?? null),
    latestBlockers: Array.isArray(candidate.latestBlockers)
      ? candidate.latestBlockers
          .filter((item): item is string => typeof item === "string")
          .slice(0, 2)
          .map((item) => clip(item, 240))
      : [],
    indicators: candidate.indicators,
    truncated: true,
    contextBudgetChars: budget,
  };
  if (size(compact) <= semanticBudget!) return finalize(compact);

  const trimCompactSection = (name: string, minimumItems = 0): boolean => {
    const section = compact[name] as Record<string, unknown> | undefined;
    if (!section || !Array.isArray(section.items))
      return size(compact) <= semanticBudget!;
    const items = section.items as unknown[];
    while (items.length > minimumItems && size(compact) > semanticBudget!) {
      const removed = items.pop();
      addRecovery(name, section, removed);
      const total =
        typeof section.total === "number" ? section.total : items.length;
      section.returned = items.length;
      section.omitted = Math.max(0, total - items.length);
      section.truncated = true;
    }
    return size(compact) <= semanticBudget!;
  };

  // Preserve the latest checkpoint pointer and next action by trimming the
  // duplicated working index and background facts first. Their recovery
  // metadata makes the omission explicit without losing canonical authority.
  if (trimCompactSection("currentState")) return finalize(compact);
  if (trimCompactSection("workingMemory")) return finalize(compact);
  if (trimCompactSection("facts", preserveCompactClaims ? 1 : 0))
    return finalize(compact);

  // Constraints/decisions outrank the resume pointer itself. If the compact
  // envelope is still too large, retain an explicit omission marker and only
  // then consider removing canonical records.
  compact.latestCheckpoint = null;
  compact.latestNextAction = null;
  compact.latestBlockers = [];
  compact.resumePointersOmittedForBudget = true;
  if (size(compact) <= semanticBudget!) return finalize(compact);

  for (const name of ["actions", "goals", "constraints"]) {
    if (trimCompactSection(name)) return finalize(compact);
  }

  // Last-resort structural response: keep authority/cursors and explicit
  // section totals/omissions. Never present an omitted canonical section as
  // "no data" merely because its items cannot fit.
  const minimalSection = (name: string) => {
    const section = sectionSummary(compact[name]);
    if (
      name === "workingMemory" &&
      Array.isArray(section.budgetOmittedRecordIds)
    ) {
      section.budgetOmittedRecordIds = section.budgetOmittedRecordIds.slice(
        0,
        1,
      );
    }
    if (name === "currentState") {
      section.semantics = "Subset; not a census.";
      delete section.recovery;
      delete section.budgetOmittedRecordIds;
    }
    return section;
  };
  const minimal: Record<string, unknown> = {
    project: compact.project,
    freshness,
    // Read from the already-trimmed compact sections so omission/recovery
    // metadata survives the last-resort projection. Re-reading candidate
    // here can observe the shared items array after trimming but lose the
    // metadata that explains why it is empty.
    goals: minimalSection("goals"),
    actions: minimalSection("actions"),
    constraints: minimalSection("constraints"),
    currentState: minimalSection("currentState"),
    ...(Array.isArray(
      (compact.facts as Record<string, unknown> | undefined)?.items,
    ) &&
    ((compact.facts as Record<string, unknown>).items as unknown[]).length > 0
      ? { facts: minimalSection("facts") }
      : {}),
    workingMemory: {
      ...minimalSection("workingMemory"),
      cursor:
        (candidate.workingMemory as Record<string, unknown> | undefined)
          ?.cursor ?? 0,
    },
    latestCheckpoint: null,
    indicators: {
      ...((candidate.indicators as Record<string, unknown> | undefined) ?? {}),
      truncated: true,
      unknown: [
        ...(((candidate.indicators as Record<string, unknown> | undefined)
          ?.unknown as string[] | undefined) ?? []),
        "latest_checkpoint_omitted_for_budget",
      ],
    },
    truncated: true,
    contextBudgetChars: budget,
  };
  if (size(minimal) > semanticBudget!) {
    throw new ApiError(
      413,
      "context_budget_unrepresentable",
      "Context budget is too small for the structural response contract.",
    );
  }
  return finalize(minimal);
}
