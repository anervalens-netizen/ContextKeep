import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/lib/hash.js";
import { projects, sourceExcerpts, sources } from "../src/db/schema.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const token = randomUUID();
const date = "2026-05-10T00:00:00.000Z";
const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
});

async function fixture() {
  const app = await makeTestApp({ adapters: "manual", mcpToken: token });
  apps.push(app);
  const { db } = app.app.ck.deps;
  const [projectId, otherProject] = [randomUUID(), randomUUID()];
  db.insert(projects)
    .values([
      {
        id: projectId,
        name: "Synthetic source project",
        createdAt: date,
        updatedAt: date,
      },
      {
        id: otherProject,
        name: "Other synthetic project",
        createdAt: date,
        updatedAt: date,
      },
    ])
    .run();
  function add(title: string, text: string, scope = projectId, offset = 0) {
    const sourceId = randomUUID(),
      excerptId = randomUUID();
    const selected = text.slice(offset);
    db.insert(sources)
      .values({
        id: sourceId,
        kind: "manual",
        title,
        normalizedText: text,
        originalText: text,
        normalizedHash: sha256(text),
        contentHash: sha256(text),
        projectId: scope,
        importedAt: date,
        provenanceBasis: "document",
      })
      .run();
    db.insert(sourceExcerpts)
      .values({
        id: excerptId,
        sourceId,
        startOffset: offset,
        endOffset: text.length,
        exactText: selected,
        exactTextHash: sha256(selected),
      })
      .run();
    return { sourceId, excerptId };
  }
  async function call(name: string, args: Record<string, unknown>) {
    const response = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer " + token,
        accept: "application/json, text/event-stream",
      },
      payload: {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json().result;
  }
  return { app, projectId, otherProject, call, add };
}

