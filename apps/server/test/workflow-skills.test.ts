import crypto from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadWorkflowSkillCatalog,
  WORKFLOW_SKILLS_EXTENSION,
} from "../src/mcp/workflow-skills.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const TOKEN = crypto.randomBytes(32).toString("hex");
const apps: TestApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const app = await makeTestApp({ mcpToken: TOKEN });
  apps.push(app);
  return app;
}
async function rpc(
  app: TestApp,
  method: string,
  params: Record<string, unknown> = {},
  modern = true,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    accept: "application/json, text/event-stream",
    ...(modern
      ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method }
      : {}),
  };
  if (modern && typeof params.name === "string")
    headers["mcp-name"] = params.name;
  if (modern && method === "resources/read" && typeof params.uri === "string")
    headers["mcp-name"] = params.uri;
  return app.app.inject({
    method: "POST",
    url: "/mcp",
    headers,
    payload: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        ...(modern
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "synthetic",
                  version: "1",
                },
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: { [WORKFLOW_SKILLS_EXTENSION]: {} },
                },
              },
            }
          : {}),
      },
    },
  });
}
const hash = (bytes: Uint8Array) =>
  "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(files: Record<string, string | Uint8Array>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ck-skills-"));
  roots.push(root);
  for (const [name, data] of Object.entries(files)) {
    const full = path.join(root, "example", name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }
  return root;
}
const MARKDOWN =
  "---\nname: example\ndescription: Use the synthetic example workflow.\nmetadata:\n  channel: synthetic\n---\n\nKeep evidence separate. Șț é.\n";

