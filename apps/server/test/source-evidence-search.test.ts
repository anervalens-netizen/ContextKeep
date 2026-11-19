import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/lib/hash.js";
import { projects, sourceExcerpts, sources } from "../src/db/schema.js";
import { makeTestApp, type TestApp } from "./helpers.js";
import { closeSourceEvidenceIndexes } from "../src/services/source-evidence-search.js";

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
        kind: "paste",
        title,
        normalizedText: text,
        originalText: text,
        normalizedHash: sha256(text),
        contentHash: sha256(text),
        projectId: scope,
        importedAt: date,
        provenanceBasis: "uploader_metadata",
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
        offset: 0,
        maxChars: 1,
        excerptOffset: 0,
        excerptLimit: 1,
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

  it("keeps single-character words and digits in exact source phrases", async () => {
    const { projectId, call, add } = await fixture();
    const expected = add("Synthetic run marker", "Release 2 is ready.");
    add("Synthetic distractor", "Release is ready.");
    const result = await call("search_source_evidence", {
      projectId,
      q: "Release 2 is ready",
      match: "phrase",
    });
    expect(
      result.structuredContent.results.map(
        (hit: { sourceId: string }) => hit.sourceId,
      ),
    ).toEqual([expected.sourceId]);
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
      detailArgs: {
        representation: "normalized",
        offset: 0,
        maxChars: 6000,
        excerptOffset: 0,
        excerptLimit: 5,
      },
    });
    expect(
      (await call("get_source", hit.detailArgs)).structuredContent.title,
    ).toBe(title);
  });

  it("labels malformed spans without emitting them or hiding valid source evidence", async () => {
    const { app, projectId, call, add } = await fixture();
    const malformed = add(
      "Synthetic malformed offset",
      "🌿 Missing span marker.",
      projectId,
      1,
    );
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
    const direct = await call("get_source", {
      projectId,
      sourceId: malformed.sourceId,
    });
    expect(direct.structuredContent.excerpts).toEqual(expect.arrayContaining([
      expect.objectContaining({ startOffset: 0, endOffset: 0, text: "", textTruncated: true, unavailableReason: "invalid_normalized_utf16_span" }),
    ]));
    app.app.ck.deps.sqlite.prepare("UPDATE source_excerpts SET start_offset = -1 WHERE source_id = ?").run(malformed.sourceId);
    const negative = await call("get_source", { projectId, sourceId: malformed.sourceId });
    expect(negative.structuredContent.text).toBe("🌿 Missing span marker.");
    expect(negative.structuredContent.excerpts).toEqual(direct.structuredContent.excerpts);
  });
  it("keeps owner detail and browser discovery usable across malformed cursor positions", async () => {
    const { app, projectId, call, add } = await fixture();
    const text = "🌿 synthetic route marker";
    const { sourceId, excerptId } = add("Synthetic cursor", text);
    const db = app.app.ck.deps.sqlite;
    const insert = db.prepare(
      "INSERT INTO source_excerpts(id,source_id,start_offset,end_offset,exact_text,exact_text_hash) VALUES(?,?,?,?,?,?)",
    );
    const corruptIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, offset] of [-1, 2.5, "invalid"].entries()) {
      insert.run(corruptIds[index], sourceId, offset, text.length, "synthetic route marker", "legacy-hash");
    }
    const before = db.prepare("SELECT total_changes() AS total").get();
    const url = "/api/sources/" + sourceId + "?limit=1";
    const first = (await app.get(url)).json<any>();
    expect(first.excerptOffsetUnit).toBe("normalized_utf16");
    expect(first.excerpts[0]).toMatchObject({
      id: corruptIds[0], startOffset: 0, endOffset: 0, text: "",
      unavailableReason: "invalid_normalized_utf16_span",
    });
    expect(first.pagination).toMatchObject({ hasNext: true, total: 4 });
    const pages = [first.excerpts[0]];
    let cursor = first.pagination.nextCursor;
    while (cursor && pages.length < 6) {
      const response = await app.get(url + "&cursor=" + encodeURIComponent(cursor));
      expect(response.statusCode).toBe(200);
      const body = response.json<any>();
      pages.push(body.excerpts[0]);
      cursor = body.pagination.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(pages.map((row) => row.id))).toEqual(new Set([excerptId, ...corruptIds]));
    expect(pages.find((row) => row.id === excerptId)).toMatchObject({ text, startOffset: 0, endOffset: text.length });
    const mcp = (await call("get_source", { projectId, sourceId })).structuredContent;
    expect(mcp.excerpts.find((row: { id: string }) => row.id === corruptIds[0])).toMatchObject({
      id: corruptIds[0], startOffset: 0, endOffset: 0, text: "",
      unavailableReason: "invalid_normalized_utf16_span",
    });
    const searchResponse = await app.get("/api/search?" + new URLSearchParams({ q: "synthetic route marker", projectId, mode: "discovery" }));
    expect(searchResponse.statusCode).toBe(200);
    const search = searchResponse.json<any>();
    expect(search.sources[0].matchedExcerpts.find((row: { id: string }) => row.id === corruptIds[0])).toMatchObject({
      text: "", unavailableReason: "invalid_normalized_utf16_span",
    });
    expect(db.prepare("SELECT total_changes() AS total").get()).toEqual(before);
    const external = new Database(app.config.dbPath);
    try {
      external.prepare("UPDATE sources SET normalized_text = ? WHERE id = ?").run("🌿 changed source content", sourceId);
      const changed = await app.get(url + "&cursor=" + encodeURIComponent(first.pagination.nextCursor));
      expect(changed.statusCode).toBe(409);
      expect(changed.json<any>().error.code).toBe("source_excerpt_snapshot_changed");
    } finally {
      external.close();
    }
  });

  it("upgrades a legacy source cursor after its compatible first continuation", async () => {
    const { app, add } = await fixture();
    const text = "synthetic legacy cursor";
    const { sourceId, excerptId } = add("Synthetic legacy", text);
    const db = app.app.ck.deps.sqlite;
    const insert = db.prepare(
      "INSERT INTO source_excerpts(id,source_id,start_offset,end_offset,exact_text,exact_text_hash) VALUES(?,?,?,?,?,?)",
    );
    const following = [randomUUID(), randomUUID()];
    insert.run(following[0], sourceId, 2, text.length, text.slice(2), "h1");
    insert.run(following[1], sourceId, 3, text.length, text.slice(3), "h2");
    const oldFingerprint = createHash("sha256");
    for (const row of db.prepare("SELECT id,start_offset,end_offset,exact_text_hash,length(exact_text) AS size FROM source_excerpts WHERE source_id=? ORDER BY start_offset,id").all(sourceId) as Record<string, unknown>[])
      oldFingerprint.update(JSON.stringify([row.id, row.start_offset, row.end_offset, row.exact_text_hash, row.size]) + "\n");
    const v1 = Buffer.from(JSON.stringify({
      version: 1, kind: "source_excerpts", sourceId, startOffset: 0,
      excerptId, normalizedHash: oldFingerprint.digest("hex"),
    })).toString("base64url");
    const url = "/api/sources/" + sourceId + "?limit=1&cursor=";
    const second = (await app.get(url + v1)).json<any>();
    expect(second.excerpts[0].id).toBe(following[0]);
    const upgraded = JSON.parse(Buffer.from(second.pagination.nextCursor, "base64url").toString("utf8"));
    expect(upgraded).toMatchObject({
      version: 2, excerptId: following[0], normalizedHash: second.pagination.snapshotExcerptFingerprint,
    });
    const last = (await app.get(url + second.pagination.nextCursor)).json<any>();
    expect(last.excerpts[0].id).toBe(following[1]);
    expect(last.pagination.nextCursor).toBeNull();
  });

  it("rebuilds a discarded derived index and drops replaced or deleted source text", async () => {
    const { app, projectId, call, add } = await fixture();
    const { sourceId, excerptId } = add("Synthetic rebuild", "synthetic alpha");
    const read = async (q: string, expectedIndexVersion?: string) =>
      (await call("search_source_evidence", { projectId, q, match: "phrase", expectedIndexVersion })).structuredContent;
    const sqlite = app.app.ck.deps.sqlite;
    const old = await read("alpha");
    expect(old.results[0].excerpt.id).toBe(excerptId);
    const external = new Database(app.config.dbPath);
    try {
      external.prepare("UPDATE sources SET normalized_text = ? WHERE id = ?").run("synthetic omega", sourceId);
      expect((await read("alpha", old.indexVersion)).error.code).toBe("source_discovery_index_changed");
      expect((await read("alpha")).results).toEqual([]);
      const updated = await read("omega");
      expect(updated.results[0].excerpt).toMatchObject({ id: excerptId, text: "synthetic omega" });
      const before = sqlite.prepare("SELECT total_changes() AS changes").get();
      closeSourceEvidenceIndexes(sqlite);
      const rebuilt = await read("omega");
      expect(rebuilt).toEqual(updated);
      expect(sqlite.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      external.prepare("DELETE FROM source_excerpts WHERE id = ?").run(excerptId);
      expect((await read("omega", rebuilt.indexVersion)).error.code).toBe("source_discovery_index_changed");
      expect((await read("omega")).results).toEqual([]);
      expect(sqlite.prepare("SELECT id FROM sources WHERE id = ?").get(sourceId)).toEqual({ id: sourceId });
    } finally {
      external.close();
    }
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
