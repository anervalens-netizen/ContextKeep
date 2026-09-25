import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { ReviewDecisionInput, TaskStatus, RecordType } from "@contextkeep/shared";
import { projects, records } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { parseWith } from "../lib/validate.js";
import { decideReview, editRecord, type DecideInput } from "../services/review.js";
import { attachProjectNames, loadEvidenceFor } from "../services/mappers.js";
import { z } from "zod";

const InboxQuery = z.object({
  projectId: z.string().nullish(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

const RecordEditInput = z.object({
  revision: z.number().int(),
  text: z.string().min(1).max(8000).optional(),
  subject: z.string().min(1).max(400).optional(),
  type: RecordType.optional(),
  projectId: z.string().nullable().optional(),
  taskStatus: TaskStatus.nullable().optional(),
});

export function registerInboxRoutes(app: FastifyInstance): void {
  const { deps } = app.ck;

  app.get("/api/inbox", async (request) => {
    const q = parseWith(InboxQuery, request.query, "inbox query");
    const where = q.projectId
      ? and(eq(records.reviewStatus, "proposed"), eq(records.projectId, q.projectId))
      : eq(records.reviewStatus, "proposed");
    const rows = deps.db
      .select()
      .from(records)
      .where(where)
      .orderBy(desc(records.createdAt))
      .limit(q.limit)
      .offset(q.offset)
      .all();
    const total = (
      deps.db
        .select({ n: sql<number>`count(*)` })
        .from(records)
        .where(where)
        .get() as { n: number } | undefined
    )?.n ?? 0;
    const evidence = loadEvidenceFor(deps.db, rows.map((r) => r.id));
    const candidates = attachProjectNames(deps.db, rows, evidence);

    const grouped = deps.db
      .select({ projectId: records.projectId, n: sql<number>`count(*)` })
      .from(records)
      .where(eq(records.reviewStatus, "proposed"))
      .groupBy(records.projectId)
      .all();
    const projectRows = deps.db.select({ id: projects.id, name: projects.name }).from(projects).all();
    const names = new Map(projectRows.map((p) => [p.id, p.name]));
    const byProject = grouped.map((g) => ({
      projectId: g.projectId,
      projectName: g.projectId ? (names.get(g.projectId) ?? null) : null,
      count: g.n,
    }));

    return { candidates, total, byProject };
  });

  app.post("/api/inbox/decide", async (request) => {
    const body = request.body as Record<string, unknown>;
    if (!Array.isArray(body?.["items"]) && Array.isArray(body?.["recordIds"])) {
      throw new ApiError(
        409,
        "review_revision_required",
        "Review decisions now require the revision that was displayed for every record. Reload the inbox and decide again; no review was applied.",
      );
    }
    const base = parseWith(ReviewDecisionInput, body, "review decision");
    const input: DecideInput = { ...base, ownerAction: body?.["ownerAction"] === true };
    return decideReview(deps, input, { actor: request.ckActor, requestId: request.id });
  });

  app.put("/api/records/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseWith(RecordEditInput, request.body, "record edit");
    return editRecord(
      deps,
      id,
      {
        revision: input.revision,
        text: input.text,
        subject: input.subject,
        type: input.type,
        projectId: input.projectId,
        taskStatus: input.taskStatus,
      },
      { actor: request.ckActor, requestId: request.id },
    );
  });

  app.get("/api/records/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = deps.db.select().from(records).where(eq(records.id, id)).get();
    if (!row) {
      reply.code(404);
      return { error: { code: "record_not_found", message: `Record ${id} not found.`, details: null } };
    }
    const evidence = loadEvidenceFor(deps.db, [id]);
    return attachProjectNames(deps.db, [row], evidence)[0]!;
  });
}
