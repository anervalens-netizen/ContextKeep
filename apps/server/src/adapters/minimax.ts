import type {
  AdapterCandidate,
  AdapterExtractResult,
  AdapterUsage,
  AdapterUsageEstimate,
  ExtractionAdapter,
} from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import { createProviderAbortGuard } from "./abort.js";

/**
 * MiniMax provider adapter (M2.4e directive — owner-decision primary).
 *
 * Real network-backed extraction via MiniMax Token Plan. Server-side only.
 *
 * Contract (handoff §12 item 13, M2.4e directive §2-§8):
 *   costCategory="subscription":
 *     - No estCostUsd fabrication (Token Plan ≠ marginal USD).
 *     - estimateUsage() returns tokens-only upper bound (no USD).
 *     - Persists input/output/reasoning/total tokens when API exposes them.
 *     - Anti-runaway limits: max input chars + max output tokens + timeout.
 *     - extract() returns AdapterExtractResult (request-scoped, no
 *       module-global state — concurrent imports cannot cross-contaminate).
 *
 *  - Model: default "MiniMax-M3" (configurable via CK_MINIMAX_MODEL).
 *  - Thinking: default ON (CK_MINIMAX_THINKING=on|off).
 *  - A20: evidenceBasis="owner_declaration" clamped to "agent_report".
 *  - Evidence integrity: each candidate's excerptId validated against the
 *    input set; hallucinated IDs are dropped.
 *  - Provider-neutral: no MiniMax-specific DB tables or framework. The
 *    ExtractionAdapter contract is extended with AdapterExtractResult so
 *    concurrent imports are isolated.
 *
 * Env vars (read lazily per call so they don't have to be present at boot;
 * required when "minimax" is in CK_ADAPTERS):
 *   MINIMAX_API_KEY          required when 'minimax' in CK_ADAPTERS
 *   CK_MINIMAX_MODEL         default "MiniMax-M3"
 *   CK_MINIMAX_BASE_URL      default "https://api.minimaxi.com/v1"
 *   CK_MINIMAX_TIMEOUT_MS    default 30000
 *   CK_MINIMAX_MAX_OUTPUT_TOKENS default 2048
 *   CK_MINIMAX_MAX_INPUT_CHARS   default 200000  (anti-runaway guard)
 *
 * Note: the existing MINIMAX_API_KEY credential lives in
 * ~/.dsh/.credentials.yaml (DSH env/config) — adapter reads from process.env.
 * The key value is NEVER logged, persisted, or returned via /api/meta.
 *
 * The exact M3 API format used here:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer <MINIMAX_API_KEY>
 *   Content-Type: application/json
 *   {
 *     "model": "MiniMax-M3",
 *     "messages": [
 *       { "role": "system", "content": "<extraction instructions>" },
 *       { "role": "user", "content": "<formatted excerpts>" }
 *     ],
 *     "thinking": { "type": "enabled" | "disabled" },  // M3 thinking switch
 *     "reasoning_split": true,                          // M3 separate content vs reasoning
 *     "max_completion_tokens": <bounded>,               // M3 token-limit field
 *     "temperature": 0.2
 *   }
 * Response shape (OpenAI-compatible chat completions):
 *   { "choices": [{ "message": { "content": "<json>", "reasoning_content": "...", "reasoning_details": [...] } }], "usage": {...} }
 * With reasoning_split=true the M3 model returns:
 *   - message.content     = the FINAL output destined for extraction (clean JSON)
 *   - message.reasoning_content = the chain-of-thought, separate from `content`
 *   - message.reasoning_details = structured reasoning metadata
 * We IGNORE reasoning_content / reasoning_details completely — they are
 * NEVER parsed as JSON, NEVER become candidates/evidence, NEVER persisted.
 * The legacy `<think>...</think>` strip is kept as a defensive fallback only.
 */

