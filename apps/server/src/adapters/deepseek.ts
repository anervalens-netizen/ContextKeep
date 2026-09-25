import type {
  AdapterCandidate,
  AdapterExtractInput,
  AdapterExtractResult,
  AdapterUsage,
  AdapterUsageEstimate,
  ExtractionAdapter,
} from "@contextkeep/shared";
import { ApiError } from "../lib/errors.js";
import { createProviderAbortGuard } from "./abort.js";

/**
 * DeepSeek provider adapter (M2.5 directive — owner-decision primary).
 *
 * Real network-backed extraction against the OFFICIAL DeepSeek API. Server-side
 * only; ContextKeep calls DeepSeek directly and never proxies through DSH.
 *
 * Canonical model: `deepseek-flash` (= DeepSeek-V4.1-Flash).
 * Verified by live probe (M2.5 §3) before implementation: HTTP 200, returned
 * model `deepseek-flash`, thinking mode active, `reasoning_effort: "max"`
 * accepted, `response_format: {"type":"json_object"}` compatible with max
 * reasoning, `reasoning_content` returned separately from `content`.
 *
 * Contract (handoff §12 item 13, M2.4e §7, M2.5 §4):
 *  - costCategory="paid": the official API is billed per token (proven, not
 *    assumed — see cost note below). estimateUsage() therefore MUST return a
 *    non-null, finite, >= 0 upper bound and MUST price it in real USD, so a
 *    paid provider cannot bypass CK_COST_CEILING_USD.
 *  - extract() returns AdapterExtractResult: candidates AND usage are
 *    request-scoped, so concurrent imports cannot cross-contaminate.
 *  - A20: evidenceBasis="owner_declaration" is clamped to "agent_report".
 *  - Evidence integrity: excerptId validated against the input set;
 *    hallucinated ids are dropped.
 *  - Output remains review_status="proposed" — the provider never accepts.
 *  - No SDK, no retry: native fetch + AbortController timeout only.
 *
 * Reasoning separation (M2.5 §4): the response carries `message.content` and
 * `message.reasoning_content`. ONLY `message.content` is ever parsed.
 * `reasoning_content` is never read, parsed, stored, persisted, logged,
 * turned into evidence, or shown in the UI. This adapter never dereferences
 * that field at all. No `<think>` stripping is used: a non-JSON `content` is
 * a safe failure, never a silently salvaged partial extraction.
 *
 * Cost note (M2.5 §5, re-priced 2026-09-12) — no stale V4 Flash pricing is
 * hardcoded. Rates below are the CURRENT published `deepseek-v4-flash` rates
 * (USD per 1M tokens):
 *   input (cache hit)  : 0.014
 *   input (cache miss) : 0.44
 *   output             : 1.32
 * These are the peak (higher) tier, so pricing every token at peak is a
 * conservative upper bound that can never under-report the bill, at any hour.
 * The model maximum output is 384K tokens; ContextKeep deliberately uses a
 * much smaller bounded default (32768) instead. Billing semantics were
 * verified as metered (not subscription): the DSH cost ledger records a
 * non-zero `apiCost` for `deepseek-official:deepseek-flash`, unlike the
 * MiniMax Token Plan whose `apiCost` is 0.
 *
 * Env vars (read lazily per call so they need not exist at boot; required
 * only when "deepseek" is in CK_ADAPTERS):
 *   DEEPSEEK_API_KEY                        required when 'deepseek' enabled
 *   CK_DEEPSEEK_MODEL                       default "deepseek-flash"
 *   CK_DEEPSEEK_BASE_URL                    default "https://api.deepseek.com"
 *   CK_DEEPSEEK_THINKING                    default "on"  (on|off)
 *   CK_DEEPSEEK_REASONING_EFFORT            default "max" (low|high|max)
 *   CK_DEEPSEEK_TIMEOUT_MS                  default 120000
 *   CK_DEEPSEEK_MAX_OUTPUT_TOKENS           default 32768
 *   CK_DEEPSEEK_MAX_INPUT_CHARS             default 200000 (anti-runaway)
 *   CK_DEEPSEEK_INPUT_USD_PER_MTOK          default 0.44 (cache-miss, peak)
 *   CK_DEEPSEEK_INPUT_CACHE_HIT_USD_PER_MTOK default 0.014 (cache-hit, peak)
 *   CK_DEEPSEEK_OUTPUT_USD_PER_MTOK         default 1.32 (peak)
 *
 * The credential is injected into the process environment by systemd
 * (EnvironmentFile, mode 0600) exactly like the existing provider secret.
 * It is NEVER logged, persisted, returned via /api/meta, or echoed.
 */

