import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpToolErrorResult } from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps } from "../services/import.js";
import { redactCredentialLikeText } from "../services/redaction.js";
import {
  finalizeClaim,
  IDEMPOTENCY_RESULT_EXPIRED_MESSAGE,
  requestHash,
  tryClaim,
} from "../services/idempotency.js";

export const MCP_RESULT_BYTE_BUDGET = 750_000;

/** Redact both known credentials and credential-shaped project text at the boundary. */
export function safeValue(value: unknown, secrets: string[]): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    let text = item;
    for (const secret of secrets) {
      if (secret.length >= 8) text = text.split(secret).join("<REDACTED_CREDENTIAL>");
    }
    return redactCredentialLikeText(text).text;
  }));
}

export function rejectCredentials(input: unknown, secrets: string[]): void {
  if (JSON.stringify(input) !== JSON.stringify(safeValue(input, secrets))) {
    throw new ApiError(400, "credential_detected", "Remove credentials before saving project context.");
  }
}

export function toolResult(value: unknown, secrets: string[]): CallToolResult {
  const clean = safeValue(value, secrets) as Record<string, unknown>;
  const text = JSON.stringify(clean);
  const result: CallToolResult = { content: [{ type: "text", text }], structuredContent: clean };
  // This is the complete MCP result object, including both protocol content
  // and structuredContent. JSON-RPC envelope bytes are transport overhead and
  // are not part of this result budget.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MCP_RESULT_BYTE_BUDGET) {
    throw new ApiError(413, "result_too_large", "Use smaller pages or a smaller context budget.");
  }
  return result;
}

export function toolError(error: unknown, secrets: string[]): CallToolResult {
  const detail = (() => {
    if (error instanceof z.ZodError) {
      return {
        code: "invalid_input",
        message: "Invalid tool input. Check field limits.",
        retryable: false,
        nextAction: "fix_input",
        issues: error.issues.slice(0, 10).map(i => ({ path: i.path.map(String).join("."), message: i.message })),
      };
    }
    if (error instanceof ApiError) {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : {};
      const currentRevision = typeof details.serverRevision === "number"
        ? details.serverRevision
        : typeof details.currentRevision === "number"
          ? details.currentRevision
          : null;

      // CK-A03: "retryable" means the SAME request can reasonably succeed
      // later without changing its arguments/state. Deterministic contract,
      // budget, revision and page-token errors must never invite a retry loop.
      const transientStatus = error.status === 429 || error.status === 502 || error.status === 503 || error.status === 504;
      const retryable =
        error.code === "idempotency_in_progress" ||
        transientStatus;
      const nextAction =
        error.code === "idempotency_outcome_unknown" ? "reconcile_state_before_retry"
        : error.code === "idempotency_in_progress" ? "retry_same_event_later"
        : error.code === "stale_revision" ? "read_current_revision"
        : error.code === "context_delta_page_expired" ? "restart_from_committed_cursors"
        : error.code === "context_delta_page_offset_invalid" || error.code === "context_delta_page_token_invalid" ? "discard_page_token"
        : error.code === "context_budget_unrepresentable" || error.code === "result_too_large" ? "increase_budget_or_reduce_request"
        : error.code === "mcp_output_schema_mismatch" ? "report_contract_error"
        : transientStatus ? "retry_same_request"
        : "fix_input_or_state";
      return {
        code: error.code,
        message: error.message,
        retryable,
        nextAction,
        ...(currentRevision !== null ? { currentRevision } : {}),
      };
    }
    return {
      code: "internal_error",
      message: "ContextKeep could not complete this operation.",
      retryable: false,
      nextAction: "report_internal_error",
    };
  })();
  const validated = McpToolErrorResult.parse({ error: detail });
  return { ...toolResult(validated, secrets), isError: true };
}

