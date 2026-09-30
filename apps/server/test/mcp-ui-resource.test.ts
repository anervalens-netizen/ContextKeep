import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});

it("advertises a new UI cache key while preserving the installed legacy resource", async () => {
  const token = crypto.randomBytes(32).toString("hex");
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  t.config.webDist = path.join(t.dataDir, "web");
  fs.mkdirSync(path.join(t.config.webDist, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(t.config.webDist, "mcp/widget.js"), 'document.title="Synthetic app";');
  fs.writeFileSync(path.join(t.config.webDist, "mcp/widget.css"), "body{color:navy}");
  const rpc = async (method: string, params = {}) => {
    const response = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: crypto.randomUUID(), method, params },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const tools = (await rpc("tools/list")).result.tools;
  const panel = tools.find((tool: { name: string }) => tool.name === "open_task_panel");
  const uri = panel._meta.ui.resourceUri;
  expect(uri).toBe("ui://contextkeep/tasks/v4.html");
  expect(panel._meta["openai/ui"].entrypoints).toEqual([{ type: "global" }, { type: "thread" }]);
  const listed = (await rpc("resources/list")).result.resources;
  expect(listed.map((resource: { uri: string }) => resource.uri)).toEqual([uri]);
  const current = (await rpc("resources/read", { uri })).result.contents[0];
  const legacy = (await rpc("resources/read", { uri: "ui://contextkeep/tasks" })).result.contents[0];
  expect(current.uri).toBe(uri);
  expect(legacy.uri).toBe("ui://contextkeep/tasks");
  expect(current.mimeType).toBe("text/html;profile=mcp-app");
  expect(current.text).toContain('document.title="Synthetic app"');
  expect(current.text).toContain("body{color:navy}");
  expect(legacy.text).toBe(current.text);
  for (const olderUri of ["ui://contextkeep/tasks/v2.html", "ui://contextkeep/tasks/v3.html"]) {
    expect((await rpc("resources/read", { uri: olderUri })).result.contents[0].text).toBe(current.text);
  }
  expect((await rpc("resources/read", { uri: "ui://contextkeep/unknown" })).error.code).toBe(-32602);
});