describe("project source evidence discovery", () => {
  it("finds source-only evidence by terms, keeps it separate, and restores exactly the advertised redacted span", async () => {
    const { app, projectId, otherProject, call, add } = await fixture();
    const prefix = "🔵 Séparé e\u0301. ";
    const paragraph =
      "Recuperare temporară pentru un obiect azur. 🔵 Secret " +
      token +
      " nu este dovadă de identitate.";
    const own = add(
      "Procedură sintetică",
      prefix + paragraph,
      projectId,
      prefix.length,
    );
    add("Dovadă din alt proiect", paragraph + " în altă zonă.", otherProject);
    const sqlite = app.app.ck.deps.sqlite;
    const initial = sqlite.prepare("select total_changes() n").get();

    const result = await call("search_source_evidence", {
      projectId,
      q: "recuperare azur",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      canonicalTruth: false,
      indexVersion: expect.any(String),
      indexedSources: 1,
      indexedExcerpts: 1,
      invalidExcerpts: 0,
      offsetUnit: "utf16",
      representation: "normalized_redacted",
      nextOffset: null,
    });
    const hit = result.structuredContent.results[0];
    expect(hit).toMatchObject({
      kind: "source_evidence",
      sourceId: own.sourceId,
      excerpt: {
        id: own.excerptId,
        startOffset: prefix.length,
        endOffset: prefix.length + paragraph.length,
        deliveredEndOffset: prefix.length + paragraph.length,
      },
      detailArgs: {
        sourceId: own.sourceId,
        projectId,
        representation: "normalized",
      },
    });
    expect(hit.excerpt.text).toContain("🔵");
    expect(hit.excerpt.text).toContain("*".repeat(token.length));
    expect(JSON.stringify(result)).not.toContain(token);
    const source = await call("get_source", hit.detailArgs);
    expect(source.structuredContent.excerpts).toMatchObject([
      { id: own.excerptId, text: hit.excerpt.text },
    ]);
    expect(
      (
        await call("search_source_evidence", {
          projectId,
          q: token,
          match: "phrase",
        })
      ).structuredContent.results,
    ).toEqual([]);
    expect(
      (
        await call("search_source_evidence", {
          projectId,
          q: "recuperare azur",
          match: "phrase",
        })
      ).structuredContent.results,
    ).toEqual([]);
    expect(
      (await call("search_context", { projectId, q: "recuperare azur" }))
        .structuredContent.records,
    ).toEqual([]);
    expect(sqlite.prepare("select total_changes() n").get()).toEqual(initial);
  });

  it("version-fences result pages, supports title-only results, and invalidates on an external commit", async () => {
    const { app, projectId, call, add } = await fixture();
    const { sourceId } = add(
      "Crimson comet",
      "Only a synthetic stored paragraph.",
    );
    add("An alternate Crimson comet", "A second synthetic stored paragraph.");
    const args = { projectId, q: "crimson comet", limit: 1 };
    const first = (await call("search_source_evidence", args))
      .structuredContent;
    expect(first).toMatchObject({
      nextOffset: 1,
      mayHaveMore: true,
      results: [{ kind: "source_evidence", excerpt: null }],
    });
    expect(
      (await call("search_source_evidence", { ...args, offset: 1 }))
        .structuredContent.error.code,
    ).toBe("source_discovery_version_required");
    const remaining = await call("search_source_evidence", {
      ...args,
      offset: 1,
      expectedIndexVersion: first.indexVersion,
    });
    expect(remaining.structuredContent.results[0].sourceId).not.toBe(
      first.results[0].sourceId,
    );
    const external = new Database(app.config.dbPath);
    try {
      external
        .prepare("UPDATE sources SET title=? WHERE id=?")
        .run("Changed synthetic title", sourceId);
    } finally {
      external.close();
    }
    const stale = await call("search_source_evidence", {
      ...args,
      offset: 1,
      expectedIndexVersion: first.indexVersion,
    });
    expect(stale.structuredContent.error.code).toBe(
      "source_discovery_index_changed",
    );
    const current = (await call("search_source_evidence", args))
      .structuredContent;
    expect(
      current.results.map((item: { sourceId: string }) => item.sourceId),
    ).not.toContain(sourceId);
  });

  it("marks a truncated title when the matching word falls beyond its preview", async () => {
    const { projectId, call, add } = await fixture();
    const title = "◇".repeat(240) + " suffixbeacon";
    const { sourceId } = add(title, "An unrelated synthetic description.");
    const result = await call("search_source_evidence", {
      projectId,
      q: "suffixbeacon",
    });
    const hit = result.structuredContent.results[0];
    expect(hit).toMatchObject({
      sourceId,
      title: "◇".repeat(240),
      titleTruncated: true,
      excerpt: null,
    });
    expect(
      (await call("get_source", hit.detailArgs)).structuredContent.title,
    ).toBe(title);
  });

  it("labels malformed spans without emitting them or hiding valid source evidence", async () => {
    const { projectId, call, add } = await fixture();
    add("Synthetic malformed offset", "🌿 Missing span marker.", projectId, 1);
    const valid = add("Synthetic pointer", "A visible span marker.");
    const page = (
      await call("search_source_evidence", {
        projectId,
        q: "span marker",
        match: "phrase",
      })
    ).structuredContent;
    expect(page).toMatchObject({
      invalidExcerpts: 1,
      indexedExcerpts: 1,
      results: [{ sourceId: valid.sourceId }],
    });
  });
  it("refuses a scope beyond the predeclared excerpt input bound", async () => {
    const { app, projectId, call, add } = await fixture();
    const text = "One bounded synthetic excerpt.";
    const { sourceId } = add("A bounded fixture", text);
    const insert = app.app.ck.deps.sqlite.prepare(
      "INSERT INTO source_excerpts VALUES(?,?,?,?,?,?)",
    );
    app.app.ck.deps.sqlite.transaction(() => {
      for (let i = 0; i < 6_000; i++)
        insert.run(randomUUID(), sourceId, 0, text.length, text, sha256(text));
    })();
    const result = await call("search_source_evidence", {
      projectId,
      q: "bounded",
    });
    expect(result.structuredContent.error).toMatchObject({
      code: "source_discovery_scope_too_large",
      retryable: false,
    });
  });
});
