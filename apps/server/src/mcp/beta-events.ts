import { isUtf8 } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ProtocolError, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps } from "../services/import.js";
import { requireTaskScope } from "../services/task-scope.js";
import {
  EventFilter,
  EventPayload,
  eventDefinition,
} from "../services/workflow-events.js";
import { MCP_VERSION, MODERN_PROTOCOL_VERSION } from "./runtime-metadata.js";

const extension = "io.modelcontextprotocol/events";
const unsupportedModes = new Map([
  ["events/stream", "push"],
  ["events/subscribe", "webhook"],
  ["events/unsubscribe", "webhook"],
]);
const namedEvent = z.object({ name: z.string() });
const pollParams = namedEvent.extend({
  arguments: z.unknown(),
  cursor: z.string().nullable().optional(),
  maxEvents: z.number().int().positive().optional(),
  maxAgeMs: z.number().int().nonnegative().optional(),
});
type Poll = z.infer<typeof pollParams>;
type Occurrence = {
  name: string;
  eventId: string;
  timestamp: string;
  data: z.infer<typeof EventPayload>;
};

function checkName(name: string) {
  if (name !== eventDefinition.name)
    throw new ProtocolError(-32023, "Unknown event.", { kind: "event" });
}

function invalidCursor() {
  return new ProtocolError(-32602, "Invalid cursor for this subscription.");
}

// The anchor is the immutable event ID (or "0" for an empty stream). It reveals
// no global sequence. A restore that loses the anchor can signal a replay gap.
export function pollExecutionEvents(
  deps: ServiceDeps,
  principal: string,
  secret: string,
  input: Poll,
) {
  checkName(input.name);
  const scope = EventFilter.safeParse(input.arguments);
  if (!scope.success)
    throw new ProtocolError(-32602, "Expected projectId and taskId.");
  const { projectId, taskId } = scope.data;
  const cursorFor = (anchor: string) => {
    const mac = createHmac("sha256", secret)
      .update(
        JSON.stringify([
          extension,
          1,
          principal,
          input.name,
          projectId,
          taskId,
          anchor,
        ]),
      )
      .digest("base64url");
    return `1.${anchor}.${mac}`;
  };
  const db = deps.sqlite;
  return db.transaction(() => {
    try {
      requireTaskScope(deps, projectId, taskId);
    } catch (error) {
      if (error instanceof ApiError)
        throw new ProtocolError(-32024, "Task scope is unavailable.");
      throw error;
    }
    const events: Occurrence[] = [];
    let truncated = false;
    let hasMore = false;
    const result = (anchor: string) => ({
      resultType: "complete" as const,
      events,
      cursor: cursorFor(anchor),
      truncated,
      hasMore,
      nextPollMs: 30000,
    });
    const head = () =>
      db
        .prepare(
          "SELECT id FROM workflow_events WHERE task_id=? AND project_id=? AND json_extract(payload, '$.name')=? ORDER BY sequence DESC LIMIT 1",
        )
        .pluck()
        .get(taskId, projectId, input.name) as string | undefined;

    if (input.cursor == null) return result(head() ?? "0");
    const match = /^1\.(0|[a-f0-9]{64})\.[A-Za-z0-9_-]{43}$/.exec(input.cursor);
    if (
      !match ||
      match[0] !== input.cursor ||
      !timingSafeEqual(
        Buffer.from(input.cursor),
        Buffer.from(cursorFor(match[1]!)),
      )
    )
      throw invalidCursor();
    let anchor = match[1]!;
    let sequence = 0n;
    if (anchor !== "0") {
      const stored = db
        .prepare(
          "SELECT sequence FROM workflow_events WHERE id=? AND task_id=? AND project_id=? AND json_extract(payload, '$.name')=?",
        )
        .safeIntegers()
        .pluck()
        .get(anchor, taskId, projectId, input.name) as bigint | undefined;
      if (stored === undefined) {
        truncated = true;
        return result(head() ?? "0");
      }
      sequence = stored;
    }

    const limit = Math.min(input.maxEvents ?? 50, 100);
    const floor =
      input.maxAgeMs === undefined ? -Infinity : Date.now() - input.maxAgeMs;
    // Index-order traversal inside the same read snapshot as authorization and
    // anchor lookup. Stop before consuming the first returnable event past the cap.
    const rows = db
      .prepare(
        "SELECT id, payload FROM workflow_events WHERE task_id=? AND project_id=? AND sequence>? AND json_extract(payload, '$.name')=? ORDER BY sequence",
      )
      .iterate(taskId, projectId, sequence, input.name) as Iterable<{
      id: string;
      payload: string;
    }>;
    for (const row of rows) {
      const { name, timestamp, data } = JSON.parse(row.payload) as Occurrence;
      if (Date.parse(timestamp) < floor) {
        truncated = true;
      } else {
        if (events.length === limit) {
          hasMore = true;
          break;
        }
        events.push({ eventId: row.id, name, timestamp, data });
      }
      anchor = row.id;
    }
    return result(anchor);
  })();
}

export function createBetaEventsServer(
  deps: ServiceDeps,
  principal: string,
  secret: string,
) {
  const server = new Server(
    { name: "ContextKeep", version: MCP_VERSION },
    {
      supportedProtocolVersions: [MODERN_PROTOCOL_VERSION],
      capabilities: { extensions: { [extension]: {} } },
    },
  );
  server.setRequestHandler(
    "events/list",
    { params: z.object({ cursor: z.string().nullish() }) },
    (input) => {
      if (input.cursor != null) throw invalidCursor();
      return {
        resultType: "complete",
        events: [{ ...eventDefinition, delivery: ["poll"] }],
      };
    },
  );
  server.setRequestHandler("events/poll", { params: pollParams }, (input) =>
    pollExecutionEvents(deps, principal, secret, input),
  );
  for (const [method, mode] of unsupportedModes) {
    server.setRequestHandler(method, { params: namedEvent }, ({ name }) => {
      checkName(name);
      throw new ProtocolError(-32026, "Unsupported delivery mode.", {
        feature: "deliveryMode",
        value: mode,
      });
    });
  }
  return server;
}

// SDK 2.4 validates the core routing headers. SEP-3415 additionally mirrors
// params.name on these extension methods, including the Base64 sentinel form.
export function betaEventHeaderMismatch(
  request: Request,
  parsed: unknown,
): Response | undefined {
  const message = parsed as {
    method?: string;
    id?: unknown;
    params?: { name?: unknown };
  } | null;
  if (
    !message?.method ||
    (typeof message.id !== "number" && typeof message.id !== "string")
  )
    return;
  const header = request.headers.get("mcp-name");
  if (message.method === "events/list") {
    if (header === null) return;
  } else {
    if (
      message.method !== "events/poll" &&
      !unsupportedModes.has(message.method)
    )
      return;
    const name = message.params?.name;
    if (typeof name !== "string" && header === null) return; // InvalidParams in the SDK.
    if (header?.startsWith("=?base64?") && header.endsWith("?=")) {
      const encoded = header.slice(9, -2);
      const bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") === encoded &&
        isUtf8(bytes) &&
        bytes.toString("utf8") === name
      )
        return;
    } else if (
      header !== null &&
      /^[\t\x20-\x7e]*$/.test(header) &&
      header === name
    ) {
      return;
    }
  }
  return Response.json(
    {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32020, message: "Mcp-Name must match params.name." },
    },
    { status: 400 },
  );
}