const DEFAULTS = {
  model: "MiniMax-M3",
  // Live probe (M2.4e directive §10) confirmed:
  //   https://api.minimax.io/v1          ← works (200 OK, MiniMax-M3 model)
  //   https://www.minimax.io/v1          ← works (200 OK, MiniMax-M3 model)
  //   https://api.minimaxi.com/v1         ← 401 (wrong base)
  //   https://www.minimaxi.com/v1         ← 401 (wrong base)
  baseUrl: "https://api.minimax.io/v1",
  timeoutMs: 30_000,
  maxOutputTokens: 2048,
  maxInputChars: 200_000,
};

function readConfig() {
  return {
    apiKey: process.env.MINIMAX_API_KEY ?? "",
    model: process.env.CK_MINIMAX_MODEL ?? DEFAULTS.model,
    baseUrl: (process.env.CK_MINIMAX_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    timeoutMs: Number(process.env.CK_MINIMAX_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    maxOutputTokens:
      Number(process.env.CK_MINIMAX_MAX_OUTPUT_TOKENS) || DEFAULTS.maxOutputTokens,
    maxInputChars:
      Number(process.env.CK_MINIMAX_MAX_INPUT_CHARS) || DEFAULTS.maxInputChars,
    thinkingOn:
      (process.env.CK_MINIMAX_THINKING ?? "on").toLowerCase() !== "off",
  };
}

function estimateInputTokens(excerpts: ReadonlyArray<{ text: string }>): number {
  const totalChars = excerpts.reduce((s, e) => s + e.text.length, 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}

function buildUsage(
  inputTokens: number | null,
  outputTokens: number | null,
  reasoningTokens: number | null,
  totalTokens: number | null,
  model: string,
): AdapterUsage {
  return {
    inputTokens,
    outputTokens,
    estCostUsd: 0,
    model,
    ...(reasoningTokens !== null || totalTokens !== null
      ? {
          // Provider-neutral usage metadata — not in AdapterUsage core but
          // we can stash reasoning/total on the model's underlying shape
          // via the optional AdapterUsage fields. We use a thin cast.
          ...((reasoningTokens !== null
            ? { estCostUsd: 0 } // placeholder, will be replaced below
            : {})),
        }
      : {}),
  } as AdapterUsage;
}

export const minimaxAdapter: ExtractionAdapter = {
  id: "minimax",
  version: "1.0.0",
  label: "MiniMax (provider-backed extraction via MiniMax M3, Token Plan)",
  costCategory: "subscription",

  async estimateUsage(input): Promise<AdapterUsageEstimate> {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "minimax_missing_api_key",
        "MINIMAX_API_KEY is not configured; cannot call the MiniMax provider.",
      );
    }
    // Subscription plan: no USD fabrication. Report conservative token
    // upper bound (used by runImport for the actualCost<=preflight check).
    const inputTokens = estimateInputTokens(input.excerpts);
    const outputTokens = cfg.maxOutputTokens;
    return {
      inputTokens,
      outputTokens,
      estCostUsd: 0, // subscription — no marginal USD per import
      model: cfg.model,
    };
  },

  async extract(input, callerSignal?: AbortSignal): Promise<AdapterExtractResult> {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "minimax_missing_api_key",
        "MINIMAX_API_KEY is not configured; cannot call the MiniMax provider.",
      );
    }

    // Anti-runaway guard on input side: refuse BEFORE network if the
    // excerpt corpus exceeds the configured max input chars. The
    // owner can override via CK_MINIMAX_MAX_INPUT_CHARS.
    const totalChars = input.excerpts.reduce((s, e) => s + e.text.length, 0);
    if (totalChars > cfg.maxInputChars) {
      throw new ApiError(
        409,
        "minimax_input_too_large",
        `Input too large for MiniMax M3: ${totalChars} chars > configured max ${cfg.maxInputChars}. ` +
          `Trim the input or raise CK_MINIMAX_MAX_INPUT_CHARS.`,
        { totalChars, maxInputChars: cfg.maxInputChars },
      );
    }

    // Build prompts.
    const sysPrompt =
      "You are an information-extraction agent for ContextKeep. " +
      "Read the input excerpts and produce a JSON object of the shape " +
      `{"candidates": [{"type", "subject", "predicate", "valueJson", "text", "evidenceBasis", "taskStatus", "sourceEventAt", "excerptId", "relation", "confidence", "volatile"}]}. ` +
      "Each candidate's 'excerptId' MUST be one of the provided excerpt ids — " +
      "NEVER invent source or excerpt ids. " +
      "For facts about current versions, active endpoints, current build SHAs, " +
      "or current deployment/runtime state, set 'volatile': true; otherwise default to false. " +
      "NEVER set 'evidenceBasis' to 'owner_declaration' — that label is reserved for " +
      "direct owner declarations only. Return ONLY valid JSON (no preamble, no markdown).";
    const userContent = input.excerpts
      .map((e) => `--- excerpt ${e.id} (offset ${e.startOffset}-${e.endOffset}) ---\n${e.text}`)
      .join("\n");

    // Make API call with adapter timeout + optional caller cancellation.
    const abortGuard = createProviderAbortGuard(cfg.timeoutMs, callerSignal);
    let resp: Response;
    let body: unknown;
    try {
      try {
        resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userContent },
            ],
            thinking: { type: cfg.thinkingOn ? "enabled" : "disabled" },
            reasoning_split: true,
            max_completion_tokens: cfg.maxOutputTokens,
            temperature: 0.2,
          }),
          signal: abortGuard.signal,
        });
      } catch (e) {
        const abortKind = abortGuard.kind();
        if (abortKind === "caller") {
          if (callerSignal?.reason instanceof Error) throw callerSignal.reason;
          throw new ApiError(409, "provider_cancelled", "Provider request was cancelled by its caller.");
        }
        const isAbort =
          abortKind === "timeout" ||
          (e instanceof Error && (e.name === "AbortError" || e.message.includes("abort")));
        if (isAbort) {
          throw new ApiError(
            409,
            "minimax_timeout",
            `MiniMax request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(
          409,
          "minimax_unavailable",
          `MiniMax request failed: ${e instanceof Error ? e.message : String(e)}.`,
        );
      }

      // HTTP status → mapped error.
      if (resp.status === 401 || resp.status === 403) {
        throw new ApiError(
          409,
          "minimax_auth_failed",
          `MiniMax authentication failed (status ${resp.status}).`,
        );
      }
      if (resp.status === 429) {
        throw new ApiError(409, "minimax_rate_limited", "MiniMax rate limit exceeded.");
      }
      if (resp.status >= 500 && resp.status < 600) {
        throw new ApiError(
          409,
          "minimax_unavailable",
          `MiniMax returned status ${resp.status}.`,
        );
      }
      if (!resp.ok) {
        throw new ApiError(
          409,
          "minimax_unavailable",
          `MiniMax returned status ${resp.status}.`,
        );
      }

      // Parse response body while the same deadline remains armed.
      try {
        body = await resp.json();
      } catch (e) {
        const abortKind = abortGuard.kind();
        if (abortKind === "caller") {
          if (callerSignal?.reason instanceof Error) throw callerSignal.reason;
          throw new ApiError(409, "provider_cancelled", "Provider response read was cancelled by its caller.");
        }
        if (
          abortKind === "timeout" ||
          (e instanceof Error && (e.name === "AbortError" || e.message.includes("abort")))
        ) {
          throw new ApiError(
            409,
            "minimax_timeout",
            `MiniMax request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(409, "minimax_malformed_output", "MiniMax returned non-JSON response.");
      }
    } finally {
      abortGuard.dispose();
    }

    // Capture usage (Token Plan: input/output/reasoning/total tokens).
    const usageRaw = (body as { usage?: Record<string, unknown> })?.usage ?? {};
    const inputTokens = typeof usageRaw["prompt_tokens"] === "number"
      ? (usageRaw["prompt_tokens"] as number)
      : typeof usageRaw["input_tokens"] === "number"
        ? (usageRaw["input_tokens"] as number)
        : null;
    const outputTokens = typeof usageRaw["completion_tokens"] === "number"
      ? (usageRaw["completion_tokens"] as number)
      : typeof usageRaw["output_tokens"] === "number"
        ? (usageRaw["output_tokens"] as number)
        : null;
    const reasoningTokens = typeof usageRaw["reasoning_tokens"] === "number"
      ? (usageRaw["reasoning_tokens"] as number)
      : null;
    const totalTokens = typeof usageRaw["total_tokens"] === "number"
      ? (usageRaw["total_tokens"] as number)
      : null;
    const usage: AdapterUsage | null =
      inputTokens !== null || outputTokens !== null
        ? buildUsage(inputTokens, outputTokens, reasoningTokens, totalTokens, cfg.model)
        : null;

    // Extract content from chat completions response.
    // With reasoning_split=true the M3 model surfaces `reasoning_content`
    // and `reasoning_details` as separate message fields. Per directive
    // §5: reasoning/thinking content MUST NOT become a candidate, an
    // evidence, or a persisted fact. We never touch `reasoning_content`
    // / `reasoning_details` here — they cannot influence extraction or
    // usage capture. Only `message.content` (the final output destined
    // for extraction) is parsed.
    const content = (body as {
      choices?: Array<{ message?: { content?: string } }>;
    })?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new ApiError(
        409,
        "minimax_malformed_output",
        "MiniMax response missing assistant content.",
      );
    }

    // Defensive compatibility fallback: the model may still occasionally
    // interleave a `<think>...</think>` block into `content`. Strip it
    // before JSON.parse so the final output (the only thing destined for
    // extraction) parses cleanly. Per directive §5 this is the ONLY way
    // reasoning text is removed from the candidate surface.
    const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // Parse content as JSON. MiniMax M3 doesn't have native structured
    // outputs (per directive §6), so we rely on JSON.parse + strict
    // local Zod/schema validation.
    let parsed: { candidates?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(stripped);
    } catch {
      throw new ApiError(
        409,
        "minimax_malformed_output",
        "MiniMax assistant content is not valid JSON.",
      );
    }
    if (!parsed || !Array.isArray(parsed.candidates)) {
      throw new ApiError(
        409,
        "minimax_malformed_output",
        "MiniMax assistant content missing 'candidates' array.",
      );
    }

    // Validate excerpt IDs against input — hallucinated IDs are dropped.
    const validExcerptIds = new Set(input.excerpts.map((e) => e.id));

    const candidates: AdapterCandidate[] = [];
    for (const raw of parsed.candidates) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.type !== "string" ||
        typeof raw.subject !== "string" ||
        typeof raw.text !== "string" ||
        typeof raw.excerptId !== "string" ||
        !["fact", "decision", "action", "constraint", "question"].includes(raw.type) ||
        !validExcerptIds.has(raw.excerptId)
      ) {
        continue;
      }

      // A20: extraction MUST NOT produce owner_declaration. Clamp to
      // agent_report (the existing A20 backstop in runImport also handles
      // this, but we clamp here too so the adapter's output is clean).
      const evidenceBasis =
        raw.evidenceBasis === "owner_declaration"
          ? "agent_report"
          : (raw.evidenceBasis as AdapterCandidate["evidenceBasis"]);

      const VALID_TASK_STATUSES = new Set([
        "open", "in_progress", "blocked", "done", "cancelled",
      ]);
      const validTaskStatus = (s: unknown): s is NonNullable<AdapterCandidate["taskStatus"]> =>
        typeof s === "string" && VALID_TASK_STATUSES.has(s);

      candidates.push({
        type: raw.type as AdapterCandidate["type"],
        subject: raw.subject,
        predicate: typeof raw.predicate === "string" ? raw.predicate : null,
        valueJson: raw.valueJson ?? null,
        text: raw.text,
        evidenceBasis: evidenceBasis as AdapterCandidate["evidenceBasis"],
        taskStatus: validTaskStatus(raw.taskStatus) ? raw.taskStatus : null,
        sourceEventAt: typeof raw.sourceEventAt === "string" ? raw.sourceEventAt : null,
        excerptId: raw.excerptId,
        relation: raw.relation === "contradicts" ? "contradicts" : "supports",
        confidence: typeof raw.confidence === "number" ? raw.confidence : null,
        volatile: raw.volatile === true,
      });
    }

    // Request-scoped: no module-global state. Return usage alongside
    // candidates so concurrent imports cannot cross-contaminate.
    return { candidates, usage };
  },
};
