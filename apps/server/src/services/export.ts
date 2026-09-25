import { and, eq, sql } from "drizzle-orm";
import { projectResumeContext, renderResumeText, type HandoffExportDto, type HandoffExportInput, type RecordDto, type ResumeRecord } from "@contextkeep/shared";
import type { Db } from "../db/client.js";
import {
  auditEvents as auditEventsTable,
  conflicts,
  handoffs,
  importJobs as importJobsTable,
  projects,
  recordEvidence as recordEvidenceTable,
  records as recordsTable,
  sourceExcerpts as sourceExcerptsTable,
  sources as sourcesTable,
  supersessions as supersessionsTable,
} from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { dateOnly, nowIso } from "../lib/time.js";
import { writeAudit } from "./audit.js";
import { buildBrief } from "./brief.js";
import type { ActorCtx, ServiceDeps } from "./import.js";

function recordMarker(exportId: string, recordId: string): string {
  return `<!-- ck-record:${exportId}:${recordId} -->`;
}

function includedIdsFromMarkedMarkdown(markdown: string, markers: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split("\n")) {
    const id = markers.get(line);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function stripRecordMarkers(markdown: string, markers: ReadonlyMap<string, string>): string {
  return markdown
    .split("\n")
    .filter((line) => !markers.has(line))
    .join("\n");
}

function visibleLength(markdown: string, markers: ReadonlyMap<string, string>): number {
  return stripRecordMarkers(markdown, markers).length;
}

function truncateAtLineBoundary(
  markdown: string,
  budget: number,
  notice: string,
  markers: ReadonlyMap<string, string>,
): string {
  if (notice.length >= budget) return notice.slice(0, budget);
  const contentBudget = budget - notice.length;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const candidate = [...out, line].join("\n");
    if (visibleLength(candidate, markers) > contentBudget) break;
    out.push(line);
  }
  return `${out.join("\n")}${notice}`;
}

/**
 * Portable Markdown handoff (handoff §4 journey D, M0 scope 7, A7):
 * reproduces accepted current facts, decisions, constraints, open questions,
 * next actions, unresolved conflicts and last-reviewed dates — each statement
 * with its evidence excerpts. Useful without ContextKeep or any API account.
 */
