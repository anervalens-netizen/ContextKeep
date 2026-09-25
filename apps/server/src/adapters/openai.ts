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
 * OpenAI provider adapter — real, network-backed, server-side only.
 *
 * Contract (handoff §12 item 13, M2.4e directive):
 *  - costCategory="paid": estimateUsage() MUST be non-null and finite ≥0.
 *  - estimateUsage() returns a CONSERVATIVE UPPER BOUND on the cost
 *    BEFORE any network call. If upper bound > configured ceiling,
 *    runImport refuses BEFORE fetch.
 *  - extract() POSTs to /v1/responses with strict Structured Outputs;
 *    parses, validates, clamps, and returns AdapterCandidate[].
 *  - Actual usage is captured from response.usage and exposed via
 *    getActualUsage() so runImport can persist it separately and run
 *    the actualCost <= preflightUpperBound invariant check.
 *  - A20: evidenceBasis="owner_declaration" is clamped to "agent_report"
 *    (extract does not produce owner-confirmed evidence).
 *  - Evidence integrity: each candidate's excerptId is validated against
 *    the input set; hallucinated excerpt IDs are dropped (not persisted).
 *  - Output remains review_status="proposed" — provider never produces
 *    accepted records directly.
 *  - No SDK; native fetch only. No retry. Timeout via AbortController.
 *
 * Env vars (read lazily on each call so they don't have to be present
 * at boot; only required when the adapter is actually enabled):
 *   OPENAI_API_KEY              required when 'openai' in CK_ADAPTERS
 *   CK_OPENAI_MODEL             default "gpt-5.6-luna"
 *   CK_OPENAI_BASE_URL          default "https://api.openai.com/v1"
 *   CK_OPENAI_TIMEOUT_MS        default 30000
 *   CK_OPENAI_MAX_OUTPUT_TOKENS  default 2048
 *   CK_OPENAI_INPUT_USD_PER_MTOK default 3.00
 *   CK_OPENAI_OUTPUT_USD_PER_MTOK default 15.00
 */

const DEFAULTS = {
  model: "gpt-5.6-luna",
  baseUrl: "https://api.openai.com/v1",
  timeoutMs: 30_000,
  maxOutputTokens: 2048,
  inputPricePerMTok: 3.0,
  outputPricePerMTok: 15.0,
};

/** OpenAI strict-mode JSON Schema (Structured Outputs).
 *  All defined properties MUST be listed in `required` per OpenAI strict mode. */
const OPENAI_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    candidates: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          type: { type: "string" as const, enum: ["fact", "decision", "action", "constraint", "question"] },
          subject: { type: "string" as const },
          predicate: { type: ["string", "null"] },
          valueJson: {},
          text: { type: "string" as const },
          evidenceBasis: {
            type: "string" as const,
            enum: ["owner_declaration", "agent_report", "document", "observed_technical"],
          },
          taskStatus: {
            type: ["string", "null"],
            enum: ["open", "in_progress", "blocked", "done", "cancelled", null],
          },
          sourceEventAt: { type: ["string", "null"] },
          excerptId: { type: "string" as const },
          relation: { type: "string" as const, enum: ["supports", "contradicts"] },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
          volatile: { type: "boolean" as const },
        },
        required: [
          "type",
          "subject",
          "predicate",
          "valueJson",
          "text",
          "evidenceBasis",
          "taskStatus",
          "sourceEventAt",
          "excerptId",
          "relation",
          "confidence",
          "volatile",
        ],
        additionalProperties: false as const,
      },
    },
  },
  required: ["candidates"],
  additionalProperties: false as const,
};

function readConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.CK_OPENAI_MODEL ?? DEFAULTS.model,
    baseUrl: process.env.CK_OPENAI_BASE_URL ?? DEFAULTS.baseUrl,
    timeoutMs: Number(process.env.CK_OPENAI_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    maxOutputTokens: Number(process.env.CK_OPENAI_MAX_OUTPUT_TOKENS) || DEFAULTS.maxOutputTokens,
    inputPricePerMTok:
      Number(process.env.CK_OPENAI_INPUT_USD_PER_MTOK) || DEFAULTS.inputPricePerMTok,
    outputPricePerMTok:
      Number(process.env.CK_OPENAI_OUTPUT_USD_PER_MTOK) || DEFAULTS.outputPricePerMTok,
  };
}

function estimateInputTokens(excerpts: ReadonlyArray<{ text: string }>): number {
  const totalChars = excerpts.reduce((s, e) => s + e.text.length, 0);
  return Math.max(1, Math.ceil(totalChars / 4)); // ~4 chars/token heuristic
}

function buildUsage(
  inputTokens: number,
  outputTokens: number,
  model: string,
  inputPrice: number,
  outputPrice: number,
): AdapterUsage {
  const estCostUsd = (inputTokens / 1_000_000) * inputPrice + (outputTokens / 1_000_000) * outputPrice;
  return { inputTokens, outputTokens, estCostUsd, model };
}

/**
 * OpenAI provider adapter — kept as DISABLED fallback (M2.4e/M2.5). The PRIMARY
 * provider in production is deepseek / "deepseek-flash" (DeepSeek V4.1 Flash,
 * official API). The OpenAI contract (paid, cost ceiling in USD) is preserved
 * for fallback only.
 *
 * Note (M2.4e directive §7): extract() returns AdapterExtractResult so
 * concurrent imports cannot cross-contaminate usage/evidence state. No
 * module-global state — each invocation is fully request-scoped.
 */
