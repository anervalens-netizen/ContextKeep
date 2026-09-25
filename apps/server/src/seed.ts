import { eq, sql } from "drizzle-orm";
import type { EvidenceBasis, RecordType, ReviewStatus, TaskStatus } from "@contextkeep/shared";
import { importJobs, projects, recordEvidence, records, sourceExcerpts, sources, supersessions } from "./db/schema.js";
import { recordDedupHash, sha256 } from "./lib/hash.js";
import { newId } from "./lib/ids.js";
import { nowIso } from "./lib/time.js";
import { writeAudit } from "./services/audit.js";
import { chunkText } from "./services/chunk.js";
import { normalizeText } from "./services/normalize.js";
import type { ActorCtx, ServiceDeps } from "./services/import.js";

export interface SeedResult {
  seeded: boolean;
  projectIds: Record<string, string>;
  recordCount: number;
}

const CORRECTION_EVENT_AT = "2026-09-09T09:00:00.000Z";
const CONFIRM_EVENT_AT = "2026-09-09T09:10:00.000Z";

const S1_TEXT = `Owner correction — 2026-09-09

The other ExampleSuite applications are retired, not active. ExampleSuite Server and ExampleSuite Web are retired; the retirement is a permanent lifecycle fact for this inventory.

ExampleSuite Keyboard remains in use: the Android keyboard with an OpenAI-powered voice/LLM feature. The Keyboard exception is preserved under all conditions.

Imported Codex memory may be incomplete or outdated and must not be treated as a current application inventory. Candidate names may be imported without asserting that they are currently deployed.`;

const S2_TEXT = `# ExampleSuite Keyboard notes

Early builds (2025) experimented with an on-device STT pipeline for voice input.

Current builds use the OpenAI-powered voice/LLM feature for voice input and smart replies.`;

const S3_TEXT = `# Imported memory (unreviewed)

ExampleAssistant is a NimbusDemo-based assistant web app running as example-assistant.service with settings in ~/.config/example-assistant/settings.yaml.

Action: confirm the current ExampleAssistant deployment status before relying on this import.`;

/**
 * Seed demo data per handoff §3 (M0 scope 12):
 * - ExampleSuite family (ExampleSuite, ExampleSuite Server, ExampleSuite Web) retired with owner-declaration evidence.
 * - ExampleSuite Keyboard as a SEPARATE component, active, OpenAI-powered voice/LLM feature.
 * - One demo supersession chain (on-device STT experiment → OpenAI-powered feature).
 * - ExampleAssistant imported from agent memory: lifecycle unknown, records stay PROPOSED (§3 rule 3, A22).
 * Idempotent: skips when the store already has projects.
 */