export function renderHandoff(deps: ServiceDeps, input: HandoffExportInput, ctx: ActorCtx): HandoffExportDto {
  const { db } = deps;
  const brief = buildBrief(deps, input.projectId);
  const project = db.select().from(projects).where(eq(projects.id, input.projectId)).get();
  if (!project) throw new ApiError(404, "project_not_found", `Project ${input.projectId} not found.`);
  const id = newId();
  const markerToRecordId = new Map<string, string>();

  const openConflicts = db
    .select()
    .from(conflicts)
    .where(and(eq(conflicts.projectId, input.projectId), eq(conflicts.status, "unresolved")))
    .all();

  const truncationNotes: string[] = [];
  const budget = input.contextBudgetChars;

  const lines: string[] = [];
  lines.push(`# ContextKeep handoff — ${brief.project.name}`);
  lines.push("");
  lines.push(
    `> Generated ${brief.generatedAt} · Lifecycle: **${brief.lifecycle.state}** · Source revision: ${project.revision} · Content cursor: ${project.contentVersion}`,
  );
  if (input.objective) lines.push(`> Objective: ${input.objective}`);
  lines.push(
    "> Portable handoff: valid without ContextKeep or any API account. Every statement lists its evidence.",
  );
  if (brief.description) {
    lines.push("");
    lines.push("## Purpose");
    lines.push("");
    lines.push(brief.description);
  }

  // Adapt accepted brief DTOs to the same semantic resume projection used by
  // the dashboard; record IDs and trust metadata must not disappear in mapping.
  const resumeRecord = (record: RecordDto): ResumeRecord => ({
    recordId: record.id,
    revision: record.revision,
    text: record.text,
    subject: record.subject,
    status: record.reviewStatus,
    provenance: record.evidenceBasis,
    taskStatus: record.taskStatus,
    stale: record.freshness?.stale ?? record.isOverdue,
    requiresReview: record.freshness?.requiresReview ?? record.isOverdue,
  });
  const workingCount = db.select({ n: sql<number>`count(*)` }).from(recordsTable).where(and(
    eq(recordsTable.projectId, input.projectId),
    eq(recordsTable.reviewStatus, "proposed"),
    eq(recordsTable.evidenceBasis, "agent_report"),
  )).get()?.n ?? 0;
  const resume = projectResumeContext({
    project: { id: brief.project.id, name: brief.project.name },
    goals: { items: brief.decisions.map((item) => resumeRecord(item.record)) },
    constraints: { items: brief.constraints.map((item) => resumeRecord(item.record)) },
    actions: { items: brief.actions.map((item) => resumeRecord(item.record)) },
    currentState: { items: brief.facts.map((item) => resumeRecord(item.record)) },
    latestBlockers: openConflicts.map((conflict) => `Conflict ${conflict.id} remains unresolved.`),
    workingMemory: { total: Number(workingCount) },
  });

  function renderSection(
    heading: string,
    statements: { record: { id: string; text: string; reviewedAt: string | null; subject: string; taskStatus: string | null }; evidence: { text: string; sourceTitle: string | null; startOffset: number; endOffset: number }[] }[],
    opts: { checkbox?: boolean } = {},
  ): void {
    lines.push("");
    lines.push(`## ${heading}`);
    if (statements.length === 0) {
      lines.push("");
      lines.push("_None recorded._");
      return;
    }
    for (const s of statements) {
      const reviewed = s.record.reviewedAt ? ` _(last reviewed: ${dateOnly(s.record.reviewedAt)})_` : " _(never reviewed)_";
      const prefix = opts.checkbox ? "- [ ] " : "- ";
      const status = s.record.taskStatus ? ` **[${s.record.taskStatus}]**` : "";
      lines.push("");
      lines.push(`${prefix}${s.record.text}${status}${reviewed}`);
      if (s.evidence.length > 0) {
        for (const ev of s.evidence) {
          lines.push(`  > “${truncateMiddle(ev.text, 400)}” — ${ev.sourceTitle ?? "untitled source"} [offsets ${ev.startOffset}–${ev.endOffset}]`);
        }
      } else {
        lines.push("  > _no evidence excerpt linked_");
      }
      // Internal marker is removed before returning Markdown. Its presence after
      // all budget trimming proves the associated statement block survived.
      const marker = recordMarker(id, s.record.id);
      markerToRecordId.set(marker, s.record.id);
      lines.push(marker);
    }
  }

  // Budget priority is operational: preserve blockers and executable next work
  // before background context when the handoff must be truncated.
  renderSection("Constraints", brief.constraints);
  renderSection("Next actions", brief.actions, { checkbox: true });
  renderSection("Decisions", brief.decisions);
  renderSection("Open questions", brief.openQuestions);
  renderSection("Current facts", brief.facts);

  lines.push("");
  lines.push("## Unresolved conflicts");
  if (openConflicts.length === 0) {
    lines.push("");
    lines.push("_None._");
  } else {
    for (const c of openConflicts) {
      lines.push("");
      lines.push(`- Conflict ${c.id}: records ${c.recordIdsJson} — status ${c.status}`);
    }
  }

  lines.push("");
  lines.push("## Last reviewed");
  lines.push("");
  const allStatements = [...brief.facts, ...brief.decisions, ...brief.constraints, ...brief.openQuestions, ...brief.actions];
  if (allStatements.length === 0) {
    lines.push("_No accepted statements yet._");
  } else {
    for (const s of allStatements) {
      lines.push(
        `- ${truncateMiddle(s.record.text, 80)} — reviewed ${s.record.reviewedAt ? dateOnly(s.record.reviewedAt) : "never"}`,
      );
    }
  }
  if (brief.lastReviewedAt) {
    lines.push("");
    lines.push(`Project last-reviewed date: **${dateOnly(brief.lastReviewedAt)}**`);
  }

  let markedMarkdown = lines.join("\n");
  // This canonical handoff remains an evidenced snapshot. A convenient shared
  // resume summary is optional, and must never evict original evidence/records.
  const resumeAppendix = `\n\n## Resume\n\nCanonical snapshot; agent checkpoints are not included in this handoff.\n\n${renderResumeText(resume)}`;
  if (visibleLength(markedMarkdown + resumeAppendix, markerToRecordId) <= budget) {
    markedMarkdown += resumeAppendix;
  }

  if (visibleLength(markedMarkdown, markerToRecordId) > budget) {
    // First trim: strip evidence quotes, keep complete statement lines + internal
    // completion markers. includedRecordIds is calculated only after all trims.
    markedMarkdown = markedMarkdown
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("> “"))
      .join("\n");
    truncationNotes.push("Evidence quotes dropped to fit the context budget; record statements are retained where the remaining budget allows.");
  }
  if (visibleLength(markedMarkdown, markerToRecordId) > budget) {
    const notice = "\n\n> WARNING: Context budget truncated this handoff. Some records or evidence are omitted; use the JSON export for complete data.";
    markedMarkdown = truncateAtLineBoundary(markedMarkdown, budget, notice, markerToRecordId);
    truncationNotes.push(`Markdown truncated at a line boundary to ${budget} chars; full data remains in the JSON export.`);
  }

  // F10: calculate metadata from the FINAL bounded representation, never from
  // the pre-truncation source. This intentionally under-claims if a marker could
  // not fit after an otherwise visible statement; it must never over-claim.
  const includedRecordIds = includedIdsFromMarkedMarkdown(markedMarkdown, markerToRecordId);
  const markdown = stripRecordMarkers(markedMarkdown, markerToRecordId);
  const now = nowIso();
  db.insert(handoffs)
    .values({
      id,
      projectId: input.projectId,
      createdAt: now,
      sourceRevision: project.revision,
      sourceContentVersion: project.contentVersion,
      objective: input.objective,
      renderedMarkdown: markdown,
      includedRecordIdsJson: JSON.stringify(includedRecordIds),
      truncationNotesJson: JSON.stringify(truncationNotes),
    })
    .run();
  writeAudit(db, {
    actor: ctx.actor,
    action: "handoff.exported",
    targetType: "handoff",
    targetId: id,
    before: null,
    after: { id, projectId: input.projectId, includedRecordIds, truncationNotes },
    detail: { objective: input.objective, budget },
    requestId: ctx.requestId ?? null,
  });

  return {
    id,
    projectId: input.projectId,
    createdAt: now,
    objective: input.objective,
    sourceRevision: project.revision,
    sourceContentVersion: project.contentVersion,
    markdown,
    includedRecordIds,
    truncationNotes,
  };
}

