import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeTestApp, type TestApp } from "./helpers.js";

const tracked: TestApp[] = [];
afterEach(async () => {
  for (const app of tracked.splice(0)) await app.cleanup();
});
async function setup(metricsToken?: string) {
  const app = await makeTestApp({ metricsToken, mcpToken: crypto.randomBytes(32).toString("hex") });
  tracked.push(app);
  return app;
}

describe("independent read-only metrics scrape", () => {
  it("fails closed without a configured credential, including owner sessions", async () => {
    const t = await setup();
    expect((await t.raw("GET", "/metrics")).statusCode).toBe(404);
    expect((await t.get("/metrics")).statusCode).toBe(404);
    expect((await t.get("/api/metrics")).statusCode).toBe(200);
  });

  it("serves existing aggregate metrics only for the dedicated bearer", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const t = await setup(token);
    const response = await t.app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["set-cookie"]).toBeUndefined();
    for (const metric of ["ck_mcp_tool_calls_total", "ck_mcp_tool_duration_seconds", "ck_mcp_tool_result_bytes", "ck_mcp_tool_budget_omissions_total"]) {
      expect(response.body).toContain(metric);
    }
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(t.cookie);
  });

  it("does not accept owner cookies, MCP credentials, URL credentials or browser origins", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const t = await setup(token);
    expect((await t.get("/metrics")).statusCode).toBe(401);
    expect((await t.raw("GET", "/metrics")).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/metrics", headers: { authorization: `Bearer ${t.config.mcpToken}` } })).statusCode).toBe(401);
    expect((await t.raw("GET", `/metrics?token=${token}`)).statusCode).toBe(401);
    expect((await t.app.inject({ url: "/metrics", headers: { authorization: `Bearer ${token}`, origin: "https://example.invalid" } })).statusCode).toBe(403);
  });

  it("cannot use the scrape credential to read owner data or invoke MCP", async () => {
    const token = crypto.randomBytes(32).toString("hex");
    const t = await setup(token);
    const headers = { authorization: `Bearer ${token}` };
    for (const url of ["/api/projects", "/api/metrics"]) {
      expect((await t.app.inject({ url, headers })).statusCode).toBe(401);
    }
    expect((await t.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).statusCode).toBe(401);
  });

  it("validates optional scrape credentials", () => {
    expect(loadConfig({ NODE_ENV: "test", CK_METRICS_TOKEN: "" }).metricsToken).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: "test", CK_METRICS_TOKEN: "short" })).toThrow();
    const token = crypto.randomBytes(32).toString("hex");
    expect(() => loadConfig({ NODE_ENV: "test", CK_METRICS_TOKEN: token, CK_MCP_TOKEN: token })).toThrow("independent");
    expect(() => loadConfig({ NODE_ENV: "test", CK_METRICS_TOKEN: token, CK_SESSION_SECRET: token })).toThrow("independent");
  });
});
