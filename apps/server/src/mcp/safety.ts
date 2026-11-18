import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpToolErrorResult } from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps } from "../services/import.js";
import { safeText } from "../services/redaction.js";
export { safeText } from "../services/redaction.js";
import {
  finalizeClaim,
  IDEMPOTENCY_RESULT_EXPIRED_MESSAGE,
  requestHash,
  tryClaim,
} from "../services/idempotency.js";

import { MCP_RESULT_BYTE_BUDGET } from "../lib/result-budget.js";
export { MCP_RESULT_BYTE_BUDGET } from "../lib/result-budget.js";

function boundedResult(result: CallToolResult): CallToolResult {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MCP_RESULT_BYTE_BUDGET) {
    throw new ApiError(413, "result_too_large", "Use smaller pages or a smaller context budget.");
  }
  return result;
}

function replayStoredResult(body: string, secrets: string[]): CallToolResult {
  try {
    const result = safeValue(JSON.parse(body), secrets) as CallToolResult;
    if (!result || typeof result !== "object" || !Array.isArray(result.content)) throw new Error("Invalid stored result");
    return boundedResult(result);
  } catch {
    // Old receipts can predate the complete-result budget. Retain their event
    // identity and never invoke the mutation again merely to rebuild a reply.
    throw new ApiError(409, "idempotency_result_unavailable", "The earlier request completed, but its stored reply cannot be returned safely. Reconcile existing state; do not replace the event key.");
  }
}

/** Redact both known credentials and credential-shaped project text at the boundary. */
export function safeValue(value: unknown, secrets: string[]): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    return safeText(item, secrets);
  }));
}

export function rejectCredentials(input: unknown, secrets: string[]): void {
  if (JSON.stringify(input) !== JSON.stringify(safeValue(input, secrets))) {
    throw new ApiError(400, "credential_detected", "Remove credentials before saving project context.");
  }
}

export function toolResult(value: unknown, secrets: string[], maxStructuredBytes?: number): CallToolResult {
  const clean = safeValue(value, secrets) as Record<string, unknown>;
  // The final, credential-redacted result must satisfy any requested byte
  // budget. The service packs before the protocol boundary, so this guard
  // fails closed if a future redaction rule expands it unexpectedly.
  if (maxStructuredBytes !== undefined) {
    const actual = Buffer.byteLength(JSON.stringify(clean), "utf8");
    if (actual > maxStructuredBytes) {
      throw new ApiError(422, "search_budget_exceeded",
        "Redacted search content exceeds maxResultBytes. Increase the budget or narrow the query.");
    }
    const budget = clean.budget;
    if (budget && typeof budget === "object" && !Array.isArray(budget) &&
        (budget as { actualBytes?: unknown }).actualBytes !== actual) {
      throw new ApiError(422, "search_budget_unstable",
        "Search byte count changed during redaction. Increase the budget or narrow the query.");
    }
  }
  const text = JSON.stringify(clean);
  const result: CallToolResult = { content: [{ type: "text", text }], structuredContent: clean };
  // This is the complete MCP result object, including both protocol content
  // and structuredContent. JSON-RPC envelope bytes are transport overhead and
  // are not part of this result budget.
  return boundedResult(result);
}

/** The host receives UI bootstrap once in metadata; the model sees only the
 * opener selection and a small summary. Older widgets can refetch their reads. */
export function panelToolResult(value: unknown, secrets: string[]): CallToolResult {
  const clean = safeValue(value, secrets) as Record<string, unknown>;
  const bootstrap = clean.bootstrap as Record<string, unknown>;
  const structuredContent = { ...clean, bootstrap: { ...bootstrap, reads: [], uiData: "metadata" } };
  return boundedResult({
    content: [{ type: "text", text: "ContextKeep panel opened. Selecting a task does not start execution." }],
    structuredContent, _meta: { contextkeepPanelBootstrap: bootstrap },
  });
}

/** Only for readSource output: its text fields were redacted in full before slicing.
 * Redacting fragments again can expand a partial marker and invalidate offsets/hash.
 * Metadata still passes through the ordinary credential boundary.
 */
export function sourcePageResult(value: unknown, secrets: string[]): CallToolResult {
  const page = value as { text: string; excerpts: Array<{ text: string }> };
  const clean = safeValue(value, secrets) as typeof page;
  clean.text = page.text;
  clean.excerpts.forEach((excerpt, index) => { excerpt.text = page.excerpts[index]!.text; });
  return boundedResult({ content: [{ type: "text", text: JSON.stringify(clean) }], structuredContent: clean });
}