describe("workflow skills over MCP", () => {
  it("discovers six bundled workflows, preserves Events/settings, and serves digest-identical bytes", async () => {
    const app = await setup();
    const discovery = await rpc(app, "server/discover");
    expect(discovery.statusCode).toBe(200);
    const cap = discovery.json().result.capabilities;
    expect(cap.extensions[WORKFLOW_SKILLS_EXTENSION]).toEqual({});
    expect(cap.extensions["openai/settings"]).toBeDefined();
    expect(cap.events).toEqual({});
    const listed = await rpc(app, "skills/list");
    expect(listed.statusCode).toBe(200);
    const result = listed.json().result;
    expect(result.resultType).toBe("complete");
    expect(result.ttlMs).toBe(300000);
    expect(result.cacheScope).toBe("private");
    expect(
      result.skills.map((skill: any) => skill.frontmatter.name).sort(),
    ).toEqual([
      "capture-progress",
      "close-safely",
      "create-handoff",
      "recover-uncertain-run",
      "resume-work",
      "setup",
    ]);
    for (const skill of result.skills) {
      const detail = (await rpc(app, "skills/get", { uri: skill.uri })).json()
        .result;
      expect(detail).toEqual({
        resultType: "complete",
        skill,
        ttlMs: 300000,
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "ContextKeep",
            version: "2.25.0",
          },
        },
      });
      expect(skill.resources.some((item: any) => item.uri === skill.uri)).toBe(
        true,
      );
      for (const resource of skill.resources) {
        const read = (
          await rpc(app, "resources/read", { uri: resource.uri })
        ).json().result;
        expect(read).toMatchObject({
          resultType: "complete",
          ttlMs: 300000,
          cacheScope: "private",
        });
        const content = read.contents[0];
        const bytes =
          "text" in content
            ? Buffer.from(content.text, "utf8")
            : Buffer.from(content.blob, "base64");
        expect(bytes.length).toBe(resource.size);
        expect(hash(bytes)).toBe(resource.digest);
      }
    }
    const resources = (await rpc(app, "resources/list")).json().result
      .resources;
    expect(resources[0].uri).toMatch(/^ui:\/\/contextkeep\/tasks\//);
    expect(
      resources.filter((r: any) => r.uri.startsWith("skill://contextkeep/")),
    ).toHaveLength(6);
    const capabilityResult = (
      await rpc(app, "tools/call", { name: "get_capabilities", arguments: {} })
    ).json().result;
    expect(
      capabilityResult.structuredContent.extensions[WORKFLOW_SKILLS_EXTENSION],
    ).toEqual({});
    expect(capabilityResult.structuredContent.execution.role).toBe(
      "memory_and_evidence",
    );
  });

  it("keeps legacy discovery usable and protects the procedure route with the same authentication", async () => {
    const app = await setup();
    const init = (
      await rpc(
        app,
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "synthetic", version: "1" },
        },
        false,
      )
    ).json();
    expect(
      init.result.capabilities.extensions[WORKFLOW_SKILLS_EXTENSION],
    ).toEqual({});
    const listed = (await rpc(app, "skills/list", {}, false)).json().result;
    expect(listed.skills).toHaveLength(6);
    expect(listed.ttlMs).toBeUndefined();
    const denied = await app.app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "skills/list", params: {} },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("resume-work");
    for (const [method, params] of [
      ["skills/get", { uri: "skill://contextkeep/missing/SKILL.md" }],
      ["resources/read", { uri: "skill://contextkeep/../outside.txt" }],
      ["resources/read", { uri: "skill://contextkeep/%2e%2e/outside.txt" }],
      ["skills/list", { cursor: "not-issued" }],
    ] as const)
      expect((await rpc(app, method, params)).json().error.code).toBe(-32602);
  });

  it("preserves all frontmatter and complete manifests, including support files and immutable byte snapshots", async () => {
    const root = await fixture({
      "SKILL.md": MARKDOWN,
      "references/GUIDE.md": "\ufeffÎndrumare.\r\n",
      "assets/data.bin": new Uint8Array([0, 255, 1]),
    });
    const catalog = await loadWorkflowSkillCatalog(root);
    const entry = catalog.entries[0]!;
    expect(entry.frontmatter.metadata).toEqual({ channel: "synthetic" });
    expect(entry.resources).toHaveLength(3);
    for (const resource of entry.resources as Array<{
      uri: string;
      digest: string;
      size: number;
    }>) {
      const content = catalog.read(resource.uri)!;
      const bytes =
        "text" in content
          ? Buffer.from(content.text, "utf8")
          : Buffer.from(content.blob, "base64");
      expect(hash(bytes)).toBe(resource.digest);
      expect(bytes.length).toBe(resource.size);
    }
    await fs.writeFile(
      path.join(root, "example", "SKILL.md"),
      MARKDOWN + "Changed later.\n",
    );
    expect(catalog.read(entry.uri)).toMatchObject({ text: MARKDOWN });
    expect(Object.isFrozen(entry.frontmatter)).toBe(true);
    expect(
      catalog.read("skill://contextkeep/example/../../outside.txt"),
    ).toBeUndefined();
  });

  it("refuses symlinked resources, invalid names, and excessive file size instead of publishing partial manifests", async () => {
    const root = await fixture({ "SKILL.md": MARKDOWN });
    await fs.symlink(
      path.join(root, "example", "SKILL.md"),
      path.join(root, "example", "link.md"),
    );
    await expect(loadWorkflowSkillCatalog(root)).rejects.toThrow(
      /symbolic links/,
    );
    await fs.unlink(path.join(root, "example", "link.md"));
    await fs.writeFile(
      path.join(root, "example", "large.bin"),
      Buffer.alloc(512 * 1024),
    );
    await expect(loadWorkflowSkillCatalog(root)).rejects.toThrow(
      /publication limit/,
    );
    await fs.unlink(path.join(root, "example", "large.bin"));
    await fs.writeFile(
      path.join(root, "example", "SKILL.md"),
      MARKDOWN.replace("name: example", "name: different"),
    );
    await expect(loadWorkflowSkillCatalog(root)).rejects.toThrow();
  });
});