export function getHandoff(deps: ServiceDeps, id: string): HandoffExportDto {
  const row = deps.db.select().from(handoffs).where(eq(handoffs.id, id)).get();
  if (!row) throw new ApiError(404, "handoff_not_found", `Handoff ${id} not found.`);
  return {
    id: row.id,
    projectId: row.projectId,
    createdAt: row.createdAt,
    objective: row.objective,
    sourceRevision: row.sourceRevision,
    sourceContentVersion: row.sourceContentVersion,
    markdown: row.renderedMarkdown,
    includedRecordIds: JSON.parse(row.includedRecordIdsJson) as string[],
    truncationNotes: JSON.parse(row.truncationNotesJson) as string[],
  };
}

function isSensitiveSessionAuditKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return normalized === "id" || normalized === "sessionid" || normalized === "csrftoken" || normalized === "token" || normalized.endsWith("token");
}

function redactSessionAuditValue(value: unknown, legacySessionId: string | null): unknown {
  if (typeof value === "string") {
    return legacySessionId !== null && value === legacySessionId ? "[redacted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSessionAuditValue(item, legacySessionId));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveSessionAuditKey(key) ? "[redacted]" : redactSessionAuditValue(child, legacySessionId);
    }
    return out;
  }
  return value;
}

function sanitizeSessionAuditJson(raw: string | null, legacySessionId: string | null): string | null {
  if (raw === null) return null;
  try {
    return JSON.stringify(redactSessionAuditValue(JSON.parse(raw) as unknown, legacySessionId));
  } catch {
    // Malformed legacy session audit metadata is safer omitted than exported verbatim.
    return null;
  }
}

function sanitizeAuditEventForDump(event: typeof auditEventsTable.$inferSelect): typeof auditEventsTable.$inferSelect {
  if (event.targetType !== "session") return event;
  const safeTarget = event.targetId?.startsWith("session-sha256:") === true;
  const legacySessionId = safeTarget ? null : event.targetId;
  return {
    ...event,
    targetId: safeTarget ? event.targetId : event.targetId === null ? null : "[redacted-session]",
    beforeRef: sanitizeSessionAuditJson(event.beforeRef, legacySessionId),
    afterRef: sanitizeSessionAuditJson(event.afterRef, legacySessionId),
    detailJson: sanitizeSessionAuditJson(event.detailJson, legacySessionId),
  };
}

/** Full JSON dump (M0 scope 7): every table, for external backup / second-machine seed. */
export function buildJsonDump(deps: ServiceDeps, ctx: ActorCtx): Record<string, unknown> {
  const { db } = deps;
  const dump: Record<string, unknown> = {
    format: "contextkeep.json_dump",
    version: 1,
    exportedAt: nowIso(),
    projects: db.select().from(projects).all(),
    sources: db.select().from(sourcesTable).all(),
    sourceExcerpts: db.select().from(sourceExcerptsTable).all(),
    records: db.select().from(recordsTable).all(),
    recordEvidence: db.select().from(recordEvidenceTable).all(),
    supersessions: db.select().from(supersessionsTable).all(),
    conflicts: db.select().from(conflicts).all(),
    importJobs: db.select().from(importJobsTable).all(),
    handoffs: db.select().from(handoffs).all(),
    auditEvents: db.select().from(auditEventsTable).all().map(sanitizeAuditEventForDump),
  };
  writeAudit(db, {
    actor: ctx.actor,
    action: "dump.exported",
    targetType: "store",
    targetId: null,
    after: { exportedAt: dump.exportedAt },
    requestId: ctx.requestId ?? null,
  });
  return dump;
}

function truncateMiddle(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor((n - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}
