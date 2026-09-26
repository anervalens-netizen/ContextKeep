import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  HandoffExportInput,
  SearchQuery,
  SearchResultDto,
} from "@contextkeep/shared";
import {
  auditEvents,
  conflicts,
  sourceExcerpts,
  sources,
} from "../db/schema.js";
import { parseWith } from "../lib/validate.js";
import { getHandoff, renderHandoff } from "../services/export.js";
import { buildPortableJsonDump } from "../services/portable-dump.js";
import { search } from "../services/search.js";
import { toSourceDto } from "../services/mappers.js";
import {
  sourceProjectIds,
  sourceProjectScope,
} from "../services/source-membership.js";
import {
  decodeExcerptCursor,
  encodeReadCursor,
  type ExcerptReadCursor,
} from "../services/bounded-read.js";
import { z } from "zod";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  projectId: z.string().nullish(),
});

const SourceExcerptQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1024).optional(),
});

export function registerSearchExportRoutes(app: FastifyInstance): void {
  const { deps } = app.ck;

  app.get("/api/search", async (request) => {
    const q = parseWith(SearchQuery, request.query, "search query");
    return SearchResultDto.parse(
      search(deps, {
        q: q.q,
        mode: q.mode,
        match: q.match,
        scope: q.scope,
        projectId: q.projectId,
        includeHistorical: q.includeHistorical,
        limit: q.limit,
      }),
    );
  });

  app.post("/api/handoffs", async (request, reply) => {
    const input = parseWith(
      HandoffExportInput,
      request.body,
      "handoff payload",
    );
    const dto = renderHandoff(deps, input, {
      actor: request.ckActor,
      requestId: request.id,
    });
    reply.code(201);
    return dto;
  });

  app.get("/api/handoffs/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getHandoff(deps, id);
  });

  app.get("/api/handoffs/:id/markdown", async (request, reply) => {
    const { id } = request.params as { id: string };
    const dto = getHandoff(deps, id);
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header(
      "content-disposition",
      `attachment; filename="contextkeep-handoff-${id.slice(0, 8)}.md"`,
    );
    return dto.markdown;
  });

  app.get("/api/export/json", async (request) => {
    return buildPortableJsonDump(deps, {
      actor: request.ckActor,
      requestId: request.id,
    });
  });

  app.get("/api/sources", async (request) => {
    const q = parseWith(ListQuery, request.query, "sources query");
    const rows = deps.db
      .select()
      .from(sources)
      .where(q.projectId ? sourceProjectScope(q.projectId) : undefined)
      .orderBy(desc(sources.importedAt))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    const counts =
      rows.length === 0
        ? []
        : deps.db
            .select({
              sourceId: sourceExcerpts.sourceId,
              n: sql<number>`count(*)`,
            })
            .from(sourceExcerpts)
            .where(
              inArray(
                sourceExcerpts.sourceId,
                rows.map((row) => row.id),
              ),
            )
            .groupBy(sourceExcerpts.sourceId)
            .all();
    const countBySource = new Map(
      counts.map((row) => [row.sourceId, Number(row.n)]),
    );
    return rows.map((r) => toSourceDto(r, countBySource.get(r.id) ?? 0));
  });

  app.get("/api/sources/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = deps.db.select().from(sources).where(eq(sources.id, id)).get();
    if (!row) {
      reply.code(404);
      return {
        error: {
          code: "source_not_found",
          message: `Source ${id} not found.`,
          details: null,
        },
      };
    }
    const rawQuery = request.query as Record<string, unknown>;
    const paginated =
      rawQuery.limit !== undefined || rawQuery.cursor !== undefined;
    const query = paginated
      ? parseWith(SourceExcerptQuery, rawQuery, "source excerpts query")
      : undefined;
    const cursor =
      query?.cursor === undefined
        ? undefined
        : decodeExcerptCursor(query.cursor, id);
    if (cursor && cursor.normalizedHash !== row.normalizedHash) {
      reply.code(409);
      return {
        error: {
          code: "source_excerpt_snapshot_changed",
          message:
            "Source excerpts changed while this page was being read; restart from the first page.",
          details: { sourceId: id },
        },
      };
    }
    const excerptWhere = and(
      eq(sourceExcerpts.sourceId, id),
      cursor
        ? or(
            gt(sourceExcerpts.startOffset, cursor.startOffset),
            and(
              eq(sourceExcerpts.startOffset, cursor.startOffset),
              gt(sourceExcerpts.id, cursor.excerptId),
            ),
          )
        : undefined,
    );
    const total = paginated
      ? Number(
          deps.db
            .select({ count: sql<number>`count(*)` })
            .from(sourceExcerpts)
            .where(eq(sourceExcerpts.sourceId, id))
            .get()?.count ?? 0,
        )
      : undefined;
    const excerptQuery = deps.db
      .select()
      .from(sourceExcerpts)
      .where(excerptWhere)
      .orderBy(asc(sourceExcerpts.startOffset), asc(sourceExcerpts.id));
    const allExcerpts = paginated
      ? excerptQuery.limit((query?.limit ?? 50) + 1).all()
      : excerptQuery.all();
    const excerpts = paginated
      ? allExcerpts.slice(0, query!.limit)
      : allExcerpts;
    const hasNext = paginated && allExcerpts.length > excerpts.length;
    const last = excerpts.at(-1);
    return {
      source: toSourceDto(row, total ?? excerpts.length),
      projectIds: sourceProjectIds(deps, row.id),
      excerpts: excerpts.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        startOffset: e.startOffset,
        endOffset: e.endOffset,
        text: e.exactText,
        exactTextHash: e.exactTextHash,
      })),
      ...(paginated
        ? {
            pagination: {
              limit: query!.limit,
              total: total ?? excerpts.length,
              returned: excerpts.length,
              hasNext,
              nextCursor:
                hasNext && last
                  ? encodeReadCursor({
                      version: 1,
                      kind: "source_excerpts",
                      sourceId: id,
                      normalizedHash: row.normalizedHash,
                      startOffset: last.startOffset,
                      excerptId: last.id,
                    } satisfies ExcerptReadCursor)
                  : null,
              snapshotNormalizedHash: row.normalizedHash,
            },
          }
        : {}),
    };
  });

  app.get("/api/audit", async (request) => {
    const q = parseWith(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        action: z.string().nullish(),
      }),
      request.query,
      "audit query",
    );
    const rows = deps.db
      .select()
      .from(auditEvents)
      .where(q.action ? eq(auditEvents.action, q.action) : undefined)
      .orderBy(desc(auditEvents.timestamp), auditEvents.id)
      .limit(q.limit)
      .all();
    return rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      timestamp: r.timestamp,
      beforeRef: r.beforeRef,
      afterRef: r.afterRef,
      detail: r.detailJson === null ? null : JSON.parse(r.detailJson),
    }));
  });

  app.get("/api/conflicts", async (request) => {
    const q = parseWith(
      z.object({ status: z.string().nullish() }),
      request.query,
      "conflicts query",
    );
    const rows = deps.db
      .select()
      .from(conflicts)
      .where(q.status ? eq(conflicts.status, q.status) : undefined)
      .all();
    return rows.map((c) => ({
      id: c.id,
      projectId: c.projectId,
      recordIds: JSON.parse(c.recordIdsJson) as string[],
      status: c.status,
      resolutionRecordId: c.resolutionRecordId,
      createdAt: c.createdAt,
    }));
  });
}
