import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  contextCursorSnapshots,
  contextDeltaSessions,
  projects,
  recordEvidence,
  records,
  sourceExcerpts,
} from "../db/schema.js";
import { sha256 } from "../lib/hash.js";
import { nowIso } from "../lib/time.js";

export type ContextCursorScope = "canonical" | "working";
export type ContextManifest = Record<string, string>;
export const CONTEXT_CURSOR_RETENTION_PER_SCOPE = 64;

type RecordRow = typeof records.$inferSelect;

function rowsForScope(db: Db, projectId: string, scope: ContextCursorScope): RecordRow[] {
  const where = scope === "canonical"
    ? and(eq(records.projectId, projectId), inArray(records.reviewStatus, ["accepted", "superseded"]))
    : and(
        eq(records.projectId, projectId),
        eq(records.reviewStatus, "proposed"),
        eq(records.evidenceBasis, "agent_report"),
      );
  return db.select().from(records).where(where).orderBy(records.id).all();
}

export function buildContextManifest(
  db: Db,
  projectId: string,
  scope: ContextCursorScope,
): ContextManifest {
  const rows = rowsForScope(db, projectId, scope);
  const ids = rows.map((row) => row.id);
  const evidence = new Map<string, Array<{
    excerptId: string;
    relation: string;
    observedAt: string | null;
    environment: string | null;
    artifactRef: string | null;
    exactTextHash: string;
  }>>();
  if (ids.length > 0) {
    for (const item of db
      .select({
        recordId: recordEvidence.recordId,
        excerptId: recordEvidence.excerptId,
        relation: recordEvidence.relation,
        observedAt: recordEvidence.observedAt,
        environment: recordEvidence.environment,
        artifactRef: recordEvidence.artifactRef,
        exactTextHash: sourceExcerpts.exactTextHash,
      })
      .from(recordEvidence)
      .innerJoin(sourceExcerpts, eq(recordEvidence.excerptId, sourceExcerpts.id))
      .where(inArray(recordEvidence.recordId, ids))
      .all()) {
      const list = evidence.get(item.recordId) ?? [];
      list.push({
        excerptId: item.excerptId,
        relation: item.relation,
        observedAt: item.observedAt,
        environment: item.environment,
        artifactRef: item.artifactRef,
        exactTextHash: item.exactTextHash,
      });
      evidence.set(item.recordId, list);
    }
  }

  const manifest: ContextManifest = {};
  for (const row of rows) {
    const linkedEvidence = (evidence.get(row.id) ?? [])
      .sort((a, b) =>
        a.excerptId.localeCompare(b.excerptId) ||
        a.relation.localeCompare(b.relation) ||
        (a.observedAt ?? "").localeCompare(b.observedAt ?? "") ||
        (a.artifactRef ?? "").localeCompare(b.artifactRef ?? "")
      );
    manifest[row.id] = sha256(JSON.stringify({
      id: row.id,
      projectId: row.projectId,
      type: row.type,
      subject: row.subject,
      predicate: row.predicate,
      valueJson: row.valueJson,
      text: row.text,
      reviewStatus: row.reviewStatus,
      evidenceBasis: row.evidenceBasis,
      taskStatus: row.taskStatus,
      recordDedupHash: row.recordDedupHash,
      recordedAt: row.recordedAt,
      sourceEventAt: row.sourceEventAt,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      reviewedAt: row.reviewedAt,
      reviewDueAt: row.reviewDueAt,
      volatile: row.volatile,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      evidence: linkedEvidence,
    }));
  }
  return manifest;
}

export function pruneContextCursorSnapshots(
  db: Db,
  projectId: string,
  scope: ContextCursorScope,
  keep = CONTEXT_CURSOR_RETENTION_PER_SCOPE,
): number {
  const limit = Math.max(1, keep);
  const retained = db
    .select({ cursor: contextCursorSnapshots.cursor })
    .from(contextCursorSnapshots)
    .where(and(
      eq(contextCursorSnapshots.projectId, projectId),
      eq(contextCursorSnapshots.scope, scope),
    ))
    .orderBy(desc(contextCursorSnapshots.cursor))
    .limit(limit)
    .all();
  if (retained.length < limit) return 0;
  const oldestRetained = retained.at(-1)!.cursor;
  return db.delete(contextCursorSnapshots)
    .where(and(
      eq(contextCursorSnapshots.projectId, projectId),
      eq(contextCursorSnapshots.scope, scope),
      sql`${contextCursorSnapshots.cursor} < ${oldestRetained}`,
    ))
    .run().changes;
}

