import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvidenceFor, loadEvidenceRefsFor } from "../src/services/mappers.js";
import { createBackup } from "../src/services/backup.js";
import { mcpCatalogCacheStats } from "../src/mcp/tools.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const apps: TestApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.cleanup();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function app(opts: Parameters<typeof makeTestApp>[0] = {}): Promise<TestApp> {
  const t = await makeTestApp(opts);
  apps.push(t);
  return t;
}

async function mcpCall(t: TestApp, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await t.app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<any>();
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  return body.result.structuredContent;
}

describe("CK-A09 bounded internal cost", () => {
  it("loads work-context evidence refs without materializing exact excerpt text", async () => {
    const t = await app({ seed: true });
    const ids = (t.app.ck.handle.sqlite
      .prepare("SELECT id FROM records ORDER BY recorded_at DESC LIMIT 20")
      .all() as Array<{ id: string }>).map((row) => row.id);

    const full = loadEvidenceFor(t.app.ck.deps.db, ids);
    const refs = loadEvidenceRefsFor(t.app.ck.deps.db, ids);

    const simplifyFull = [...full.entries()].map(([id, items]) => [
      id,
      items.map((item) => ({
        excerptId: item.excerptId,
        sourceId: item.sourceId,
        sourceTitle: item.sourceTitle,
        relation: item.relation,
        observedAt: item.observedAt,
        artifactRef: item.artifactRef,
      })),
    ]);
    const simplifyRefs = [...refs.entries()];
    expect(simplifyRefs).toEqual(simplifyFull);

    const fullBytes = Buffer.byteLength(JSON.stringify([...full.entries()]), "utf8");
    const refBytes = Buffer.byteLength(JSON.stringify(simplifyRefs), "utf8");
    expect(refBytes).toBeLessThan(fullBytes);
  });

  it("hashes SQLite backups without readFileSync materializing the whole database", async () => {
    const t = await app({ seed: true });
    const backupDir = tempDir("ck-a09-backup-");
    const readSpy = vi.spyOn(fs, "readFileSync");

    const summary = await createBackup(
      t.app.ck.handle,
      t.app.ck.deps,
      backupDir,
      3,
      { actor: "owner:test", requestId: "cka09-streaming-hash" },
    );

    const sqliteReadCalls = readSpy.mock.calls.filter(([file]) => String(file).endsWith(".sqlite"));
    expect(sqliteReadCalls).toHaveLength(0);

    readSpy.mockRestore();
    const manifest = JSON.parse(fs.readFileSync(summary.manifestFile, "utf8")) as { sha256: string };
    const expected = crypto.createHash("sha256").update(fs.readFileSync(summary.file)).digest("hex");
    expect(manifest.sha256).toBe(expected);
  });

  it("compiles static MCP tool metadata once while keeping per-server options isolated", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const before = mcpCatalogCacheStats();

    const first = await app({
      mcpToken: token,
      mcpDefaultClientId: "a09-alpha",
      mcpDelegateWorkingMemory: true,
    });
    const second = await app({
      mcpToken: token,
      mcpDefaultClientId: "a09-beta",
      mcpDelegateWorkingMemory: true,
    });

    const alpha = await mcpCall(first, token, "get_capabilities");
    const afterFirst = mcpCatalogCacheStats();
    const beta = await mcpCall(second, token, "get_capabilities");
    const afterSecond = mcpCatalogCacheStats();

    expect(afterFirst.size).toBeGreaterThan(0);
    expect(afterFirst.compileCount).toBeGreaterThan(before.compileCount);
    expect(afterSecond.compileCount).toBe(afterFirst.compileCount);
    expect(afterSecond.size).toBe(afterFirst.size);
    expect(alpha.workingMemoryDelegation.clientId).toBe("a09-alpha");
    expect(beta.workingMemoryDelegation.clientId).toBe("a09-beta");
  });
});