export function seedDemo(deps: ServiceDeps, ctx: ActorCtx): SeedResult {
  const { db } = deps;
  const existing = db.select({ n: sql<number>`count(*)` }).from(projects).get();
  if ((existing?.n ?? 0) > 0) {
    return { seeded: false, projectIds: {}, recordCount: 0 };
  }

  const now = nowIso();
  const projectIds: Record<string, string> = {};
  let recordCount = 0;

  db.transaction((tx) => {
    function insertSource(opts: {
      kind: string;
      title: string;
      originalFilename?: string | null;
      text: string;
      authorLabel: string | null;
      provenanceBasis: string;
      projectId?: string | null;
      eventAt?: string | null;
    }): { sourceId: string; excerptIds: { id: string; text: string }[] } {
      const sourceId = newId();
      const normalized = normalizeText(opts.text);
      tx.insert(sources)
        .values({
          id: sourceId,
          kind: opts.kind,
          title: opts.title,
          originalFilename: opts.originalFilename ?? null,
          contentHash: sha256(opts.text),
          normalizedHash: sha256(normalized),
          importedAt: now,
          eventAt: opts.eventAt ?? null,
          authorLabel: opts.authorLabel,
          provenanceBasis: opts.provenanceBasis,
          projectId: opts.projectId ?? null,
          originalText: opts.text,
          normalizedText: normalized,
          redactionState: "none",
        })
        .run();
      const chunks = chunkText(normalized);
      const excerptIds: { id: string; text: string }[] = [];
      for (const c of chunks) {
        const id = newId();
        tx.insert(sourceExcerpts)
          .values({
            id,
            sourceId,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            exactText: c.text,
            exactTextHash: sha256(c.text),
          })
          .run();
        excerptIds.push({ id, text: c.text });
      }
      writeAudit(tx, {
        actor: ctx.actor,
        action: "source.imported",
        targetType: "source",
        targetId: sourceId,
        after: { sourceId, title: opts.title, excerptCount: chunks.length },
        detail: { seed: true },
        requestId: ctx.requestId ?? null,
      });
      return { sourceId, excerptIds };
    }

    function findExcerpt(excerpts: { id: string; text: string }[], keyword: string): string {
      const hit = excerpts.find((e) => e.text.includes(keyword));
      if (!hit) throw new Error(`seed: excerpt keyword not found: ${keyword}`);
      return hit.id;
    }

    function insertRecord(opts: {
      projectId: string | null;
      type: RecordType;
      subject: string;
      predicate?: string | null;
      valueJson?: unknown | null;
      text: string;
      reviewStatus: ReviewStatus;
      evidenceBasis: EvidenceBasis;
      taskStatus?: TaskStatus | null;
      recordedAt?: string;
      sourceEventAt?: string | null;
      reviewedAt?: string | null;
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
      excerptIds: string[];
    }): string {
      const id = newId();
      tx.insert(records)
        .values({
          id,
          projectId: opts.projectId,
          type: opts.type,
          subject: opts.subject,
          predicate: opts.predicate ?? null,
          valueJson: opts.valueJson === undefined || opts.valueJson === null ? null : JSON.stringify(opts.valueJson),
          text: opts.text,
          reviewStatus: opts.reviewStatus,
          evidenceBasis: opts.evidenceBasis,
          taskStatus: opts.taskStatus ?? null,
          recordDedupHash: recordDedupHash({
            projectId: opts.projectId,
            type: opts.type,
            subject: opts.subject,
            text: opts.text,
          }),
          recordedAt: opts.recordedAt ?? now,
          sourceEventAt: opts.sourceEventAt ?? null,
          effectiveFrom: opts.effectiveFrom ?? null,
          effectiveTo: opts.effectiveTo ?? null,
          reviewedAt: opts.reviewedAt ?? null,
          reviewDueAt: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      for (const excerptId of opts.excerptIds) {
        tx.insert(recordEvidence)
          .values({
            recordId: id,
            excerptId,
            relation: "supports",
            observedAt: opts.sourceEventAt ?? null,
            environment: null,
            artifactRef: null,
          })
          .run();
      }
      recordCount++;
      return id;
    }

    // --- Sources ---
    const s1 = insertSource({
      kind: "owner_correction",
      title: "Owner correction — 2026-09-09 (ExampleSuite inventory)",
      text: S1_TEXT,
      authorLabel: "owner",
      provenanceBasis: "owner_review",
      eventAt: CORRECTION_EVENT_AT,
    });
    const s2 = insertSource({
      kind: "system_seed",
      title: "exampleSuite-keyboard-notes.md",
      originalFilename: "exampleSuite-keyboard-notes.md",
      text: S2_TEXT,
      authorLabel: null,
      provenanceBasis: "system",
    });
    const s3 = insertSource({
      kind: "system_seed",
      title: "codex-memory-import.md",
      originalFilename: "codex-memory-import.md",
      text: S3_TEXT,
      authorLabel: "codex-memory",
      provenanceBasis: "system",
    });

    // --- Projects (§3: ExampleSuite family retired; ExampleSuite Keyboard separate + active; ExampleAssistant unknown) ---
    function insertProject(opts: {
      key: string;
      name: string;
      description: string;
      parentId?: string | null;
      aliases?: string[];
    }): string {
      const id = newId();
      tx.insert(projects)
        .values({
          id,
          name: opts.name,
          aliasesJson: JSON.stringify(opts.aliases ?? []),
          parentProjectId: opts.parentId ?? null,
          description: opts.description,
          lifecycle: "unknown",
          lifecycleRecordId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      projectIds[opts.key] = id;
      return id;
    }

    const exampleSuiteId = insertProject({
      key: "exampleSuite",
      name: "ExampleSuite",
      description:
        "ExampleSuite family umbrella (historical). Retired per owner correction 2026-09-09; imports of old material must never reactivate it (A3).",
      aliases: ["ExampleSuite family"],
    });
    const exampleSuiteServerId = insertProject({
      key: "exampleSuiteServer",
      name: "ExampleSuite Server",
      description: "Retired ExampleSuite family application (server component).",
      parentId: exampleSuiteId,
    });
    const exampleSuiteWebId = insertProject({
      key: "exampleSuiteWeb",
      name: "ExampleSuite Web",
      description: "Retired ExampleSuite family application (web component).",
      parentId: exampleSuiteId,
    });
    const exampleSuiteKeyboardId = insertProject({
      key: "exampleSuiteKeyboard",
      name: "ExampleSuite Keyboard",
      description:
        "ACTIVE component and the ExampleSuite exception: Android keyboard with an OpenAI-powered voice/LLM feature (owner correction 2026-09-09). Kept separate from the retired ExampleSuite family scope.",
      aliases: ["example-keyboard"],
    });
    const dshId = insertProject({
      key: "dsh",
      name: "ExampleAssistant",
      description: "Imported candidate from Codex memory — unreviewed, current status unknown (§3 rule 3).",
    });

    const excerptRetirement = findExcerpt(s1.excerptIds, "retired, not active");
    const excerptKeyboard = findExcerpt(s1.excerptIds, "remains in use");
    const excerptInventory = findExcerpt(s1.excerptIds, "must not be treated");
    const excerptOnDevice = findExcerpt(s2.excerptIds, "on-device STT");
    const excerptOpenAi = findExcerpt(s2.excerptIds, "OpenAI-powered voice/LLM feature for voice input");
    const excerptDshFact = findExcerpt(s3.excerptIds, "NimbusDemo-based");
    const excerptDshAction = findExcerpt(s3.excerptIds, "deployment status");

    // --- Lifecycle records (accepted, owner declaration) + projections ---
    function lifecycleRecord(opts: {
      projectId: string;
      projectName: string;
      state: "retired" | "active";
      quote: string;
      excerptId: string;
    }): string {
      const id = insertRecord({
        projectId: opts.projectId,
        type: "fact",
        subject: `project:${opts.projectName}`,
        predicate: "lifecycle",
        valueJson: { state: opts.state },
        text: `Lifecycle: ${opts.state} — owner correction (2026-09-09): "${opts.quote}"`,
        reviewStatus: "accepted",
        evidenceBasis: "owner_declaration",
        recordedAt: now,
        sourceEventAt: CORRECTION_EVENT_AT,
        reviewedAt: now,
        effectiveFrom: CORRECTION_EVENT_AT,
        excerptIds: [opts.excerptId],
      });
      tx.update(projects)
        .set({ lifecycle: opts.state, lifecycleRecordId: id, updatedAt: now })
        .where(eq(projects.id, opts.projectId))
        .run();
      writeAudit(tx, {
        actor: ctx.actor,
        action: "record.accepted",
        targetType: "record",
        targetId: id,
        after: { reviewStatus: "accepted", lifecycle: opts.state, projectId: opts.projectId },
        detail: { seed: true },
        requestId: ctx.requestId ?? null,
      });
      return id;
    }

    lifecycleRecord({
      projectId: exampleSuiteId,
      projectName: "ExampleSuite",
      state: "retired",
      quote: "The other ExampleSuite applications are retired, not active.",
      excerptId: excerptRetirement,
    });
    lifecycleRecord({
      projectId: exampleSuiteServerId,
      projectName: "ExampleSuite Server",
      state: "retired",
      quote: "The other ExampleSuite applications are retired, not active.",
      excerptId: excerptRetirement,
    });
    lifecycleRecord({
      projectId: exampleSuiteWebId,
      projectName: "ExampleSuite Web",
      state: "retired",
      quote: "The other ExampleSuite applications are retired, not active.",
      excerptId: excerptRetirement,
    });
    lifecycleRecord({
      projectId: exampleSuiteKeyboardId,
      projectName: "ExampleSuite Keyboard",
      state: "active",
      quote: "ExampleSuite Keyboard remains in use: the Android keyboard with an OpenAI-powered voice/LLM feature.",
      excerptId: excerptKeyboard,
    });

    // --- ExampleSuite Keyboard accepted facts ---
    insertRecord({
      projectId: exampleSuiteKeyboardId,
      type: "fact",
      subject: "exampleSuite-keyboard",
      predicate: "platform",
      text: "ExampleSuite Keyboard is an Android keyboard with an OpenAI-powered voice/LLM feature.",
      reviewStatus: "accepted",
      evidenceBasis: "owner_declaration",
      sourceEventAt: CORRECTION_EVENT_AT,
      reviewedAt: now,
      excerptIds: [excerptKeyboard, excerptOpenAi],
    });
    insertRecord({
      projectId: dshId,
      type: "constraint",
      subject: "inventory-policy",
      predicate: "imported-memory",
      text: "Imported Codex memory must not be treated as a current application inventory; candidate names may be imported without asserting deployment.",
      reviewStatus: "accepted",
      evidenceBasis: "owner_declaration",
      sourceEventAt: CORRECTION_EVENT_AT,
      reviewedAt: now,
      excerptIds: [excerptInventory],
    });

    // --- Demo supersession chain: on-device STT experiment -> OpenAI-powered feature ---
    const r1 = insertRecord({
      projectId: exampleSuiteKeyboardId,
      type: "fact",
      subject: "exampleSuite-keyboard-voice",
      predicate: "provider",
      text: "ExampleSuite Keyboard voice input used an experimental on-device STT pipeline (2025).",
      reviewStatus: "superseded",
      evidenceBasis: "document",
      recordedAt: "2025-06-01T09:00:00.000Z",
      sourceEventAt: "2025-06-01T09:00:00.000Z",
      effectiveFrom: "2025-06-01T09:00:00.000Z",
      effectiveTo: CONFIRM_EVENT_AT,
      excerptIds: [excerptOnDevice],
    });
    const r2 = insertRecord({
      projectId: exampleSuiteKeyboardId,
      type: "fact",
      subject: "exampleSuite-keyboard-voice",
      predicate: "provider",
      text: "ExampleSuite Keyboard voice input uses the OpenAI-powered voice/LLM feature.",
      reviewStatus: "accepted",
      evidenceBasis: "owner_declaration",
      sourceEventAt: CORRECTION_EVENT_AT,
      reviewedAt: now,
      effectiveFrom: CONFIRM_EVENT_AT,
      excerptIds: [excerptOpenAi, excerptKeyboard],
    });
    const supersessionId = newId();
    tx.insert(supersessions)
      .values({
        id: supersessionId,
        priorRecordId: r1,
        replacementRecordId: r2,
        jobId: null,
        reason:
          "Owner correction 2026-09-09 — ExampleSuite Keyboard remains in use with the OpenAI-powered voice/LLM feature; the on-device STT experiment is historical.",
        confirmedAt: CONFIRM_EVENT_AT,
        confirmedBy: "owner",
        proposedAt: CONFIRM_EVENT_AT,
      })
      .run();
    writeAudit(tx, {
      actor: ctx.actor,
      action: "supersession.confirmed",
      targetType: "supersession",
      targetId: supersessionId,
      after: { priorRecordId: r1, replacementRecordId: r2, confirmedAt: CONFIRM_EVENT_AT },
      detail: { seed: true },
      requestId: ctx.requestId ?? null,
    });

    // --- ExampleAssistant: agent-memory candidates stay PROPOSED (inbox demo, A22) ---
    insertRecord({
      projectId: dshId,
      type: "fact",
      subject: "dsh",
      predicate: "description",
      text: "ExampleAssistant is a NimbusDemo-based assistant web app running as example-assistant.service with settings in ~/.config/example-assistant/settings.yaml.",
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      excerptIds: [excerptDshFact],
    });
    insertRecord({
      projectId: dshId,
      type: "action",
      subject: "dsh",
      predicate: null,
      text: "Confirm the current ExampleAssistant deployment status before relying on the imported memory.",
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      taskStatus: "open",
      excerptIds: [excerptDshAction],
    });
    insertRecord({
      projectId: dshId,
      type: "action",
      subject: "dsh-migration",
      predicate: null,
      text: "ExampleAssistant settings migration to refs.* credentials completed (agent reported done — not in any brief until the owner accepts it, A22).",
      reviewStatus: "proposed",
      evidenceBasis: "agent_report",
      taskStatus: "done",
      excerptIds: [excerptDshAction],
    });

    // Seed marker job for traceability.
    tx.insert(importJobs)
      .values({
        id: newId(),
        sourceId: null,
        stage: "done",
        adapterId: "manual",
        adapterVersion: "1.0.0",
        providerModel: null,
        attempts: 0,
        errorCode: null,
        usageJson: JSON.stringify({ seed: true }),
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  return { seeded: true, projectIds, recordCount };
}