/** Reuse F07 storage/recovery; never create a second idempotency database. */
export async function durableWrite(
  deps: ServiceDeps, name: string, input: { idempotencyKey: string },
  operation: () => unknown | Promise<unknown>, secrets: string[],
): Promise<CallToolResult> {
  const key = `mcp:${input.idempotencyKey}`;
  const hash = requestHash("MCP", name, input);
  const outcome = tryClaim(deps.sqlite, { key, method: "MCP", url: name, requestHash: hash });
  if (!outcome.fresh) {
    if (outcome.claim.requestHash !== hash) {
      throw new ApiError(409, "idempotency_key_reused", "Use a new idempotencyKey for a different operation.");
    }
    if (outcome.claim.state === "completed" && outcome.claim.responseBody !== null) {
      return JSON.parse(outcome.claim.responseBody) as CallToolResult;
    }
    if (outcome.claim.state === "completed") {
      throw new ApiError(409, "idempotency_result_expired", IDEMPOTENCY_RESULT_EXPIRED_MESSAGE);
    }
    throw new ApiError(409, outcome.claim.state === "pending" ? "idempotency_in_progress" : "idempotency_outcome_unknown",
      "The earlier operation is running or has an unknown outcome. Inspect project state before retrying.");
  }
  let result: CallToolResult;
  let state: "completed" | "indeterminate" = "completed";
  try {
    result = toolResult(await operation(), secrets);
  } catch (error) {
    const outcomeUnknown = !(error instanceof ApiError) || error.status >= 500;
    state = outcomeUnknown ? "indeterminate" : "completed";
    result = outcomeUnknown
      ? toolError(
          new ApiError(
            409,
            "idempotency_outcome_unknown",
            "The write may have been applied before the operation failed. Reconcile current state before deciding whether to retry with the same idempotencyKey.",
          ),
          secrets,
        )
      : toolError(error, secrets);
  }
  finalizeClaim(deps.sqlite, { key, state, responseStatus: 200,
    responseBody: state === "completed" ? JSON.stringify(result) : "",
    responseContentType: "application/json" });
  return result;
}

/** Synchronous mutations and replay receipt share one transaction, including crash recovery. */
export function atomicWrite(deps: ServiceDeps, name: string, input: {idempotencyKey: string},
  operation: () => unknown, secrets: string[]): CallToolResult {
  return deps.sqlite.transaction(() => {
    const key = "mcp:" + input.idempotencyKey;
    const hash = requestHash("MCP", name, input);
    const claim = tryClaim(deps.sqlite, {key,method:"MCP",url:name,requestHash:hash});
    if (!claim.fresh) {
      if (claim.claim.requestHash !== hash) throw new ApiError(409,"idempotency_key_reused","Use a new idempotencyKey for a different operation.");
      if (claim.claim.state === "completed" && claim.claim.responseBody !== null) return JSON.parse(claim.claim.responseBody) as CallToolResult;
      if (claim.claim.state === "completed") throw new ApiError(409,"idempotency_result_expired",IDEMPOTENCY_RESULT_EXPIRED_MESSAGE);
      throw new ApiError(409,claim.claim.state === "pending" ? "idempotency_in_progress" : "idempotency_outcome_unknown","Inspect the earlier operation before retrying.");
    }
    let result: CallToolResult;
    try {
      result = deps.sqlite.transaction(() => {
        const value = operation();
        if (value instanceof Promise) throw new Error("Async operation in atomicWrite");
        return toolResult(value,secrets);
      })();
    } catch (error) {
      result = toolError(error,secrets);
      if (!(error instanceof ApiError) || error.status >= 500) {
        // The business mutation and result serialization live inside the nested
        // savepoint above. If either throws, SQLite has already rolled the
        // mutation back before we arrive here, so the outcome is known-safe to
        // retry. Release the claim instead of permanently caching an internal
        // failure as a completed receipt.
        deps.sqlite.prepare("DELETE FROM idempotency_requests WHERE key = ? AND state = 'pending'").run(key);
        return result;
      }
    }
    finalizeClaim(deps.sqlite,{key,state:"completed",responseStatus:200,responseBody:JSON.stringify(result),responseContentType:"application/json"});
    return result;
  })();
}
