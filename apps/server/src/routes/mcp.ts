import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createContextKeepMcpServer } from "../mcp/tools.js";

/** Private transport: Secure MCP Tunnel authenticates the owner upstream;
 * a separate local bearer authenticates tunnel-client to ContextKeep.
 * Never publish this route as an unauthenticated public MCP endpoint.
 */
export function registerMcpRoutes(app: FastifyInstance): void {
  const { config, deps } = app.ck;
  const token = config.mcpToken;
  const factory: McpServerFactory = () => createContextKeepMcpServer(deps, [token!, config.sessionSecret], {
    defaultClientId: config.mcpDefaultClientId,
    delegateWorkingMemory: config.mcpDelegateWorkingMemory,
    buildSha: config.buildSha,
  });
  const modernHandler = createMcpHandler(
    factory,
    {
      // Legacy traffic is routed below so the established JSON response mode
      // remains byte-compatible with the previous stateless transport.
      legacy: "reject",
      onerror: () => app.log.error("MCP handler failed; payload and credentials omitted."),
    },
  );
  // Release the official handler notification bus and request resources when
  // this Fastify instance closes, including isolated fixtures and restarts.
  app.addHook("onClose", async () => { await modernHandler.close(); });
  const mcpHandler = {
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
      if (!(await isLegacyRequest(request, options?.parsedBody, { maxRequestBodySize: 128 * 1024 }))) {
        return modernHandler.fetch(request, options);
      }
      const server = await factory({ era: "legacy", ...options?.authInfo && { authInfo: options.authInfo }, requestInfo: request });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: 128 * 1024,
      });
      try {
        await server.connect(transport);
        return await transport.handleRequest(request, options);
      } finally {
        await server.close();
      }
    },
  };
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    maxRequestBodySize: 128 * 1024,
    onerror: () => app.log.error("MCP node adapter failed; payload and credentials omitted."),
  });
  app.route({
    method: ["POST", "GET", "DELETE"], url: "/mcp", bodyLimit: 128 * 1024,
    config: { rateLimit: false },
    errorHandler: (error, _request, reply) => {
      // Parser errors can contain submitted text. Do not log or echo them.
      const status = [400, 413, 415, 429].includes(error.statusCode ?? 0) ? error.statusCode! : 500;
      return reply.code(status).send({ error: status === 429 ? "MCP rate limit exceeded." : "Invalid or failed MCP request." });
    },
    // Rate-limit BEFORE auth can short-circuit; rejected credentials count too.
    onRequest: [app.rateLimit({ max: 120, timeWindow: "1 minute" }), async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!token) return reply.code(404).send({ error: "MCP is not configured." });
      const actual = crypto.createHash("sha256").update(request.headers.authorization ?? "").digest();
      const expected = crypto.createHash("sha256").update(`Bearer ${token}`).digest();
      if (!crypto.timingSafeEqual(actual, expected)) {
        return reply.header("www-authenticate", 'Bearer realm="ContextKeep MCP local transport"')
          .code(401).send({ error: "MCP authentication required." });
      }
      // This endpoint is server-to-server only. Browser cookies never grant MCP access.
      if (request.headers.origin) return reply.code(403).send({ error: "Browser origins are not allowed." });
      if (request.method !== "POST") return reply.header("allow", "POST").code(405).send({ error: "Use POST for stateless MCP." });
    }],
    handler: async (request, reply) => {
      reply.hijack();
      reply.raw.setHeader("cache-control", "no-store");
      await nodeMcpHandler(request.raw, reply.raw, request.body);
    },
  });
}
