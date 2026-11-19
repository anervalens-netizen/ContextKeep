import { SOURCE_READ_DEFAULTS } from "./evidence-read-defaults.js";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { ApiError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { sources } from "../db/schema.js";
import { sourceEvidenceVersions } from "./evidence-versions.js";
import type { ServiceDeps } from "./import.js";
import { foldMemoryText } from "./memory-freshness.js";
import { safeText } from "./redaction.js";
import { buildFtsMatchExpr, buildSearchProfile } from "./search.js";
import { sourceProjectScope } from "./source-membership.js";
import { isUtf16ExcerptSpan, sliceUtf16Excerpt } from "./source-offsets.js";

const SOURCE_LIMIT = 2_000;
const EXCERPT_LIMIT = 6_000;
const RAW_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_OFFSET = 1_000;
const MAX_CACHE_ENTRIES = 2;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const SNIPPET_CODE_POINTS = 320;

type Source = {
  id: string;
  title: string;
  importedAt: string;
  eventAt: string | null;
  provenanceBasis: string;
};
type Excerpt = {
  id: string;
  sourceId: string;
  startOffset: number;
  endOffset: number;
  ordinal: number;
};
type Index = {
  stamp: string;
  version: string;
  fts: Database.Database;
  sources: Map<string, Source>;
  excerpts: Map<string, Excerpt>;
  invalidExcerpts: number;
};
type Input = {
  projectId: string;
  q: string;
  match: "terms" | "phrase";
  limit: number;
  offset: number;
  expectedIndexVersion?: string;
};

const cachedIndexes = new WeakMap<ServiceDeps["sqlite"], Map<string, Index>>();

export function closeSourceEvidenceIndexes(sqlite: ServiceDeps["sqlite"]) {
  const indexes = cachedIndexes.get(sqlite);
  cachedIndexes.delete(sqlite);
  for (const index of indexes?.values() ?? []) index.fts.close();
}

function scopeTooLarge() {
  return new ApiError(
    422,
    "source_discovery_scope_too_large",
    "This project exceeds the source discovery index budget. Use list_sources and get_source to inspect individual sources.",
  );
}

function readIndexInputs(
  deps: ServiceDeps,
  projectId: string,
  redactionVersion: string,
) {
  const scoped = deps.db
    .select({
      id: sources.id,
      title: sources.title,
      importedAt: sources.importedAt,
      eventAt: sources.eventAt,
      provenanceBasis: sources.provenanceBasis,
      // Keep search page versions and version-fenced detail recovery aligned.
      assignedProjectId: sources.projectId,
      authorLabel: sources.authorLabel,
      kind: sources.kind,
      contentHash: sources.contentHash,
      normalizedHash: sources.normalizedHash,
      bytes: sql<number>`length(cast(${sources.normalizedText} as blob))`,
      titleBytes: sql<number>`coalesce(length(cast(${sources.title} as blob)), 0)`,
    })
    .from(sources)
    .where(sourceProjectScope(projectId))
    .orderBy(sources.id)
    .limit(SOURCE_LIMIT + 1)
    .all();
  if (
    scoped.length > SOURCE_LIMIT ||
    scoped.reduce((sum, row) => sum + row.bytes + row.titleBytes, 0) >
      RAW_TEXT_BYTES
  )
    throw scopeTooLarge();

  const spans = deps.sqlite
    .prepare(
      `
    SELECT e.id, e.source_id AS sourceId, e.start_offset AS startOffset, e.end_offset AS endOffset,
           e.exact_text_hash AS exactTextHash
    FROM json_each(?) ids JOIN source_excerpts e ON e.source_id=ids.value
    ORDER BY e.source_id, e.start_offset, e.id LIMIT ?
  `,
    )
    .all(
      JSON.stringify(scoped.map((row) => row.id)),
      EXCERPT_LIMIT + 1,
    ) as Array<Omit<Excerpt, "ordinal"> & { exactTextHash: string }>;
  if (spans.length > EXCERPT_LIMIT) throw scopeTooLarge();

  const texts = deps.sqlite
    .prepare(
      `
    SELECT s.id,s.normalized_text AS text
    FROM json_each(?) ids JOIN sources s ON s.id=ids.value ORDER BY s.id
  `,
    )
    .all(JSON.stringify(scoped.map((row) => row.id))) as Array<{
    id: string;
    text: string;
  }>;
  // Verify the actual normalized text, not only a declared hash. This also
  // revalidates redaction after external updates and protects legacy rows.
  const version = sha256(
    JSON.stringify([
      projectId,
      redactionVersion,
      scoped,
      spans,
      texts.map(({ id, text }) => [id, sha256(text)]),
    ]),
  );
  return {
    scoped,
    spans,
    texts: new Map(texts.map(({ id, text }) => [id, text])),
    version,
  };
}

function buildIndex(
  { scoped, spans, texts, version }: ReturnType<typeof readIndexInputs>,
  stamp: string,
  secrets: string[],
): Index {
  const fts = new Database(":memory:");
  try {
    fts.exec(`CREATE VIRTUAL TABLE source_fts USING fts5(
      source_id UNINDEXED, excerpt_id UNINDEXED, title, body,
      tokenize='porter unicode61 remove_diacritics 2'
    )`);
    const add = fts.prepare(
      "INSERT INTO source_fts(source_id,excerpt_id,title,body) VALUES(?,?,?,?)",
    );
    const indexSources = new Map<string, Source>();
    const excerpts = new Map<string, Excerpt>();
    let cursor = 0;
    let indexedBytes = 0;
    let invalidExcerpts = 0;
    fts.transaction(() => {
      for (const {
        id,
        title,
        importedAt,
        eventAt,
        provenanceBasis,
      } of scoped) {
        const maskedTitle = safeText(title ?? "", secrets);
        indexSources.set(id, {
          id,
          title: maskedTitle,
          importedAt,
          eventAt,
          provenanceBasis,
        });
        if (maskedTitle) add.run(id, null, maskedTitle, "");
        const mask = safeText(texts.get(id)!, secrets, true);
        let ordinal = 0;
        while (cursor < spans.length && spans[cursor]!.sourceId === id) {
          const span = spans[cursor++]!;
          const start = span.startOffset,
            end = span.endOffset;
          const excerpt = {
            id: span.id,
            sourceId: span.sourceId,
            startOffset: start,
            endOffset: end,
            ordinal: ordinal++,
          };
          // Damaged legacy spans cannot alias unrelated text or split a surrogate pair.
          if (!isUtf16ExcerptSpan(mask, start, end)) {
            invalidExcerpts++;
            continue;
          }
          const body = mask.slice(start, end);
          indexedBytes += Buffer.byteLength(body);
          if (indexedBytes > RAW_TEXT_BYTES) throw scopeTooLarge();
          excerpts.set(excerpt.id, excerpt);
          add.run(id, excerpt.id, "", body);
        }
      }
    })();
    const pages = Number(fts.pragma("page_count", { simple: true }));
    const pageSize = Number(fts.pragma("page_size", { simple: true }));
    if (pages * pageSize > MAX_INDEX_BYTES) throw scopeTooLarge();
    return {
      stamp,
      version,
      fts,
      sources: indexSources,
      excerpts,
      invalidExcerpts,
    };
  } catch (error) {
    fts.close();
    throw error;
  }
}

export function searchSourceEvidence(
  deps: ServiceDeps,
  input: Input,
  secrets: string[],
) {
  return deps.sqlite.transaction(() => {
    if (input.offset > 0 && !input.expectedIndexVersion)
      throw new ApiError(
        422,
        "source_discovery_version_required",
        "Pass the preceding page's indexVersion to continue.",
      );
    if (
      !deps.sqlite
        .prepare("SELECT 1 FROM projects WHERE id=?")
        .get(input.projectId)
    )
      throw new ApiError(404, "project_not_found", "Project not found.");
    const profile = buildSearchProfile(input.q);
    // Phrase matching preserves short IDs and digits excluded by keyword search.
    if (input.match === "phrase")
      profile.rawTokens =
        foldMemoryText(input.q).match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!(input.match === "terms" ? profile.tokens : profile.rawTokens).length)
      throw new ApiError(
        422,
        "source_discovery_query_empty",
        "Provide searchable keywords or a phrase.",
      );
    const changes = (
      deps.sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
    const redactionVersion = sha256(JSON.stringify(secrets));
    const stamp = `${changes}:${deps.sqlite.pragma("data_version", { simple: true })}:${redactionVersion}`;
    let cache = cachedIndexes.get(deps.sqlite);
    if (!cache) {
      cache = new Map();
      cachedIndexes.set(deps.sqlite, cache);
    }
    let index = cache.get(input.projectId);
    if (index?.stamp !== stamp) {
      const inputs = readIndexInputs(deps, input.projectId, redactionVersion);
      if (index?.version === inputs.version) index.stamp = stamp;
      else {
        index?.fts.close();
        cache.delete(input.projectId);
        index = buildIndex(inputs, stamp, secrets);
      }
    }
    cache.delete(input.projectId);
    cache.set(input.projectId, index);
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value!;
      cache.get(oldest)!.fts.close();
      cache.delete(oldest);
    }
    if (
      input.expectedIndexVersion &&
      input.expectedIndexVersion !== index.version
    )
      throw new ApiError(
        409,
        "source_discovery_index_changed",
        "Restart source discovery from offset zero with the current index version.",
      );
    const hits = index.fts
      .prepare(
        `
      SELECT source_id AS sourceId, excerpt_id AS excerptId, body FROM source_fts
      WHERE source_fts MATCH ? ORDER BY bm25(source_fts,0,0,4,1),source_id,excerpt_id LIMIT ? OFFSET ?
    `,
      )
      .all(
        buildFtsMatchExpr(profile, input.match),
        input.limit + 1,
        input.offset,
      ) as Array<{ sourceId: string; excerptId: string | null; body: string }>;
    const visible = hits.slice(0, input.limit);
    const versions = sourceEvidenceVersions(
      deps,
      [...new Set(visible.map((hit) => hit.sourceId))],
      secrets,
    );
    const results = visible.map((hit) => {
      const source = index.sources.get(hit.sourceId)!;
      const title = sliceUtf16Excerpt(
        source.title,
        0,
        source.title.length,
        240,
      );
      const excerpt = hit.excerptId ? index.excerpts.get(hit.excerptId)! : null;
      const span = excerpt
        ? sliceUtf16Excerpt(hit.body, 0, hit.body.length, SNIPPET_CODE_POINTS)
        : null;
      const expectedVersion = versions.get(source.id)!.version;
      return {
        kind: "source_evidence" as const,
        sourceId: source.id,
        title: title.text,
        titleTruncated: title.textTruncated,
        provenance: source.provenanceBasis,
        importedAt: source.importedAt,
        eventAt: source.eventAt,
        excerpt:
          excerpt && span
            ? {
                id: excerpt.id,
                startOffset: excerpt.startOffset,
                endOffset: excerpt.endOffset,
                deliveredEndOffset:
                  excerpt.startOffset + span.deliveredEndOffset,
                text: span.text,
                textTruncated: span.textTruncated,
              }
            : null,
        detailArgs: {
          sourceId: source.id,
          projectId: input.projectId,
          ...SOURCE_READ_DEFAULTS,
          expectedVersion,
          ...(excerpt
            ? { maxChars: 1, excerptOffset: excerpt.ordinal, excerptLimit: 1 }
            : {}),
        },
      };
    });
    const mayHaveMore = hits.length > input.limit;
    const afterPage = input.offset + visible.length;
    return {
      projectId: input.projectId,
      canonicalTruth: false as const,
      indexVersion: index.version,
      offsetUnit: "utf16" as const,
      representation: "normalized_redacted" as const,
      indexedSources: index.sources.size,
      indexedExcerpts: index.excerpts.size,
      invalidExcerpts: index.invalidExcerpts,
      results,
      mayHaveMore,
      nextOffset: mayHaveMore && afterPage <= MAX_OFFSET ? afterPage : null,
    };
  })();
}