/** Preserve offset-compatible snippets after the full normalized texts were masked. */
export function sourceDiscoveryResult(value: unknown, secrets: string[]): CallToolResult {
  type Discovery = { results: Array<{ excerpt: { text: string } | null }> };
  const page = value as Discovery;
  const clean = safeValue(value, secrets) as Discovery;
  clean.results.forEach((result, index) => {
    if (result.excerpt) result.excerpt.text = page.results[index]!.excerpt!.text;
  });
  return boundedResult({ content: [{ type: "text", text: JSON.stringify(clean) }], structuredContent: clean });
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
        ["idempotency_outcome_unknown", "idempotency_result_expired", "idempotency_result_unavailable"].includes(error.code) ? "reconcile_state_before_retry"
        : error.code === "idempotency_in_progress" ? "retry_same_event_later"
        : error.code === "credential_detected" ? "remove_credentials"
        : error.code === "task_revision_conflict" || error.code === "task_progress_conflict" ? "resume_task_and_reconcile"
        : error.code === "checkpoint_task_required" || error.code === "checkpoint_scope_conflict" ? "select_task_or_explicit_project_note"
        : error.code === "task_project_mismatch" ? "select_task_in_project"
        : error.code === "search_budget_exceeded" ? "use_cards_or_narrow_search"
        : error.code === "search_budget_too_small" ? "increase_budget_or_narrow_search"
        : error.code === "stale_revision" ? "read_current_revision"
        : error.code === "project_catalogue_changed" ? "restart_catalogue_from_first_page"
        : error.code === "context_delta_page_expired" ? "restart_from_committed_cursors"
        : error.code === "context_delta_page_offset_invalid" || error.code === "context_delta_page_token_invalid" ? "discard_page_token"
        : ["record_revision_changed", "record_evidence_changed"].includes(error.code) ? "restart_record_from_first_page"
        : error.code === "source_evidence_changed" ? "restart_source_from_first_page"
        : error.code === "protected_context_budget_too_small" ? "increase_context_budget"
        : error.code === "protected_context_requires_detail_reads" ? "read_protected_records"
        : error.code === "result_too_large" ? "reduce_page_or_request"
        : error.code === "context_budget_unrepresentable" ? "increase_budget_or_reduce_request"
        : error.code === "mcp_output_schema_mismatch" ? "report_contract_error"
        : transientStatus ? "retry_same_request"
        : "fix_input_or_state";
      return {
        code: error.code,
        message: error.message,
        retryable,
        nextAction,
        ...(error.code === "project_catalogue_changed" ? { resetRequired: true } : {}),
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
  // Diagnostics are bounded too: error handling must not throw a second
  // size error while reporting an oversized or malformed result.
  detail.code = detail.code.slice(0, 128);
  detail.message = detail.message.slice(0, 2000);
  if ("issues" in detail && Array.isArray(detail.issues)) {
    detail.issues = detail.issues.map((issue) => ({ path: issue.path.slice(0, 256), message: issue.message.slice(0, 512) }));
  }
  const validated = McpToolErrorResult.parse({ error: detail });
  return boundedResult({ ...toolResult(validated, secrets), isError: true });
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
      return replayStoredResult(outcome.claim.responseBody, secrets);
    }
    if (outcome.claim.state === "completed") {
      throw new ApiError(409, "idempotency_result_expired", IDEMPOTENCY_RESULT_EXPIRED_MESSAGE);
    }
    throw new ApiError(409, outcome.claim.state === "pending" ? "idempotency_in_progress" : "idempotency_outcome_unknown",
      "The earlier operation is running or has an unknown outcome. Inspect project state before retrying.");
  }
  let result: CallToolResult;
  let state: "completed" | "indeterminate" = "completed";
  let operationReturned = false;
  try {
    const value = await operation();
    operationReturned = true;
    result = toolResult(value, secrets);
  } catch (error) {
    const outcomeUnknown = operationReturned || !(error instanceof ApiError) || error.status >= 500;
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

/** Lookup only: permits old trim-before-limit requests to replay, never to mutate. */
export function legacyWriteReplay(deps: ServiceDeps, name: string, input: { idempotencyKey: string }, secrets: string[]): CallToolResult | null {
  const row = deps.sqlite.prepare("SELECT request_hash,state,response_body FROM idempotency_requests WHERE key=?").get("mcp:" + input.idempotencyKey) as { request_hash: string; state: string; response_body: string | null } | undefined;
  if (!row || row.request_hash !== requestHash("MCP", name, input)) return null;
  if (row.state === "completed" && row.response_body !== null) return replayStoredResult(row.response_body, secrets);
  if (row.state === "completed") throw new ApiError(409, "idempotency_result_expired", IDEMPOTENCY_RESULT_EXPIRED_MESSAGE);
  throw new ApiError(409, row.state === "pending" ? "idempotency_in_progress" : "idempotency_outcome_unknown", "Inspect the earlier operation before retrying.");
}

/** Synchronous mutations and replay receipt share one transaction, including crash recovery. */
export function atomicWrite(deps: ServiceDeps, name: string, input: {idempotencyKey: string},
  operation: () => unknown, secrets: string[], compatibility?: { legacyInput: unknown; version: string }): CallToolResult {
  return deps.sqlite.transaction(() => {
    const key = "mcp:" + input.idempotencyKey;
    const hash = requestHash("MCP", compatibility ? name + ":" + compatibility.version : name, input);
    const legacyHash = compatibility ? requestHash("MCP", name, compatibility.legacyInput) : null;
    const claim = tryClaim(deps.sqlite, {key,method:"MCP",url:name,requestHash:hash});
    if (!claim.fresh) {
      if (claim.claim.requestHash !== hash && claim.claim.requestHash !== legacyHash) throw new ApiError(409,"idempotency_key_reused","Use a new idempotencyKey for a different operation.");
      if (claim.claim.state === "completed" && claim.claim.responseBody !== null) return replayStoredResult(claim.claim.responseBody, secrets);
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
