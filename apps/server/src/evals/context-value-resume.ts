import { projectResumeContext, renderResumeText } from "@contextkeep/shared";
import type { ResumeRecord } from "@contextkeep/shared";

type ResumeInput = Parameters<typeof projectResumeContext>[0];
type Fixture = {
  id: string;
  language: "ro" | "en";
  context: ResumeInput;
  required: string[];
  current: string | null;
  recoverableRecords: string[][];
};

export type ResumeQualityReport = {
  fixture: "frozen_context_value_resume_v3";
  scope: "presentation_fidelity_not_retrieval_benchmark";
  baselineSha: string;
  providerCalls: 0;
  baseline: {
    name: "copy-context-c3551f5";
    essentialsRetained: number;
    currentness: number;
    estimatedAdditionalReads: number;
  };
  current: {
    name: "shared-resume-projection";
    essentialsRetained: number;
    currentness: number;
    estimatedAdditionalReads: number;
  };
  cases: Array<{
    id: string;
    language: "ro" | "en";
    baselineRetained: number;
    currentRetained: number;
    baselineCurrentness: boolean | null;
    currentCurrentness: boolean | null;
    baselineEstimatedAdditionalReads: number;
    estimatedAdditionalReads: number;
    omissionRecoveryVisible: boolean;
    baselineOmissionRecoveryVisible: boolean;
    budgetChecks: Array<{
      budget: number;
      baselineChars: number;
      currentChars: number;
      bothFit: boolean;
    }>;
  }>;
};