const DEFAULTS = {
  model: "deepseek-flash",
  baseUrl: "https://api.deepseek.com",
  timeoutMs: 120_000,
  // Bounded default, NOT the model maximum (384K). A real project-history
  // extraction was truncated at the previous 8192 bound, so the bound is
  // raised to a headroom level that still keeps a single pre-flight estimate
  // under CK_COST_CEILING_USD (0.05) for the real artifact sizes.
  maxOutputTokens: 32_768,
  maxInputChars: 200_000,
  reasoningEffort: "max",
  inputCacheMissUsdPerMTok: 0.44,
  inputCacheHitUsdPerMTok: 0.014,
  outputUsdPerMTok: 1.32,
};

/** JSON shape example. DeepSeek JSON Output requires the word "json" plus an
 *  example of the desired structure in the system or user prompt. */
const EXTRACTION_EXAMPLE = `{
  "candidates": [
    {
      "type": "fact",
      "subject": "<short subject>",
      "predicate": "<verb phrase, or null>",
      "valueJson": null,
      "text": "<one atomic claim, worded only as far as the excerpt supports it>",
      "evidenceBasis": "document",
      "taskStatus": null,
      "sourceEventAt": null,
      "excerptId": "EXCERPT_ID_COPIED_FROM_INPUT",
      "relation": "supports",
      "confidence": 0.9,
      "volatile": false
    }
  ]
}`;

/**
 * Extraction system prompt (M2.5 §6 — extraction-quality pass).
 *
 * The MiniMax live test returned only the decision from an input holding four
 * facts, a decision and an action. The rules below raise recall by requiring
 * every distinct supported claim across all five candidate types, while the
 * atomicity and ignore rules keep the result from degenerating into
 * "one candidate per sentence".
 */
const SYSTEM_PROMPT =
  "You are the extraction agent for ContextKeep, a private project-memory system. " +
  "Read the input excerpts and return a json object listing EVERY distinct atomic claim that the excerpts explicitly support.\n\n" +
  "Return only a json object. Add no prose, no markdown fences, and no commentary. The json object must follow exactly this shape:\n" +
  EXTRACTION_EXAMPLE +
  "\n\nRules:\n" +
  "1. Extract all distinct, relevant, explicitly supported claims, covering every type that occurs: " +
  '"fact" (a stated state of affairs), "decision" (a choice that was made), ' +
  '"action" (work to do or already in progress), "constraint" (a rule, limit, or requirement), ' +
  'and "question" (an open question). Do not stop after the first claim you find.\n' +
  "2. Emit one candidate per atomic semantic claim. When a single sentence carries two independent claims, emit two candidates. " +
  "Never merge unrelated claims into one candidate, and never split a single claim across several candidates.\n" +
  "3. Never infer, generalise, or add information that is not present in the excerpts. Every candidate must be directly supported by the excerpt it cites.\n" +
  "4. Ignore greetings, filler, acknowledgements, repetitions of a claim you already extracted, generic conversational commentary, and reasoning about how to answer.\n" +
  "5. Copy 'excerptId' exactly from the excerpt header that supports the claim. Never invent an id, and never cite an excerpt that does not support the claim.\n" +
  "6. Set 'volatile': true for any claim about current runtime state, configuration, versions, deployment state, which providers or components are enabled or disabled, " +
  "or process and service status — anything that can change while the text stays the same. Otherwise set false.\n" +
  '7. Never set \'evidenceBasis\' to "owner_declaration". Extraction can never produce owner-confirmed evidence; use "document" for claims read from the excerpts.\n' +
  '8. Always set \'relation\' to "supports", or "contradicts" when the excerpt contradicts an earlier claim.\n' +
  "9. Every candidate is a proposal for the owner to review. Extraction never accepts, confirms, or rejects a record.";

function readConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: process.env.CK_DEEPSEEK_MODEL ?? DEFAULTS.model,
    baseUrl: (process.env.CK_DEEPSEEK_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
    timeoutMs: Number(process.env.CK_DEEPSEEK_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    maxOutputTokens:
      Number(process.env.CK_DEEPSEEK_MAX_OUTPUT_TOKENS) || DEFAULTS.maxOutputTokens,
    maxInputChars:
      Number(process.env.CK_DEEPSEEK_MAX_INPUT_CHARS) || DEFAULTS.maxInputChars,
    reasoningEffort: process.env.CK_DEEPSEEK_REASONING_EFFORT ?? DEFAULTS.reasoningEffort,
    thinkingOn: (process.env.CK_DEEPSEEK_THINKING ?? "on").toLowerCase() !== "off",
    inputCacheMissUsdPerMTok:
      Number(process.env.CK_DEEPSEEK_INPUT_USD_PER_MTOK) || DEFAULTS.inputCacheMissUsdPerMTok,
    inputCacheHitUsdPerMTok:
      Number(process.env.CK_DEEPSEEK_INPUT_CACHE_HIT_USD_PER_MTOK) ||
      DEFAULTS.inputCacheHitUsdPerMTok,
    outputUsdPerMTok:
      Number(process.env.CK_DEEPSEEK_OUTPUT_USD_PER_MTOK) || DEFAULTS.outputUsdPerMTok,
  };
}

type DeepSeekConfig = ReturnType<typeof readConfig>;

/** Exact user content the request will carry — shared by pre-flight and extract
 *  so the cost estimate covers the real prompt, not just the raw excerpts. */
function buildUserContent(excerpts: AdapterExtractInput["excerpts"]): string {
  return excerpts
    .map((e) => `--- excerpt ${e.id} (offset ${e.startOffset}-${e.endOffset}) ---\n${e.text}`)
    .join("\n");
}

function promptChars(input: AdapterExtractInput): number {
  return SYSTEM_PROMPT.length + buildUserContent(input.excerpts).length;
}

/**
 * Conservative pre-flight input-token upper bound, measured over the exact
 * prompt that will be sent. Divided by 2.5 chars/token rather than the ~4
 * chars/token English average because excerpt ids are UUIDs and tokenize far
 * more densely; a genuine upper bound keeps the pipeline's
 * `actualCost <= preflightUpperBound` invariant free of false anomalies.
 */
function estimateInputTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 2.5));
}

function assertInputWithinBounds(input: AdapterExtractInput, cfg: DeepSeekConfig): void {
  const totalChars = input.excerpts.reduce((s, e) => s + e.text.length, 0);
  if (totalChars > cfg.maxInputChars) {
    throw new ApiError(
      409,
      "deepseek_input_too_large",
      `Input too large for DeepSeek: ${totalChars} chars > configured max ${cfg.maxInputChars}. ` +
        `Trim the input or raise CK_DEEPSEEK_MAX_INPUT_CHARS.`,
      { totalChars, maxInputChars: cfg.maxInputChars },
    );
  }
}

