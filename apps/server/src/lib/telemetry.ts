import { trace } from "@opentelemetry/api";
import client from "prom-client";
import type { AppConfig } from "../config.js";
import { APP_VERSION } from "../db/bootstrap.js";

export const tracer = trace.getTracer("contextkeep-server", APP_VERSION);

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: "ck_http_requests_total",
  help: "HTTP requests by method, route and status",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const importsTotal = new client.Counter({
  name: "ck_imports_total",
  help: "Import jobs by final stage",
  labelNames: ["stage"] as const,
  registers: [registry],
});

export const providerRefusedTotal = new client.Counter({
  name: "ck_provider_refused_total",
  help: "Refused provider/adapter calls (A14/A21)",
  labelNames: ["adapter"] as const,
  registers: [registry],
});

/**
 * CK-A13 MCP diagnostics. Labels are deliberately finite: tool names come
 * only from the registered static catalog, outcome is success/error, and
 * error_class is one of a small fixed taxonomy. Never add project/session/
 * request identifiers, prompts or memory text as labels.
 */
export const mcpToolCallsTotal = new client.Counter({
  name: "ck_mcp_tool_calls_total",
  help: "MCP tool calls by registered tool, outcome and bounded error class",
  labelNames: ["tool", "outcome", "error_class"] as const,
  registers: [registry],
});

export const mcpToolDurationSeconds = new client.Histogram({
  name: "ck_mcp_tool_duration_seconds",
  help: "MCP tool duration by registered tool and outcome",
  labelNames: ["tool", "outcome"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const mcpToolResultBytes = new client.Histogram({
  name: "ck_mcp_tool_result_bytes",
  help: "Serialized MCP tool result bytes by registered tool and outcome",
  labelNames: ["tool", "outcome"] as const,
  buckets: [256, 1024, 4096, 16384, 65536, 262144, 750000],
  registers: [registry],
});

export const mcpToolBudgetOmissionsTotal = new client.Counter({
  name: "ck_mcp_tool_budget_omissions_total",
  help: "MCP responses that explicitly omitted optional content for a response budget",
  labelNames: ["tool"] as const,
  registers: [registry],
});

/**
 * OTel tracing is wired through @opentelemetry/api (no-op by default).
 * The OTLP exporter activates ONLY when CK_OTLP_ENDPOINT is set — no telemetry
 * ever leaves the host otherwise (handoff §11).
 */
export async function initTelemetry(config: AppConfig): Promise<() => Promise<void>> {
  if (!config.otlpEndpoint) return async () => {};
  const [{ BasicTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] =
    await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "contextkeep", "service.version": APP_VERSION }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: config.otlpEndpoint }))],
  });
  trace.setGlobalTracerProvider(provider);
  return async () => {
    await provider.shutdown();
  };
}