const CASES: readonly Fixture[] = [
  {
    id: "resume-selected-subset-and-permanent-core",
    language: "en",
    context: {
      project: { id: "subset-core", name: "Stable project identity" },
      constraints: {
        items: [
          {
            recordId: "core-constraint",
            text: "Preserve owner-reviewed constraints.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
      currentState: {
        scope: "selected_facts_subset",
        selectedCount: 0,
        upstreamOmitted: 7,
        items: [],
      },
    },
    required: [
      "Preserve owner-reviewed constraints.",
      "zero selected does not mean zero existing",
    ],
    current: null,
    recoverableRecords: [["Preserve owner-reviewed constraints."]],
  },
  {
    id: "resume-en-current-history",
    language: "en",
    context: {
      project: { id: "resume-en", name: "Resume English" },
      goals: {
        items: [
          {
            recordId: "decision-en",
            revision: 2,
            text: "Deploy only after exact-head CI.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
      constraints: {
        items: [
          {
            recordId: "constraint-en",
            revision: 1,
            text: "Keep the store SQLite-only.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
      facts: {
        items: [
          {
            recordId: "current-en",
            revision: 3,
            text: "Current release is abc123.",
            status: "accepted",
            provenance: "observed_technical",
          },
        ],
      },
      currentState: {
        items: [
          {
            recordId: "current-en",
            revision: 3,
            text: "Current release is abc123.",
            status: "accepted",
            provenance: "observed_technical",
          },
        ],
      },
      actions: {
        items: [
          {
            recordId: "action-en",
            revision: 1,
            text: "Record the final verification.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
    },
    required: [
      "Deploy only after exact-head CI.",
      "Keep the store SQLite-only.",
      "Current release is abc123.",
      "Record the final verification.",
    ],
    current: "Current release is abc123.",
    recoverableRecords: [
      ["Deploy only after exact-head CI."],
      ["Keep the store SQLite-only."],
      ["Current release is abc123."],
      ["Record the final verification."],
    ],
  },
  {
    id: "resume-ro-checkpoint",
    language: "ro",
    context: {
      project: { id: "resume-ro", name: "Reluare română" },
      constraints: {
        items: [
          {
            recordId: "constraint-ro",
            revision: 4,
            text: "Nu modifica datele de producție.",
            status: "accepted",
            provenance: "owner_declaration",
          },
        ],
      },
      currentState: {
        items: [
          {
            recordId: "state-ro",
            revision: 2,
            text: "Release-ul curent este verificat.",
            status: "accepted",
            provenance: "observed_technical",
          },
        ],
      },
      latestCheckpoint: {
        recordId: "checkpoint-ro",
        revision: 5,
        recordedAt: "2026-09-24T10:00:00Z",
        status: "proposed",
        provenance: "agent_report",
        checkpoint: {
          summary: "Lotul local este verificat.",
          nextAction: "Rulează testele focalizate.",
          blockers: ["Revizia proprietarului rămâne necesară."],
          artifactRefCount: 1,
        },
      },
      latestNextAction: "Rulează testele focalizate.",
      latestBlockers: ["Revizia proprietarului rămâne necesară."],
    },
    required: [
      "Nu modifica datele de producție.",
      "Release-ul curent este verificat.",
      "Rulează testele focalizate.",
      "Revizia proprietarului rămâne necesară.",
    ],
    current: "Release-ul curent este verificat.",
    recoverableRecords: [
      ["Nu modifica datele de producție."],
      ["Release-ul curent este verificat."],
      [
        "Rulează testele focalizate.",
        "Revizia proprietarului rămâne necesară.",
      ],
    ],
  },
  {
    id: "resume-omitted-pointer",
    language: "en",
    context: {
      project: { id: "resume-omitted", name: "Omitted pointer" },
      latestCheckpoint: {
        recordId: "checkpoint-omitted",
        revision: 6,
        recordedAt: "2026-09-24T10:00:00Z",
        status: "proposed",
        provenance: "agent_report",
        checkpoint: null,
        checkpointOmitted: true,
        recovery: { tool: "get_record", includeUnreviewed: true },
      },
      indicators: { truncated: true },
    },
    required: ["checkpoint-omitted"],
    current: null,
    recoverableRecords: [
      ["checkpoint-omitted", "Checkpoint body must be read separately."],
    ],
  },
];

function sectionItems(value: unknown): ResumeRecord[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { items?: unknown }).items)
  )
    return [];
  return (value as { items: ResumeRecord[] }).items;
}

/** Frozen copyContext behavior at c3551f5, including its checkpoint pointer,
 * body/next-action and proposed/cache warnings. Do not artificially weaken it.
 * Fixtures use live snapshots, so cachedAt is null in both renderers here. */
function frozenBaseline(context: ResumeInput): string {
  const cp = context.latestCheckpoint as
    | {
        recordId: string;
        revision?: number;
        recordedAt: string;
        provenance?: string;
        status?: string;
        checkpoint: {
          summary?: string;
          outcome?: string;
          nextAction?: string | null;
        } | null;
      }
    | null
    | undefined;
  const checkpoint = cp?.checkpoint;
  const decisions = sectionItems(context.goals);
  const constraints = sectionItems(context.constraints);
  return [
    `Project: ${context.project.name} (${context.project.id})`,
    cp
      ? `Checkpoint record: ${cp.recordId} revision: ${cp.revision ?? "unknown"} recordedAt: ${cp.recordedAt} provenance: ${cp.provenance ?? "unknown"} status: ${cp.status ?? "unknown"}`
      : null,
    cp?.status === "proposed"
      ? "WARNING: checkpoint is proposed working memory, not canonical truth."
      : null,
    checkpoint?.summary ? `Checkpoint: ${checkpoint.summary}` : null,
    checkpoint?.outcome ? `Outcome: ${checkpoint.outcome}` : null,
    checkpoint?.nextAction ? `Next action: ${checkpoint.nextAction}` : null,
    decisions[0]
      ? `Decision [${decisions[0].recordId} r${decisions[0].revision ?? "?"} ${decisions[0].provenance ?? "unknown"}]: ${decisions[0].text}`
      : null,
    constraints[0]
      ? `Constraint [${constraints[0].recordId} r${constraints[0].revision ?? "?"} ${constraints[0].provenance ?? "unknown"}]: ${constraints[0].text}`
      : null,
    `Unreviewed working records: ${context.workingMemory?.total ?? 0}`,
    "Active blockers: 0",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function runContextValueResumeEval(): ResumeQualityReport {
  const cases = CASES.map((fixture) => {
    const baseline = frozenBaseline(fixture.context);
    const current = renderResumeText(projectResumeContext(fixture.context));
    // This is a declared record-read proxy, not measured tool calls: one read
    // per fixture record whose essential text remains missing from the copy.
    const missingReads = (text: string) =>
      fixture.recoverableRecords.filter((essentials) =>
        essentials.some((s) => !text.includes(s)),
      ).length;
    return {
      id: fixture.id,
      language: fixture.language,
      baselineRetained: fixture.required.filter((s) => baseline.includes(s))
        .length,
      currentRetained: fixture.required.filter((s) => current.includes(s))
        .length,
      baselineCurrentness:
        fixture.current === null ? null : baseline.includes(fixture.current),
      currentCurrentness:
        fixture.current === null ? null : current.includes(fixture.current),
      baselineEstimatedAdditionalReads: missingReads(baseline),
      estimatedAdditionalReads: missingReads(current),
      omissionRecoveryVisible: /RECOVERY:|open the checkpoint record/i.test(
        current,
      ),
      baselineOmissionRecoveryVisible:
        /RECOVERY:|open the checkpoint record/i.test(baseline),
      budgetChecks: [4000, 6000, 9500].map((budget) => ({
        budget,
        baselineChars: baseline.length,
        currentChars: current.length,
        bothFit: baseline.length <= budget && current.length <= budget,
      })),
    };
  });
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    fixture: "frozen_context_value_resume_v3",
    scope: "presentation_fidelity_not_retrieval_benchmark",
    baselineSha: "c3551f5ab38c0d4b71f111be7ffb16716961f231",
    providerCalls: 0,
    baseline: {
      name: "copy-context-c3551f5",
      essentialsRetained: average(cases.map((c) => c.baselineRetained)),
      currentness: average(
        cases.flatMap((c) =>
          c.baselineCurrentness === null ? [] : [Number(c.baselineCurrentness)],
        ),
      ),
      estimatedAdditionalReads: average(
        cases.map((c) => c.baselineEstimatedAdditionalReads),
      ),
    },
    current: {
      name: "shared-resume-projection",
      essentialsRetained: average(cases.map((c) => c.currentRetained)),
      currentness: average(
        cases.flatMap((c) =>
          c.currentCurrentness === null ? [] : [Number(c.currentCurrentness)],
        ),
      ),
      estimatedAdditionalReads: average(
        cases.map((c) => c.estimatedAdditionalReads),
      ),
    },
    cases,
  };
}
