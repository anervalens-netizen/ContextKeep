import { and, eq, or, sql } from "drizzle-orm";
import { sources } from "../db/schema.js";
import type { ServiceDeps } from "./import.js";

/** Canonical source→project membership: direct assignment or proven workspace association. */
export function sourceProjectScope(projectId: string) {
  return or(
    eq(sources.projectId, projectId),
    sql`EXISTS (
      SELECT 1
      FROM source_origins so
      JOIN workspace_bindings wb ON wb.id = so.workspace_binding_id
      WHERE so.source_id = ${sources.id} AND wb.project_id = ${projectId}
    )`,
  )!;
}

export function sourceBelongsToProject(deps: ServiceDeps, sourceId: string, projectId: string): boolean {
  return deps.db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.id, sourceId), sourceProjectScope(projectId)))
    .get() !== undefined;
}
export function sourceProjectIds(deps: ServiceDeps, sourceId: string): string[] {
  const rows = deps.sqlite.prepare(`
    SELECT project_id AS projectId FROM sources WHERE id=? AND project_id IS NOT NULL
    UNION
    SELECT wb.project_id AS projectId
    FROM source_origins so
    JOIN workspace_bindings wb ON wb.id=so.workspace_binding_id
    WHERE so.source_id=? AND wb.project_id IS NOT NULL
    ORDER BY projectId
  `).all(sourceId, sourceId) as Array<{ projectId: string }>;
  return rows.map((row) => row.projectId);
}
