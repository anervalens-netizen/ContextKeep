import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { applyDump } from "../src/services/dump-import.js";
import { MCP_RESULT_BYTE_BUDGET } from "../src/mcp/safety.js";
import { makeTestApp, type TestApp } from "./helpers.js";

// Only generated credentials, fictional metadata and isolated SQLite fixtures.
const tracked: TestApp[] = [];
const STAMP = "2025-01-02T03:04:05.000Z";
const COMPACT_KEYS = ["id", "lifecycle", "name", "revision", "updatedAt"];
type Project = {
  id: string; name: string; aliases: string[]; parentId: string | null;
  description: string | null; lifecycle: string; lifecycleRecordId: string | null;
  revision: number; contentVersion: number; workingMemoryVersion: number;
  createdAt: string; updatedAt: string;
};
type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: any;
};
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

async function setup() {
  const t = await makeTestApp({ mcpToken: randomBytes(32).toString("hex") });
  tracked.push(t);
  return t;
}
function insert(t: TestApp, overrides: Partial<Project> = {}): Project {
  const row: Project = {
    id: randomUUID(), name: "Synthetic catalogue project", aliases: [],
    parentId: null, description: "Fictional project description", lifecycle: "unknown",
    lifecycleRecordId: null, revision: 1, contentVersion: 0, workingMemoryVersion: 0,
    createdAt: STAMP, updatedAt: STAMP, ...overrides,
  };
  t.app.ck.deps.sqlite.prepare(
    "INSERT INTO projects (id,name,aliases_json,parent_project_id,description,lifecycle,lifecycle_record_id,revision,content_version,working_memory_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(row.id, row.name, JSON.stringify(row.aliases), row.parentId, row.description,
    row.lifecycle, row.lifecycleRecordId, row.revision, row.contentVersion,
    row.workingMemoryVersion, row.createdAt, row.updatedAt);
  return row;
}
function many(t: TestApp, count: number, description = "Fictional metadata") {
  return Array.from({ length: count }, (_, index) => insert(t, {
    name: "Synthetic project " + String(index).padStart(3, "0"), description,
  }));
}
async function rpc(t: TestApp, method: string, params: unknown = {},
  headers: Record<string, string> = {
    authorization: "Bearer " + t.config.mcpToken,
    accept: "application/json, text/event-stream",
  }) {
  return t.app.inject({
    method: "POST", url: "/mcp", headers,
    payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
  });
}
async function tool(t: TestApp, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const response = await rpc(t, "tools/call", { name, arguments: args });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = response.json();
  expect(body.error).toBeUndefined();
  return body.result as Result;
}
async function ok(t: TestApp, name: string, args: Record<string, unknown> = {}) {
  const result = await tool(t, name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}
async function catalogue(t: TestApp, args: Record<string, unknown> = {}) {
  return ok(t, "list_projects", { projection: "compact", ...args });
}
function ids(body: { projects: Array<{ id: string }> }): string[] {
  return body.projects.map(project => project.id);
}
function byteSize(result: Result) {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
function counts(t: TestApp) {
  return ["records", "sources", "audit_events", "idempotency_requests", "workflow_runs"].map(table =>
    t.app.ck.deps.sqlite.prepare("SELECT count(*) AS n FROM " + table).get());
}
function expectRestart(result: Result) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent.error).toMatchObject({
    code: "project_catalogue_changed", retryable: false, resetRequired: true,
    nextAction: "restart_catalogue_from_first_page",
  });
  expect(result.structuredContent).not.toHaveProperty("projects");
  expect(result.structuredContent).not.toHaveProperty("notModified");
}
function dump(rows: Project[]) {
  return {
    format: "contextkeep.json_dump", version: 1,
    projects: rows.map(({ aliases, parentId, ...row }) => ({
      ...row, aliasesJson: JSON.stringify(aliases), parentProjectId: parentId,
    })),
    sources: [], sourceExcerpts: [], records: [], recordEvidence: [], supersessions: [],
  };
}

