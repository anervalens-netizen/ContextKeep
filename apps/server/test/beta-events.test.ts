import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MODERN_PROTOCOL_VERSION } from "../src/mcp/runtime-metadata.js";
import { pollExecutionEvents } from "../src/mcp/beta-events.js";
import { Webhook } from "standardwebhooks";
import { webhookPost } from "../src/services/webhook-http.js";
import { WorkflowEvents } from "../src/services/workflow-events.js";
import {
  attachJob,
  beginRun,
  observeRun,
  reserveRun,
} from "../src/services/workflow.js";
import { makeTestApp, type TestApp } from "./helpers.js";

vi.mock(import("../src/services/webhook-http.js"), async (original) => ({
  ...(await original()),
  webhookPost: vi.fn(),
}));

const name = "execution.finished";
const beta = "/mcp/events-beta";
const extension = "io.modelcontextprotocol/events";
const token = randomUUID();
const principal = createHash("sha256").update(token).digest("hex");
const fixtures: TestApp[] = [];

afterEach(async () => {
  for (const t of fixtures.splice(0)) await t.cleanup();
});

function request(
  method: string,
  params: Record<string, unknown> = {},
  declareExtension = true,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "synthetic-client",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": declareExtension
            ? { extensions: { [extension]: {} } }
            : {},
        },
      },
    }),
  };
}

async function fixture() {
  const t = await makeTestApp({ mcpToken: token });
  fixtures.push(t);
  async function tool(toolName: string, args: Record<string, unknown>) {
    const req = request(
      "tools/call",
      { name: toolName, arguments: args },
      false,
    );
    const r = await t.app.inject({
      method: "POST",
      url: "/mcp",
      headers: req.headers,
      payload: req.body,
    });
    const result = r.json().result;
    expect(result.isError, r.body).not.toBe(true);
    return result.structuredContent;
  }
  const { id: projectId } = await tool("create_project", {
    name: "Synthetic event fixture",
    idempotencyKey: randomUUID(),
  });
  async function newTask(title: string) {
    const { taskId } = await tool("create_task", {
      projectId,
      title,
      objective: "Check synthetic output",
      clientId: "fixture",
      sessionId: "fixture",
      idempotencyKey: randomUUID(),
    });
    return { projectId: projectId as string, taskId: taskId as string };
  }
  const scope = await newTask("First task");
  function job(args = scope, deps = t.app.ck.deps) {
    const run = reserveRun(deps, {
      ...args,
      operationKey: randomUUID(),
      inputHash: "a".repeat(64),
      device: "fixture",
      identity: "owner",
      criteria: ["Check synthetic output"],
    }).run;
    const runScope = { ...args, runId: run.id };
    const { leaseToken } = beginRun(deps, {
      ...runScope,
      revision: run.revision,
    });
    attachJob(deps, {
      ...runScope,
      leaseToken,
      externalJobId: "synthetic-job",
    });
    return (observedAt: string, eventKey = "finish") =>
      observeRun(deps, {
        ...runScope,
        eventKey,
        externalJobId: "synthetic-job",
        device: "fixture",
        identity: "owner",
        status: "completed",
        exitCode: 0,
        observedAt,
      });
  }
  return { t, scope, newTask, job };
}