function pricedUsage(
  inputTokens: number,
  outputTokens: number,
  model: string,
  cacheMissTokens: number | null,
  cacheHitTokens: number | null,
  cfg: Pick<
    DeepSeekConfig,
    "inputCacheMissUsdPerMTok" | "inputCacheHitUsdPerMTok" | "outputUsdPerMTok"
  >,
): AdapterUsage {
  // When the provider does not expose the cache split, price the whole input
  // at the higher cache-miss rate — never the cheaper one.
  const miss = cacheMissTokens ?? inputTokens;
  const hit = cacheHitTokens ?? Math.max(0, inputTokens - miss);
  const estCostUsd =
    (miss / 1_000_000) * cfg.inputCacheMissUsdPerMTok +
    (hit / 1_000_000) * cfg.inputCacheHitUsdPerMTok +
    (outputTokens / 1_000_000) * cfg.outputUsdPerMTok;
  return { inputTokens, outputTokens, estCostUsd, model };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const VALID_TASK_STATUSES = new Set(["open", "in_progress", "blocked", "done", "cancelled"]);

export const deepseekAdapter: ExtractionAdapter = {
  id: "deepseek",
  version: "1.0.0",
  label: "DeepSeek (V4.1 Flash via the official DeepSeek API — thinking + JSON output)",
  costCategory: "paid",

  async estimateUsage(input): Promise<AdapterUsageEstimate> {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "deepseek_missing_api_key",
        "DEEPSEEK_API_KEY is not configured; cannot call the DeepSeek provider.",
      );
    }
    assertInputWithinBounds(input, cfg);
    // Conservative pre-flight upper bound: every input token at the peak
    // cache-miss rate, every output token at the peak output rate.
    return pricedUsage(
      estimateInputTokens(promptChars(input)),
      cfg.maxOutputTokens,
      cfg.model,
      null,
      null,
      cfg,
    );
  },

  async extract(input, callerSignal?: AbortSignal): Promise<AdapterExtractResult> {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        409,
        "deepseek_missing_api_key",
        "DEEPSEEK_API_KEY is not configured; cannot call the DeepSeek provider.",
      );
    }
    // Anti-runaway guard on the input side: refuse BEFORE network.
    assertInputWithinBounds(input, cfg);

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
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: buildUserContent(input.excerpts) },
            ],
            thinking: { type: cfg.thinkingOn ? "enabled" : "disabled" },
            reasoning_effort: cfg.reasoningEffort,
            response_format: { type: "json_object" },
            stream: false,
            // DeepSeek's documented token-limit field for Chat Completions.
            // No temperature: thinking mode ignores sampling parameters.
            max_tokens: cfg.maxOutputTokens,
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
            "deepseek_timeout",
            `DeepSeek request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(
          409,
          "deepseek_unavailable",
          `DeepSeek request failed: ${e instanceof Error ? e.message : String(e)}.`,
        );
      }

      if (resp.status === 401 || resp.status === 403) {
        throw new ApiError(
          409,
          "deepseek_auth_failed",
          `DeepSeek authentication failed (status ${resp.status}).`,
        );
      }
      if (resp.status === 429) {
        throw new ApiError(409, "deepseek_rate_limited", "DeepSeek rate limit exceeded.");
      }
      if (resp.status >= 500 && resp.status < 600) {
        throw new ApiError(
          409,
          "deepseek_unavailable",
          `DeepSeek returned status ${resp.status}.`,
        );
      }
      if (!resp.ok) {
        throw new ApiError(
          409,
          "deepseek_unavailable",
          `DeepSeek returned status ${resp.status}.`,
        );
      }

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
            "deepseek_timeout",
            `DeepSeek request timed out after ${cfg.timeoutMs}ms.`,
          );
        }
        throw new ApiError(409, "deepseek_malformed_output", "DeepSeek returned non-JSON response.");
      }
    } finally {
      // The deadline covers fetch and complete body consumption, not merely
      // receipt of response headers.
      abortGuard.dispose();
    }

    // Usage capture. Exact DeepSeek shape (live-probe verified):
    //   prompt_tokens, completion_tokens, total_tokens,
    //   prompt_cache_hit_tokens, prompt_cache_miss_tokens,
    //   prompt_tokens_details.cached_tokens,
    //   completion_tokens_details.reasoning_tokens
    const usageRaw = ((body as { usage?: Record<string, unknown> })?.usage ?? {}) as Record<
      string,
      unknown
    >;
    const inputTokens = num(usageRaw["prompt_tokens"]);
    const outputTokens = num(usageRaw["completion_tokens"]);
    const cacheHitRaw =
      num(usageRaw["prompt_cache_hit_tokens"]) ??
      num((usageRaw["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]);
    const cacheMissRaw = num(usageRaw["prompt_cache_miss_tokens"]);
    const usage: AdapterUsage | null =
      inputTokens !== null || outputTokens !== null
        ? pricedUsage(
            inputTokens ?? 0,
            outputTokens ?? 0,
            cfg.model,
            cacheMissRaw,
            cacheHitRaw,
            cfg,
          )
        : null;

    // Reasoning-token COUNT is billable usage metadata and never reasoning
    // text. `reasoning_content` itself is deliberately never dereferenced.
    const choice = (body as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    })?.choices?.[0];
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;

    // Truncation is a safe failure, never a salvaged partial extraction.
    if (finishReason === "length") {
      throw new ApiError(
        409,
        "deepseek_output_truncated",
        `DeepSeek stopped at the output token bound (${cfg.maxOutputTokens}); the extraction is ` +
          `truncated and was discarded. Raise CK_DEEPSEEK_MAX_OUTPUT_TOKENS or shorten the input.`,
        { finishReason, maxOutputTokens: cfg.maxOutputTokens, usage },
      );
    }

    // ONLY message.content may enter JSON parsing.
    const content = choice?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      // DeepSeek documents that JSON Output may occasionally return empty
      // content — treat it exactly like malformed output: a safe failure.
      throw new ApiError(
        409,
        "deepseek_malformed_output",
        "DeepSeek response missing assistant content.",
        { finishReason },
      );
    }

    let parsed: { candidates?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ApiError(
        409,
        "deepseek_malformed_output",
        "DeepSeek assistant content is not valid JSON.",
        { finishReason },
      );
    }
    if (!parsed || !Array.isArray(parsed.candidates)) {
      throw new ApiError(
        409,
        "deepseek_malformed_output",
        "DeepSeek assistant content missing 'candidates' array.",
        { finishReason },
      );
    }

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
        // Hallucinated / missing excerpt id, unknown type, or absent required
        // fields — dropped, never persisted, never turned into evidence.
        continue;
      }

      // A20: extraction can never produce owner-confirmed evidence.
      const evidenceBasis =
        raw.evidenceBasis === "owner_declaration"
          ? "agent_report"
          : (raw.evidenceBasis as AdapterCandidate["evidenceBasis"]);

      candidates.push({
        type: raw.type as AdapterCandidate["type"],
        subject: raw.subject,
        predicate: typeof raw.predicate === "string" ? raw.predicate : null,
        valueJson: raw.valueJson ?? null,
        text: raw.text,
        evidenceBasis: evidenceBasis as AdapterCandidate["evidenceBasis"],
        taskStatus:
          typeof raw.taskStatus === "string" && VALID_TASK_STATUSES.has(raw.taskStatus)
            ? (raw.taskStatus as NonNullable<AdapterCandidate["taskStatus"]>)
            : null,
        sourceEventAt: typeof raw.sourceEventAt === "string" ? raw.sourceEventAt : null,
        excerptId: raw.excerptId,
        relation: raw.relation === "contradicts" ? "contradicts" : "supports",
        confidence: typeof raw.confidence === "number" ? raw.confidence : null,
        volatile: raw.volatile === true,
      });
    }

    return { candidates, usage };
  },
};