export const openaiAdapter: ExtractionAdapter = {
  id: "openai",
  version: "1.0.0",
  label: "OpenAI (provider-backed extraction via Responses API) — DISABLED fallback",
  costCategory: "paid",

  async estimateUsage(input): Promise<AdapterUsageEstimate> {
    const cfg = readConfig();
    // Paid adapter without a usable key can't be safely called — throw the
    // specific error code so the import pipeline surfaces
    // `openai_missing_api_key` (not the generic `estimate_required`).
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "openai_missing_api_key",
        "OPENAI_API_KEY is not configured; cannot call the OpenAI provider.",
      );
    }
    const inputTokens = estimateInputTokens(input.excerpts);
    const outputTokens = cfg.maxOutputTokens;
    return buildUsage(
      inputTokens,
      outputTokens,
      cfg.model,
      cfg.inputPricePerMTok,
      cfg.outputPricePerMTok,
    );
  },

  async extract(input, callerSignal?: AbortSignal): Promise<AdapterExtractResult> {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "openai_missing_api_key",
        "OPENAI_API_KEY is not configured; cannot call the OpenAI provider.",
      );
    }

    // Build prompt.
    const sysPrompt =
      "You are an information-extraction agent for ContextKeep. " +
      "Read the input excerpts and produce a 'candidates' array of structured records " +
      "(type ∈ {fact, decision, action, constraint, question}). " +
      "Each candidate's 'excerptId' MUST be one of the provided excerpt ids — " +
      "NEVER invent source or excerpt ids. " +
      "For facts about current versions, active endpoints, current build SHAs, or " +
      "current deployment/runtime state, set 'volatile': true; otherwise default to false. " +
      "NEVER set 'evidenceBasis' to 'owner_declaration' — that label is reserved for " +
      "direct owner declarations only.";
    const userContent = input.excerpts
      .map((e) => `--- excerpt ${e.id} (offset ${e.startOffset}-${e.endOffset}) ---\n${e.text}`)
      .join("\n");

    // Make API call with adapter timeout + optional caller cancellation.
    const abortGuard = createProviderAbortGuard(cfg.timeoutMs, callerSignal);
    let resp: Response;
    let body: unknown;
    try {
      try {
        resp = await fetch(`${cfg.baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: cfg.model,
            input: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userContent },
            ],
            text: {
              format: {
                type: "json_schema",
                strict: true,
                schema: OPENAI_RESPONSE_SCHEMA,
              },
            },
            max_output_tokens: cfg.maxOutputTokens,
            store: false,
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
            "openai_timeout",
            `OpenAI request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(
          409,
          "openai_unavailable",
          `OpenAI request failed: ${e instanceof Error ? e.message : String(e)}.`,
        );
      }

      // HTTP status → mapped error.
      if (resp.status === 401 || resp.status === 403) {
        throw new ApiError(
          409,
          "openai_auth_failed",
          `OpenAI authentication failed (status ${resp.status}).`,
        );
      }
      if (resp.status === 429) {
        throw new ApiError(409, "openai_rate_limited", "OpenAI rate limit exceeded.");
      }
      if (resp.status >= 500 && resp.status < 600) {
        throw new ApiError(
          409,
          "openai_unavailable",
          `OpenAI returned status ${resp.status}.`,
        );
      }
      if (!resp.ok) {
        throw new ApiError(
          409,
          "openai_unavailable",
          `OpenAI returned status ${resp.status}.`,
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
            "openai_timeout",
            `OpenAI request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(409, "openai_malformed_output", "OpenAI returned non-JSON response.");
      }
    } finally {
      abortGuard.dispose();
    }

    // Capture actual usage FIRST so it's available even if candidate parsing fails.
    const usageObj = (body as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })
      ?.usage;
    const ai = usageObj?.input_tokens;
    const ao = usageObj?.output_tokens;
    const usage: AdapterUsage | null =
      typeof ai === "number" && typeof ao === "number"
        ? buildUsage(ai, ao, cfg.model, cfg.inputPricePerMTok, cfg.outputPricePerMTok)
        : null;

    // Extract structured output text.
    const outputArr = (body as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    })?.output;
    const message = outputArr?.find((o) => o.content?.some((c) => c.type === "output_text"));
    const textContent = message?.content?.find((c) => c.type === "output_text")?.text;
    if (typeof textContent !== "string") {
      throw new ApiError(
        409,
        "openai_malformed_output",
        "OpenAI response missing structured output text.",
      );
    }

    let parsed: { candidates?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(textContent);
    } catch {
      throw new ApiError(
        409,
        "openai_malformed_output",
        "OpenAI structured output is not valid JSON.",
      );
    }
    if (!parsed || !Array.isArray(parsed.candidates)) {
      throw new ApiError(
        409,
        "openai_malformed_output",
        "OpenAI structured output missing 'candidates' array.",
      );
    }

    // Validate excerpt IDs against input — hallucinated IDs are dropped.
    const validExcerptIds = new Set(input.excerpts.map((e) => e.id));

    const out: AdapterCandidate[] = [];
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
        // Drop the candidate — provider hallucinated an excerptId, sent a bad
        // type, or produced an incomplete object. We do NOT persist a
        // candidate that doesn't link to a real input excerpt.
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

      out.push({
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

    // Request-scoped return — no module-global state, so concurrent imports
    // cannot cross-contaminate usage/evidence. The `usage` captured above
    // travels with this exact invocation only.
    return { candidates: out, usage };
  },
};