describe("ME-24 compact and conditional project catalogue", () => {
  it("preserves the legacy full, REST and panel contracts without writing memory", async () => {
    const t = await setup();
    const row = insert(t, { aliases: ["fictional-alias"], revision: 7, contentVersion: 3, workingMemoryVersion: 4 });
    const before = counts(t);
    const expected = { scope: "all", projects: [row], total: 1, offset: 0, limit: 50, nextOffset: null };
    expect(await ok(t, "list_projects")).toEqual(expected);
    expect(await ok(t, "list_projects", { projection: "full" })).toEqual(expected);
    const rest = await t.get("/api/projects");
    expect(rest.statusCode).toBe(200);
    expect(rest.json()).toEqual([row]);
    const panel = await ok(t, "panel_list_projects", { limit: 50 });
    expect(panel).toEqual({
      scope: "all", projection: "selector", projects: [{ id: row.id, name: row.name }],
      total: 1, offset: 0, limit: 50, nextOffset: null,
    });
    const first = await catalogue(t);
    await catalogue(t, { ifVersion: first.pageVersion });
    expect(counts(t)).toEqual(before);
  });

  it("returns exactly the compact identity fields and an explicit bodyless unchanged variant", async () => {
    const t = await setup();
    const row = insert(t);
    const first = await catalogue(t);
    expect(first).toMatchObject({
      scope: "all", projection: "compact", notModified: false,
      total: 1, offset: 0, limit: 50, nextOffset: null,
    });
    expect(first.projects).toEqual([{
      id: row.id, name: row.name, lifecycle: row.lifecycle, revision: row.revision, updatedAt: row.updatedAt,
    }]);
    expect(Object.keys(first.projects[0]).sort()).toEqual(COMPACT_KEYS);
    expect(typeof first.catalogVersion).toBe("string");
    expect(typeof first.pageVersion).toBe("string");
    expect(first.catalogVersion.length).toBeGreaterThan(32);
    expect(first.pageVersion.length).toBeGreaterThan(32);
    expect(await catalogue(t)).toEqual(first);
    const unchanged = await catalogue(t, {
      ifVersion: first.pageVersion, expectedCatalogVersion: first.catalogVersion,
    });
    const { projects: _projects, ...metadata } = first;
    expect(unchanged).toEqual({ ...metadata, notModified: true });
    expect(unchanged).not.toHaveProperty("projects");
    // A client without a cached body can omit ifVersion and obtain that body.
    expect(await catalogue(t)).toEqual(first);
  });

  it("enumerates more than fifty identities with stable versions and truthful empty pages", async () => {
    const t = await setup(), rows = many(t, 63);
    const seen: string[] = [], pageVersions = new Set<string>();
    let offset: number | null = 0, version: string | undefined;
    while (offset !== null) {
      const page = await catalogue(t, { offset, limit: 25, ...(version ? { expectedCatalogVersion: version } : {}) });
      version ??= page.catalogVersion;
      expect(page.catalogVersion).toBe(version);
      expect(page.offset).toBe(offset);
      expect(page.total).toBe(rows.length);
      expect(page.projects.length).toBe(Math.min(25, rows.length - offset));
      pageVersions.add(page.pageVersion);
      seen.push(...ids(page));
      offset = page.nextOffset;
    }
    expect(seen).toEqual(rows.map(row => row.id));
    expect(new Set(seen).size).toBe(rows.length);
    expect(pageVersions.size).toBe(3);
    const beyond = await catalogue(t, { offset: 100, limit: 25, expectedCatalogVersion: version });
    expect(beyond).toMatchObject({ total: 63, offset: 100, nextOffset: null, projects: [], notModified: false });
    const empty = await catalogue(t, { q: "No such fictional catalogue identity" });
    expect(empty).toMatchObject({ total: 0, nextOffset: null, projects: [], notModified: false });
    const unchanged = await catalogue(t, { q: "No such fictional catalogue identity", ifVersion: empty.pageVersion });
    expect(unchanged.notModified).toBe(true);
    expect(unchanged).not.toHaveProperty("projects");
  });

  it("refuses to combine pages after a rename crosses the pagination boundary", async () => {
    const t = await setup(), rows = many(t, 57);
    const first = await catalogue(t, { limit: 20 });
    const moved = rows[56]!;
    await ok(t, "update_project", {
      projectId: moved.id, revision: moved.revision, name: "AAA renamed synthetic project",
      idempotencyKey: randomUUID(),
    });
    const stale = await tool(t, "list_projects", {
      projection: "compact", offset: first.nextOffset, limit: 20,
      expectedCatalogVersion: first.catalogVersion,
    });
    expectRestart(stale);
    const restarted = await catalogue(t, { limit: 20 });
    expect(restarted.catalogVersion).not.toBe(first.catalogVersion);
    expect(restarted.projects[0].id).toBe(moved.id);
    const second = await catalogue(t, { limit: 20, offset: 20, expectedCatalogVersion: restarted.catalogVersion });
    const third = await catalogue(t, { limit: 20, offset: 40, expectedCatalogVersion: restarted.catalogVersion });
    const seen = [...ids(restarted), ...ids(second), ...ids(third)];
    expect(new Set(seen).size).toBe(57);
    expect(new Set(seen)).toEqual(new Set(rows.map(row => row.id)));
  });

  it("binds conditional versions to the query, lifecycle, page and page size", async () => {
    const t = await setup();
    many(t, 3).forEach(row => t.app.ck.deps.sqlite.prepare("UPDATE projects SET lifecycle='active' WHERE id=?").run(row.id));
    const first = await catalogue(t, { limit: 1 });
    for (const args of [
      { offset: 1, limit: 1 },
      { offset: 0, limit: 2 },
      { offset: 0, limit: 1, q: "%" },
      { offset: 0, limit: 1, lifecycle: "active" },
    ]) {
      const changedScope = await catalogue(t, { ...args, ifVersion: first.pageVersion });
      expect(changedScope.notModified).toBe(false);
      expect(changedScope).toHaveProperty("projects");
      expect(changedScope.pageVersion).not.toBe(first.pageVersion);
    }
    for (const args of [{ q: "%" }, { lifecycle: "active" }]) {
      expectRestart(await tool(t, "list_projects", {
        projection: "compact", limit: 1, ...args, expectedCatalogVersion: first.catalogVersion,
      }));
    }
    for (const ifVersion of ["unknown-version", "pp0-" + "0".repeat(64), first.catalogVersion]) {
      expect((await catalogue(t, { limit: 1, ifVersion })).notModified).toBe(false);
    }
    const normalized = await catalogue(t, { offset: 0, limit: 1, lifecycle: "all" });
    expect(normalized).toEqual(first);
  });

  it("preserves query matching and distinct identities when aliases and names are ambiguous", async () => {
    const t = await setup();
    const a = insert(t, { name: "Synthetic Atlas", aliases: ["shared-fictional-alias"] });
    const b = insert(t, { name: "synthetic atlas", aliases: ["shared-fictional-alias"] });
    insert(t, { name: "Synthetic Boreal", aliases: ["another-fictional-alias"] });
    const shared = await catalogue(t, { q: "shared-fictional-alias" });
    expect(new Set(ids(shared))).toEqual(new Set([a.id, b.id]));
    expect(shared.total).toBe(2);
    for (const q of ["SHARED-FICTIONAL-ALIAS", "atlas", "%", "_", "absent-value"]) {
      expect(ids(await catalogue(t, { q }))).toEqual(ids(await ok(t, "list_projects", { q })));
    }
    const rejected = await tool(t, "create_project", { name: a.name, idempotencyKey: randomUUID() });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent.error.code).toBe("project_name_exists");
    expect((await catalogue(t)).total).toBe(3);
  });

  it("detects alias and name changes even when timestamps and revisions are unchanged", async () => {
    const t = await setup(), row = insert(t, { aliases: ["former-alias"] });
    const before = await catalogue(t), filtered = await catalogue(t, { q: "former-alias" });
    // A restored/imported snapshot can preserve timestamps and revision numbers.
    t.app.ck.deps.sqlite.prepare("UPDATE projects SET aliases_json=? WHERE id=?")
      .run(JSON.stringify(["replacement-alias"]), row.id);
    const aliasChanged = await catalogue(t, { ifVersion: before.pageVersion });
    expect(aliasChanged.notModified).toBe(false);
    expect(aliasChanged.catalogVersion).not.toBe(before.catalogVersion);
    expect(aliasChanged.projects).toEqual(before.projects);
    expect((await catalogue(t, { q: "former-alias", ifVersion: filtered.pageVersion })).total).toBe(0);
    expect(ids(await catalogue(t, { q: "replacement-alias" }))).toEqual([row.id]);
    t.app.ck.deps.sqlite.prepare("UPDATE projects SET name=? WHERE id=?").run("Renamed synthetic snapshot", row.id);
    const renamed = await catalogue(t, { ifVersion: aliasChanged.pageVersion });
    expect(renamed.notModified).toBe(false);
    expect(renamed.projects[0]).toMatchObject({ revision: row.revision, updatedAt: STAMP, name: "Renamed synthetic snapshot" });
  });

  it("invalidates on normal create, metadata update and accepted lifecycle transitions", async () => {
    const t = await setup();
    const empty = await catalogue(t);
    const created = await ok(t, "create_project", { name: "Synthetic mutable project", idempotencyKey: randomUUID() });
    const first = await catalogue(t, { ifVersion: empty.pageVersion });
    expect(first.notModified).toBe(false);
    expect(ids(first)).toEqual([created.id]);
    const updated = await ok(t, "update_project", {
      projectId: created.id, revision: created.revision, aliases: ["new-identity-alias"],
      idempotencyKey: randomUUID(),
    });
    const second = await catalogue(t, { ifVersion: first.pageVersion });
    expect(second.notModified).toBe(false);
    expect(ids(await catalogue(t, { q: "new-identity-alias" }))).toEqual([created.id]);
    const activeBefore = await catalogue(t, { lifecycle: "active" });
    expect(activeBefore.total).toBe(0);
    await ok(t, "set_project_lifecycle", {
      projectId: created.id, revision: updated.revision, state: "active",
      reason: "Synthetic owner requested lifecycle transition.", idempotencyKey: randomUUID(),
    });
    const activeAfter = await catalogue(t, { lifecycle: "active", ifVersion: activeBefore.pageVersion });
    expect(activeAfter.notModified).toBe(false);
    expect(ids(activeAfter)).toEqual([created.id]);
    expect(activeAfter.projects[0].lifecycle).toBe("active");
  });

  it("selects every supported lifecycle and defaults to the complete catalogue", async () => {
    const t = await setup();
    const states = ["unknown", "planned", "active", "paused", "retired"];
    const rows = states.map(lifecycle => insert(t, { name: "Synthetic " + lifecycle, lifecycle }));
    const all = await catalogue(t);
    expect(all.total).toBe(5);
    expect(await catalogue(t, { lifecycle: "all" })).toEqual(all);
    for (const [index, lifecycle] of states.entries()) {
      const filtered = await catalogue(t, { lifecycle });
      expect(filtered.total).toBe(1);
      expect(ids(filtered)).toEqual([rows[index]!.id]);
      expect(filtered.projects[0].lifecycle).toBe(lifecycle);
    }
  });

  it("invalidates across dump import and restored snapshots, retaining legacy string IDs", async () => {
    const t = await setup();
    const original = insert(t, { id: "synthetic-legacy-project-id", name: "Synthetic legacy import" });
    const before = await catalogue(t);
    expect(ids(before)).toEqual([original.id]);
    const added = { ...original, id: randomUUID(), name: "Synthetic imported addition" };
    const imported = applyDump(t.app.ck.deps, { dump: dump([added]), mode: "merge", source: "synthetic-catalogue-test" }, { actor: "test:catalogue", requestId: null });
    expect(imported.accepted).toBe(1);
    expect(imported.blocked).toBe(0);
    const after = await catalogue(t, { ifVersion: before.pageVersion });
    expect(after.notModified).toBe(false);
    expect(after.total).toBe(2);
    const restored = applyDump(t.app.ck.deps, { dump: dump([original]), mode: "reset", source: "synthetic-catalogue-restore" }, { actor: "test:catalogue", requestId: null });
    expect(restored.blocked).toBe(0);
    const restoredPage = await catalogue(t, { ifVersion: after.pageVersion });
    expect(restoredPage.notModified).toBe(false);
    expect(restoredPage.projects).toEqual(before.projects);
    // A content version may return to the earlier value after identical restoration.
    expect(restoredPage.catalogVersion).toBe(before.catalogVersion);
    expectRestart(await tool(t, "list_projects", {
      projection: "compact", expectedCatalogVersion: after.catalogVersion,
    }));
  });

  it("does not interpret an unchanged identity catalogue as unchanged project memory", async () => {
    const t = await setup(), row = insert(t);
    const before = await catalogue(t);
    const fullBefore = await ok(t, "list_projects");
    await ok(t, "add_owner_note", {
      projectId: row.id, statement: "Synthetic evidence changes project memory independently of identity metadata.",
      idempotencyKey: randomUUID(),
    });
    const fullAfter = await ok(t, "list_projects");
    expect(fullAfter.projects[0].contentVersion).toBeGreaterThan(fullBefore.projects[0].contentVersion);
    const identities = await catalogue(t, { ifVersion: before.pageVersion });
    expect(identities.notModified).toBe(true);
    expect(identities).not.toHaveProperty("projects");
  });

  it("authenticates unchanged reads and rejects cookie, origin and wrong-bearer shortcuts", async () => {
    const t = await setup(); insert(t);
    const first = await catalogue(t);
    const params = { name: "list_projects", arguments: { projection: "compact", ifVersion: first.pageVersion } };
    for (const headers of [
      {}, { authorization: "Bearer invalid-synthetic-bearer" }, { cookie: t.cookie },
    ] as Array<Record<string, string>>) {
      const response = await rpc(t, "tools/call", params, headers);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(first.pageVersion);
    }
    const origin = await rpc(t, "tools/call", params, {
      authorization: "Bearer " + t.config.mcpToken,
      accept: "application/json, text/event-stream", origin: "https://untrusted.example",
    });
    expect(origin.statusCode).toBe(403);
    expect((await catalogue(t, { ifVersion: first.pageVersion })).notModified).toBe(true);
  });

  it("invalidates old catalogue tokens after bearer rotation on the same database", async () => {
    const t = await setup(); insert(t);
    const oldToken = t.config.mcpToken!, first = await catalogue(t);
    await t.app.close();
    const newToken = randomBytes(32).toString("hex");
    t.config.mcpToken = newToken;
    t.app = await buildApp({ config: t.config, logger: false });
    try {
      const oldAuth = await rpc(t, "tools/call", {
        name: "list_projects", arguments: { projection: "compact", ifVersion: first.pageVersion },
      }, { authorization: "Bearer " + oldToken, accept: "application/json, text/event-stream" });
      expect(oldAuth.statusCode).toBe(401);
      const after = await catalogue(t, { ifVersion: first.pageVersion });
      expect(after.notModified).toBe(false);
      expect(after.projects).toEqual(first.projects);
      expect(after.catalogVersion).not.toBe(first.catalogVersion);
      expect(after.pageVersion).not.toBe(first.pageVersion);
      expectRestart(await tool(t, "list_projects", {
        projection: "compact", expectedCatalogVersion: first.catalogVersion,
      }));
    } finally { await t.app.close(); }
  });

  it("reports database failure on a warm conditional request while MCP transport remains alive", async () => {
    const t = await setup(); insert(t);
    const first = await catalogue(t);
    const sqlite = t.app.ck.deps.sqlite;
    sqlite.exec("ALTER TABLE projects RENAME TO unavailable_catalogue_projects");
    try {
      const alive = await rpc(t, "initialize", {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "synthetic-catalogue-test", version: "1" },
      });
      expect(alive.statusCode).toBe(200);
      expect(alive.json().result.serverInfo.name).toBe("ContextKeep");
      for (const args of [{}, { projection: "compact", ifVersion: first.pageVersion }]) {
        const failed = await tool(t, "list_projects", args);
        expect(failed.isError).toBe(true);
        expect(failed.structuredContent.error.code).toBe("internal_error");
        expect(failed.structuredContent).not.toHaveProperty("notModified");
        expect(failed.structuredContent).not.toHaveProperty("projects");
      }
    } finally { sqlite.exec("ALTER TABLE unavailable_catalogue_projects RENAME TO projects"); }
    expect((await catalogue(t, { ifVersion: first.pageVersion })).notModified).toBe(true);
  });

  it("redacts compact strings and budgets both content channels without including large descriptions", async () => {
    const t = await setup(), token = t.config.mcpToken!;
    insert(t, {
      name: "Synthetic secret " + token,
      aliases: ["hidden-alias-" + token],
      description: "é".repeat(MCP_RESULT_BYTE_BUDGET),
    });
    const compact = await tool(t, "list_projects", { projection: "compact" });
    expect(compact.isError).not.toBe(true);
    expect(byteSize(compact)).toBeLessThanOrEqual(MCP_RESULT_BYTE_BUDGET);
    expect(byteSize(compact)).toBeLessThan(5000);
    expect(JSON.stringify(compact)).not.toContain(token);
    expect(JSON.parse(compact.content[0]!.text)).toEqual(compact.structuredContent);
    expect(Object.keys(compact.structuredContent.projects[0]).sort()).toEqual(COMPACT_KEYS);
    const full = await tool(t, "list_projects");
    expect(full.isError).toBe(true);
    expect(full.structuredContent.error).toMatchObject({ code: "result_too_large", retryable: false, nextAction: "reduce_page_or_request" });
    const unchanged = await tool(t, "list_projects", { projection: "compact", ifVersion: compact.structuredContent.pageVersion });
    expect(unchanged.isError).not.toBe(true);
    expect(unchanged.structuredContent.notModified).toBe(true);
    expect(unchanged.structuredContent).not.toHaveProperty("projects");
    expect(JSON.stringify(unchanged)).not.toContain(token);
    expect(JSON.parse(unchanged.content[0]!.text)).toEqual(unchanged.structuredContent);
  });

  it("rejects malformed and incompatible options instead of silently weakening their meaning", async () => {
    const t = await setup();
    const invalid = [
      { projection: "selector" }, { projection: null },
      { projection: "compact", lifecycle: "deleted" },
      { projection: "compact", ifVersion: "" }, { projection: "compact", ifVersion: true },
      { projection: "compact", expectedCatalogVersion: null },
      { projection: "compact", ifVersion: "x".repeat(129) },
      { projection: "compact", expectedCatalogVersion: "x".repeat(129) },
      { projection: "compact", fields: ["id"] },
      { projection: "compact", limit: 0 }, { projection: "compact", limit: 51 },
      { projection: "compact", offset: -1 }, { projection: "compact", offset: 0.5 },
      { projection: "compact", q: "" },
      { ifVersion: "old-token" }, { expectedCatalogVersion: "old-token" },
      { lifecycle: "active" }, { projection: "full", ifVersion: "old-token" },
    ];
    for (const args of invalid) {
      const result = await tool(t, "list_projects", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.structuredContent.error.code, JSON.stringify(args)).toBe("invalid_input");
      expect(result.structuredContent.error.retryable).toBe(false);
    }
  });

  it("keeps conditional and compact bodies smaller than a full metadata page", async () => {
    const t = await setup();
    // This is a size regression, not the separately predeclared consumer cohort.
    many(t, 50, "Fictional project description. ".repeat(80).slice(0, 2048));
    const before = counts(t);
    const full = await tool(t, "list_projects");
    const compact = await tool(t, "list_projects", { projection: "compact" });
    const unchanged = await tool(t, "list_projects", {
      projection: "compact", ifVersion: compact.structuredContent.pageVersion,
    });
    for (const result of [full, compact, unchanged]) {
      expect(result.isError).not.toBe(true);
      expect(byteSize(result)).toBeLessThanOrEqual(MCP_RESULT_BYTE_BUDGET);
      expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    }
    expect(ids(compact.structuredContent)).toEqual(ids(full.structuredContent));
    expect(compact.structuredContent.projects.every((project: object) =>
      JSON.stringify(Object.keys(project).sort()) === JSON.stringify(COMPACT_KEYS))).toBe(true);
    expect(unchanged.structuredContent.notModified).toBe(true);
    expect(unchanged.structuredContent).not.toHaveProperty("projects");
    expect(byteSize(unchanged)).toBeLessThan(byteSize(compact));
    expect(byteSize(compact)).toBeLessThan(byteSize(full));
    expect(counts(t)).toEqual(before);
  });
});
