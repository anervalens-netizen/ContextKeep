import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projects } from "../db/schema.js";
import { writeContextCursorSnapshot } from "./context-journal.js";

/** Increment canonical project content independently from metadata revision. */
export function bumpProjectContentVersion(db: Db, projectIds: Iterable<string | null | undefined>): void {
  for (const projectId of new Set([...projectIds].filter((id): id is string => Boolean(id)))) {
    db.update(projects)
      .set({ contentVersion: sql`${projects.contentVersion} + 1` })
      .where(eq(projects.id, projectId))
      .run();
    const project = db
      .select({ contentVersion: projects.contentVersion })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (project) writeContextCursorSnapshot(db, projectId, "canonical", project.contentVersion);
  }
}

/** Increment working-memory freshness without changing canonical content. */
export function bumpProjectWorkingMemoryVersion(db: Db, projectIds: Iterable<string | null | undefined>): void {
  for (const projectId of new Set([...projectIds].filter((id): id is string => Boolean(id)))) {
    db.update(projects)
      .set({ workingMemoryVersion: sql`${projects.workingMemoryVersion} + 1` })
      .where(eq(projects.id, projectId))
      .run();
    const project = db
      .select({ workingMemoryVersion: projects.workingMemoryVersion })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get();
    if (project) writeContextCursorSnapshot(db, projectId, "working", project.workingMemoryVersion);
  }
}
