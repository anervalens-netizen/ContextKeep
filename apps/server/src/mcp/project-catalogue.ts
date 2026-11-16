import { createHash, createHmac } from "node:crypto";
import { and, eq, like, or } from "drizzle-orm";
import type { LifecycleState } from "@contextkeep/shared";
import { projects } from "../db/schema.js";
import { SERVER_SCHEMA_VERSION } from "../db/schema-version.js";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps } from "../services/import.js";

export type CompactProjectCatalogueInput = {
  offset: number;
  limit: number;
  q?: string;
  lifecycle: "all" | LifecycleState;
  ifVersion?: string;
  expectedCatalogVersion?: string;
};

/**
 * The transport authenticates every call before this reader runs. Binding the
 * opaque versions to the configured credentials invalidates them on rotation;
 * possession of a version never grants access. Clients must also key their
 * cached pages by origin, authenticated context and exact request arguments.
 */
export function createProjectCatalogueReader(deps: ServiceDeps, secrets: string[]) {
  const key = createHash("sha256")
    .update(JSON.stringify(["contextkeep-project-catalogue", ...secrets]))
    .digest();
  const version = (kind: "catalogue" | "page", value: unknown) =>
    (kind === "catalogue" ? "pc1-" : "pp1-") + createHmac("sha256", key)
      .update(JSON.stringify({ kind, value }))
      .digest("hex");

  return (input: CompactProjectCatalogueInput) => {
    const where = and(
      input.q ? or(like(projects.name, "%" + input.q + "%"), like(projects.aliasesJson, "%" + input.q + "%")) : undefined,
      input.lifecycle === "all" ? undefined : eq(projects.lifecycle, input.lifecycle),
    );

    // One SELECT is one SQLite statement snapshot: count, ordering, version and
    // page all come from the same metadata rows. Do not read descriptions or
    // construct full DTOs, and do not bypass this real DB read on a cache hit.
    const rows = deps.db.select({
      id: projects.id,
      name: projects.name,
      aliasesJson: projects.aliasesJson,
      lifecycle: projects.lifecycle,
      revision: projects.revision,
      updatedAt: projects.updatedAt,
    }).from(projects).where(where).orderBy(projects.name, projects.id).all();

    const context = {
      catalogueSchemaVersion: 1,
      databaseSchemaVersion: SERVER_SCHEMA_VERSION,
      scope: "all" as const,
      projection: "compact" as const,
      q: input.q ?? null,
      lifecycle: input.lifecycle,
    };
    // Alias changes and equal-timestamp edits remain visible. This is a version
    // of catalogue metadata, not contentVersion, working memory or runtime
    // health; a periodic full semantic check remains the consumer's duty.
    const catalogVersion = version("catalogue", { ...context, rows });
    if (input.expectedCatalogVersion !== undefined && input.expectedCatalogVersion !== catalogVersion) {
      throw new ApiError(409, "project_catalogue_changed", "The project catalogue changed. Discard accumulated pages and restart at offset 0.");
    }

    const pageVersion = version("page", { ...context, catalogVersion, offset: input.offset, limit: input.limit });
    const total = rows.length;
    const metadata = {
      scope: context.scope,
      projection: context.projection,
      catalogVersion,
      pageVersion,
      total,
      offset: input.offset,
      limit: input.limit,
      nextOffset: input.offset + input.limit < total ? input.offset + input.limit : null,
    };
    if (input.ifVersion === pageVersion) return { ...metadata, notModified: true as const };

    return {
      ...metadata,
      notModified: false as const,
      projects: rows.slice(input.offset, input.offset + input.limit).map(({ id, name, lifecycle, revision, updatedAt }) =>
        ({ id, name, lifecycle, revision, updatedAt })),
    };
  };
}
