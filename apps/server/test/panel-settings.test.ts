import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { buildApp } from "../src/app.js";

const tracked: TestApp[] = [];
afterEach(async () => {
  for (const t of tracked.splice(0)) await t.cleanup();
});
async function fixture() {
  const token = randomUUID();
  const t = await makeTestApp({ mcpToken: token });
  tracked.push(t);
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: randomUUID(), method, params },
    });
    expect(r.statusCode).toBe(200);
    return r.json();
  };
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    error = false,
  ) => {
    const r = await rpc("tools/call", { name, arguments: args });
    expect(r.result.isError === true, JSON.stringify(r)).toBe(error);
    return r.result.structuredContent;
  };
  return { t, rpc, call, token };
}
describe("native panel preferences", () => {
  it("advertises native settings in legacy initialize and modern discovery on the wire", async () => {
    const { t, rpc, call, token } = await fixture();
    const legacy = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "settings fixture", version: "1" },
    });
    const capability = {
      readTool: "settings.read",
      updateTool: "settings.update",
    };
    expect(legacy.result.capabilities.experimental["openai/settings"]).toEqual(
      capability,
    );
    const read = await call("settings.read");
    expect(read.schema.type).toBe("object");
    expect(Object.keys(read.schema.properties)).toEqual([
      "landingView",
      "taskVisibility",
      "contextBudget",
      "refreshInterval",
      "language",
    ]);
    expect(read.schema.additionalProperties).toBe(false);
    for (const field of Object.values(read.schema.properties) as Array<
      Record<string, unknown>
    >) {
      expect(field.type).toBe("string");
      expect(field.default).toBeUndefined();
      expect(field.anyOf).toBeUndefined();
      expect(field.title).toBeTruthy();
    }
    expect(
      read.layout[0].items.map((i: { property: string }) => i.property),
    ).toEqual(Object.keys(read.schema.properties));
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address();
    if (!address || typeof address === "string")
      throw new Error("port missing");
    const client = new Client(
      { name: "settings fixture", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    let discovered: any;
    const wireFetch: typeof fetch = async (input, init) => {
      const r = await fetch(input, init);
      if (
        typeof init?.body === "string" &&
        JSON.parse(init.body).method === "server/discover"
      )
        discovered = await r.clone().json();
      return r;
    };
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/mcp`),
          {
            fetch: wireFetch,
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          },
        ),
      );
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect(
        discovered.result.capabilities.extensions["openai/settings"],
      ).toEqual(capability);
      expect(
        discovered.result.capabilities.experimental["openai/settings"],
      ).toEqual(capability);
      const changed = await client.callTool({
        name: "settings.update",
        arguments: { set: { language: "en" } },
      });
      expect(changed.isError).not.toBe(true);
      expect((await call("settings.read")).values.language).toBe("en");
    } finally {
      await client.close();
    }
  });
  it("merges concurrent partial updates, persists across restart and does not alter memory or replay receipts", async () => {
    const { t, call } = await fixture();
    const file = path.join(t.dataDir, "panel-preferences.json");
    const counts = () =>
      ["records", "audit_events", "idempotency_requests"].map((table) =>
        t.app.ck.deps.sqlite
          .prepare("SELECT count(*) AS n FROM " + table)
          .get(),
      );
    const before = counts();
    const defaults = await call("settings.read");
    expect(fs.existsSync(file)).toBe(false);
    expect(defaults.values.landingView).toBe("recent");
    await Promise.all([
      call("settings.update", { set: { language: "en" } }),
      call("settings.update", {
        set: { landingView: "attention", contextBudget: "deep" },
      }),
      call("settings.update", {
        set: { refreshInterval: "manual", taskVisibility: "all_actions" },
      }),
    ]);
    const expected = {
      language: "en",
      landingView: "attention",
      contextBudget: "deep",
      refreshInterval: "manual",
      taskVisibility: "all_actions",
    };
    expect((await call("settings.read")).values).toEqual(expected);
    expect(counts()).toEqual(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await t.app.close();
    const restarted = await buildApp({ config: t.config, logger: false });
    t.app = restarted;
    try {
      expect((await call("settings.read")).values).toEqual(expected);
    } finally {
      await restarted.close();
    }
  });
  it("rejects invalid, empty and unrelated fields without partial writes and retains corrupt evidence", async () => {
    const { t, call } = await fixture();
    const file = path.join(t.dataDir, "panel-preferences.json");
    await call("settings.update", { set: { language: "en" } });
    const before = fs.readFileSync(file, "utf8");
    for (const set of [
      {},
      { language: "invalid" },
      { language: "ro", taskId: randomUUID() },
      { refreshInterval: "1s" },
    ]) {
      await call("settings.update", { set }, true);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    }
    fs.writeFileSync(file, "{invalid");
    await call("settings.read", {}, true);
    await call("settings.update", { set: { language: "ro" } }, true);
    expect(fs.readFileSync(file, "utf8")).toBe("{invalid");
    expect(
      fs
        .readdirSync(t.dataDir)
        .filter((name) => name.startsWith(".panel-preferences-")),
    ).toEqual([]);
  });
});