export function writeContextCursorSnapshot(
  db: Db,
  projectId: string,
  scope: ContextCursorScope,
  cursor: number,
  baseline = false,
): void {
  const project = db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return;
  db.insert(contextCursorSnapshots)
    .values({
      projectId,
      scope,
      cursor,
      projectRevision: project.revision,
      manifestJson: JSON.stringify(buildContextManifest(db, projectId, scope)),
      baseline: baseline ? 1 : 0,
      createdAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();
  pruneContextCursorSnapshots(db, projectId, scope);
}

export function refreshContextCursorSnapshot(
  db: Db,
  projectId: string,
  scope: ContextCursorScope,
  cursor: number,
): void {
  const project = db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return;
  db.update(contextCursorSnapshots)
    .set({
      projectRevision: project.revision,
      manifestJson: JSON.stringify(buildContextManifest(db, projectId, scope)),
      createdAt: nowIso(),
    })
    .where(and(
      eq(contextCursorSnapshots.projectId, projectId),
      eq(contextCursorSnapshots.scope, scope),
      eq(contextCursorSnapshots.cursor, cursor),
    ))
    .run();
}

export function initializeProjectCursorSnapshots(db: Db, projectId: string): void {
  writeContextCursorSnapshot(db, projectId, "canonical", 0, false);
  writeContextCursorSnapshot(db, projectId, "working", 0, false);
}

export function ensureContextCursorBaselines(db: Db): void {
  const rows = db
    .select({
      id: projects.id,
      contentVersion: projects.contentVersion,
      workingMemoryVersion: projects.workingMemoryVersion,
    })
    .from(projects)
    .all();

  for (const project of rows) {
    db.transaction((tx) => {
      let invalidatedSessions = false;
      for (const scope of ["canonical", "working"] as const) {
        const cursor = scope === "canonical" ? project.contentVersion : project.workingMemoryVersion;
        const snapshot = tx
          .select({ manifestJson: contextCursorSnapshots.manifestJson })
          .from(contextCursorSnapshots)
          .where(and(
            eq(contextCursorSnapshots.projectId, project.id),
            eq(contextCursorSnapshots.scope, scope),
            eq(contextCursorSnapshots.cursor, cursor),
          ))
          .get();

        if (!snapshot) {
          writeContextCursorSnapshot(tx, project.id, scope, cursor, true);
          continue;
        }

        const materialized = JSON.stringify(buildContextManifest(tx, project.id, scope));
        if (snapshot.manifestJson === materialized) continue;

        if (scope === "canonical") {
          tx.update(projects)
            .set({ contentVersion: sql`${projects.contentVersion} + 1` })
            .where(eq(projects.id, project.id))
            .run();
          writeContextCursorSnapshot(tx, project.id, scope, cursor + 1, false);
        } else {
          tx.update(projects)
            .set({ workingMemoryVersion: sql`${projects.workingMemoryVersion} + 1` })
            .where(eq(projects.id, project.id))
            .run();
          writeContextCursorSnapshot(tx, project.id, scope, cursor + 1, false);
        }
        invalidatedSessions = true;
      }

      if (invalidatedSessions) {
        tx.delete(contextDeltaSessions).where(eq(contextDeltaSessions.projectId, project.id)).run();
      }
    });
  }
}

export function readContextCursorSnapshot(
  db: Db,
  projectId: string,
  scope: ContextCursorScope,
  cursor: number,
): {
  projectId: string;
  scope: string;
  cursor: number;
  projectRevision: number;
  manifestJson: string;
  baseline: number;
  createdAt: string;
} | null {
  return db
    .select()
    .from(contextCursorSnapshots)
    .where(and(
      eq(contextCursorSnapshots.projectId, projectId),
      eq(contextCursorSnapshots.scope, scope),
      eq(contextCursorSnapshots.cursor, cursor),
    ))
    .get() ?? null;
}