describe("SEP-3415 poll", () => {
  it("negotiates the beta separately and validates routing, modes and filters", async () => {
    const { t, scope } = await fixture();
    async function rpc(
      method: string,
      params: Record<string, unknown> = {},
      extra: Record<string, string> = {},
      url = beta,
    ) {
      const req = request(method, params);
      return t.app.inject({
        method: "POST",
        url,
        headers: { ...req.headers, ...extra },
        payload: req.body,
      });
    }
    const discovery = (await rpc("server/discover")).json().result;
    expect(discovery.capabilities).toEqual({ extensions: { [extension]: {} } });
    expect(discovery.supportedVersions).toEqual([MODERN_PROTOCOL_VERSION]);
    const list = (await rpc("events/list")).json().result;
    expect(list).toMatchObject({
      resultType: "complete",
      events: [{ name, delivery: ["poll"] }],
    });
    expect(list.events[0].inputSchema.required).toEqual([
      "projectId",
      "taskId",
    ]);
    expect(list.events[0].payloadSchema.required).toContain("verification");
    expect(list.nextCursor).toBeUndefined();
    expect(
      (await rpc("events/list", { cursor: "unknown" })).json().error.code,
    ).toBe(-32602);
    const poll = { name, arguments: scope };
    expect(
      (await rpc("events/poll", poll, { "mcp-name": "wrong" })).statusCode,
    ).toBe(400);
    expect(
      (await rpc("events/poll", poll, { "mcp-name": "" })).json().error.code,
    ).toBe(-32020);
    expect(
      (
        await rpc("events/poll", poll, {
          "mcp-name": `=?base64?${Buffer.from(name).toString("base64")}?=`,
        })
      ).json().result.events,
    ).toEqual([]);
    expect(
      (
        await rpc("events/poll", { name: "unknown.event", arguments: {} })
      ).json().error,
    ).toMatchObject({ code: -32023, data: { kind: "event" } });
    for (const invalid of [
      { maxEvents: -1 },
      { maxAgeMs: -1 },
      { arguments: {} },
    ])
      expect(
        (await rpc("events/poll", { ...poll, ...invalid })).json().error.code,
      ).toBe(-32602);
    expect(
      (await rpc("events/poll", poll, { authorization: "" })).statusCode,
    ).toBe(401);
    for (const [method, value] of [
      ["events/stream", "push"],
      ["events/subscribe", "webhook"],
      ["events/unsubscribe", "webhook"],
    ])
      expect((await rpc(method!, poll)).json().error).toMatchObject({
        code: -32026,
        data: { feature: "deliveryMode", value },
      });
    expect((await rpc("events/poll", poll, {}, "/mcp")).json().error.code).toBe(
      -32601,
    );
    const legacy = await t.app.inject({
      method: "POST",
      url: beta,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "events/list" },
    });
    expect(legacy.json().error.code).toBe(-32022);
    const req = request("events/poll", poll, false);
    const undeclared = await t.app.inject({
      method: "POST",
      url: beta,
      headers: req.headers,
      payload: req.body,
    });
    expect(undeclared.json().result.events).toEqual([]);
    delete req.headers["mcp-name"];
    const missing = await t.app.inject({
      method: "POST",
      url: beta,
      headers: req.headers,
      payload: req.body,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe(-32020);
  });

  it("starts at the scoped head, paginates insertion order and signals age and missing-anchor gaps", async () => {
    const { t, scope, job, newTask } = await fixture();
    const deps = t.app.ck.deps;
    const other = await newTask("Other task");
    const poll = (cursor?: string | null, options = {}) =>
      pollExecutionEvents(deps, principal, t.config.sessionSecret, {
        name,
        arguments: scope,
        cursor,
        ...options,
      });
    const empty = poll(null);
    const old = "2000-01-01T00:00:00Z";
    const now = new Date().toISOString();
    job()(old);
    const start = poll();
    expect(start.events).toEqual([]);
    expect(start.cursor).not.toBe(empty.cursor);
    expect(poll(null, { maxAgeMs: 0 })).toEqual(start);
    job(other)(now);
    expect(poll(start.cursor)).toEqual(start);

    const one = job()(now).run.id;
    job()(old);
    const two = job()(now).run.id;
    const page = poll(start.cursor, { maxEvents: 1, maxAgeMs: 60000 });
    expect(page.events.map((e) => e.data.runId)).toEqual([one]);
    expect(page).toMatchObject({ hasMore: true, truncated: true });
    const next = poll(page.cursor, { maxEvents: 1, maxAgeMs: 60000 });
    expect(next.events.map((e) => e.data.runId)).toEqual([two]);
    expect(next).toMatchObject({ hasMore: false, truncated: false });
    expect(poll(next.cursor).events).toEqual([]);
    const stale = poll(empty.cursor, { maxAgeMs: 0 });
    expect(stale.truncated).toBe(true);
    expect(() => poll("invalid")).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => poll(page.cursor, { arguments: other })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() =>
      pollExecutionEvents(deps, "another-principal", t.config.sessionSecret, {
        name,
        arguments: scope,
        cursor: page.cursor,
      }),
    ).toThrow(expect.objectContaining({ code: -32602 }));
    expect(() =>
      poll(null, { arguments: { ...scope, projectId: randomUUID() } }),
    ).toThrow(expect.objectContaining({ code: -32024 }));

    // Model a restored synthetic store missing the client's last checkpoint.
    deps.sqlite
      .prepare("DELETE FROM workflow_events WHERE id=?")
      .run(next.events[0]!.eventId);
    expect(poll(next.cursor)).toEqual({ ...poll(null), truncated: true });
    deps.sqlite
      .prepare("UPDATE records SET review_status='rejected' WHERE id=?")
      .run(scope.taskId);
    expect(() => poll(page.cursor)).toThrow(
      expect.objectContaining({ code: -32024 }),
    );
  });

  it("caps pages while preserving a later append and every intermediate cursor", async () => {
    const { t, scope, job } = await fixture();
    const poll = (cursor?: string, maxEvents?: number) =>
      pollExecutionEvents(t.app.ck.deps, principal, t.config.sessionSecret, {
        name,
        arguments: scope,
        cursor,
        maxEvents,
      });
    const head = poll();
    const emit = job();
    const time = Date.UTC(2000, 0, 1);
    for (let i = 0; i < 101; ++i)
      emit(new Date(time + i).toISOString(), String(i));
    expect(poll(head.cursor).events).toHaveLength(50);
    const page = poll(head.cursor, 200);
    expect(page.events).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    const append = job()(new Date(time - 1000).toISOString());
    const tail = poll(page.cursor, 2);
    expect(tail.events).toHaveLength(2);
    expect(tail.events[1]!.data.runId).toBe(append.run.id);
    expect(tail.hasMore).toBe(false);
    expect(
      new Set([...page.events, ...tail.events].map((event) => event.eventId))
        .size,
    ).toBe(102);
    expect(poll(tail.cursor)).toEqual(poll());
  });

  it("replays duplicate observations across a server restart on the wire and preserves the draft subscription", async () => {
    const { t, scope, job } = await fixture();
    let app = t.app;
    let base = "";
    async function listen() {
      base = await app.listen({ host: "127.0.0.1", port: 0 });
    }
    async function rpc(
      url: string,
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const res = await fetch(base + url, {
        method: "POST",
        ...request(method, params, url === beta),
      });
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(body.error).toBeUndefined();
      return body.result;
    }
    const poll = (cursor?: string) =>
      rpc(beta, "events/poll", {
        name,
        arguments: scope,
        cursor,
        maxEvents: 1,
      });
    const delivery = {
      mode: "webhook",
      url: "https://receiver.example.com/events",
      secret: "whsec_" + randomBytes(32).toString("base64"),
    };
    const subscription = { name, arguments: scope, delivery };
    const callbacks: { eventId: string; cursor: null }[] = [];
    vi.mocked(webhookPost).mockImplementation(async (_url, headers, body) => {
      new Webhook(delivery.secret).verify(body, headers);
      const payload = JSON.parse(body);
      if (payload.type === "verification")
        return {
          status: 200,
          body: JSON.stringify({ challenge: payload.challenge }),
        };
      expect(headers["webhook-id"]).toBe(payload.eventId);
      callbacks.push(payload);
      return { status: 204, body: "" };
    });
    try {
      await listen();
      expect((await rpc(beta, "server/discover")).capabilities).toEqual({
        extensions: { [extension]: {} },
      });
      expect((await rpc(beta, "events/list")).events[0].delivery).toEqual([
        "poll",
      ]);
      const { id } = await rpc("/mcp", "events/subscribe", subscription);
      const expected = createHash("sha256")
        .update(
          JSON.stringify([
            principal,
            delivery.url,
            name,
            scope.projectId,
            scope.taskId,
          ]),
        )
        .digest("hex");
      expect(id).toBe(expected);
      const draftCapabilities = (await rpc("/mcp", "server/discover"))
        .capabilities;
      expect(draftCapabilities.events).toEqual({});
      expect(draftCapabilities.extensions?.[extension]).toBeUndefined();
      expect((await rpc("/mcp", "events/list")).events[0].delivery).toEqual([
        "webhook",
      ]);
      expect(await rpc("/mcp", "events/subscribe", subscription)).toMatchObject(
        { id, cursor: null, truncated: false },
      );

      const head = await poll();
      const emit = job();
      const at = new Date().toISOString();
      const first = emit(at);
      expect(emit(at).duplicate).toBe(true);
      const late = job()(at);
      const page = await poll(head.cursor);
      expect(page).toMatchObject({
        resultType: "complete",
        events: [
          {
            name,
            timestamp: at,
            data: { ...scope, runId: first.run.id, verification: "pending" },
          },
        ],
        hasMore: true,
        truncated: false,
      });
      expect(page.events[0]).not.toHaveProperty("cursor");
      const stored = t.app.ck.deps.sqlite
        .prepare("SELECT payload FROM workflow_events ORDER BY sequence")
        .all() as { payload: string }[];
      expect(stored).toHaveLength(2);
      expect(JSON.parse(stored[0]!.payload)).toEqual({
        ...page.events[0],
        cursor: null,
      });

      await new WorkflowEvents(
        t.app.ck.deps,
        principal,
        t.config.sessionSecret,
      ).pump();
      expect(callbacks).toEqual(stored.map((row) => JSON.parse(row.payload)));
      await app.close();
      app = await buildApp({ config: t.config, logger: false });
      await listen();
      expect(await poll(head.cursor)).toEqual(page);
      const next = await poll(page.cursor);
      expect(
        next.events.map((e: { data: { runId: string } }) => e.data.runId),
      ).toEqual([late.run.id]);
      expect(next.events[0].eventId).not.toBe(page.events[0].eventId);
      expect(next.hasMore).toBe(false);
      const appended = job(scope, app.ck.deps)(at);
      const live = await poll(next.cursor);
      expect(
        live.events.map(
          (event: { data: { runId: string } }) => event.data.runId,
        ),
      ).toEqual([appended.run.id]);
      expect((await poll(live.cursor)).events).toEqual([]);
      expect(await rpc("/mcp", "events/subscribe", subscription)).toMatchObject(
        { id, cursor: null },
      );
      await rpc("/mcp", "events/unsubscribe", {
        name,
        arguments: scope,
        delivery: { mode: "webhook", url: delivery.url },
      });
      expect(
        app.ck.deps.sqlite
          .prepare("SELECT active FROM workflow_subscriptions WHERE id=?")
          .pluck()
          .get(id),
      ).toBe(0);
      expect((await rpc("/mcp", "events/list")).events[0].delivery).toEqual([
        "webhook",
      ]);
    } finally {
      if (app !== t.app) await app.close();
    }
  });
});
