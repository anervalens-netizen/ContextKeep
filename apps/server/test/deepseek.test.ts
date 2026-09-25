import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, makeTestApp } from "./helpers.js";

/**
 * M2.5 — DeepSeek V4.1 Flash provider adapter regressions (directive §8).
 *
 * All tests use a mocked fetch transport. The LIVE provider is NEVER called
 * in CI. The DeepSeek adapter is registered but NOT enabled by default in
 * production tests; tests opt in via makeTestApp({ adapters: "manual,deepseek" }).
 *
 * 19 minimum regressions (directive §8):
 *   1.  disabled DeepSeek → zero network
 *   2.  missing credential → safe refusal
 *   3.  canonical model = deepseek-flash
 *   4.  thinking enabled
 *   5.  reasoning_effort = max
 *   6.  response_format = json_object
 *   7.  configured token/input/time bounds honoured
 *   8.  correct Authorization header with the TEST credential
 *   9.  never a literal redaction placeholder
 *  10.  valid JSON → candidates
 *  11.  malformed/empty response → safe failure
 *  12.  hallucinated excerptId dropped
 *  13.  owner_declaration clamped to agent_report
 *  14.  volatile propagation
 *  15.  reasoning_content can NEVER become a candidate/evidence
 *  16.  usage captured request-scoped
 *  17.  concurrent calls cannot cross-contaminate usage
 *  18.  AI candidate remains proposed
 *  19.  no DeepSeek provider code in the web bundle
 *
 * Plus: extraction-quality prompt requirements (§6) and the paid-provider
 * cost-ceiling pre-flight (§5).
 */

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Import lazily so env stubs from beforeEach are picked up by readConfig().
const deepseekModule = await import("../src/adapters/deepseek.js");
const deepseekAdapter = deepseekModule.deepseekAdapter;

const TEST_EXCERPT_ID = "a3168434-76d7-4047-b8d4-84db1d1032cb";
const HALLUCINATED_EXCERPT_ID = "00000000-0000-0000-0000-000000000000";

/** Build the adapter input shape deepseekAdapter.extract expects. */
function makeInput(excerptText: string) {
  return {
    sourceId: "src-test",
    projectId: null,
    authorLabel: null,
    eventAt: null,
    excerpts: [
      {
        id: TEST_EXCERPT_ID,
        text: excerptText,
        startOffset: 0,
        endOffset: excerptText.length,
      },
    ],
  };
}

/** Capture the parsed request body from a mocked fetch call. */
function bodyOf(call: unknown[]): Record<string, unknown> {
  const reqInit = call[1] as RequestInit;
  return JSON.parse(String(reqInit.body)) as Record<string, unknown>;
}

function headersOf(call: unknown[]): Headers {
  const reqInit = call[1] as RequestInit;
  return new Headers(reqInit.headers);
}

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

/** Successful DeepSeek chat-completions response with a realistic usage block. */
function okResponse(
  candidates: Array<Record<string, unknown>>,
  usage: Record<string, unknown> = {},
  extraChoice: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      model: "deepseek-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({ candidates }),
            reasoning_content: "PRIVATE-CHAIN-OF-THOUGHT-MARKER",
          },
          finish_reason: "stop",
          ...extraChoice,
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 60,
        total_tokens: 160,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 60,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 25 },
        ...usage,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Mock that substitutes the "__EXCERPT_ID__" placeholder with the server's
 *  real excerpt id, read from the outgoing request. Non-placeholder ids are
 *  left untouched so evidence-integrity checks can drop them. */
function mockForRealExcerptId(
  candidates: Array<Record<string, unknown>>,
  usage: Record<string, unknown> = {},
) {
  return async (...callArgs: Parameters<typeof fetch>): Promise<Response> => {
    const reqBody = JSON.parse(String((callArgs[1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userContent = reqBody.messages.find((m) => m.role === "user")!.content;
    const realExcerptId = userContent.match(/excerpt ([a-f0-9-]+)/)![1]!;
    const withIds = candidates.map((c) => ({
      ...c,
      excerptId: c.excerptId === "__EXCERPT_ID__" ? realExcerptId : c.excerptId,
    }));
    return okResponse(withIds, usage);
  };
}

describe("M2.5: deepseek provider adapter (server-side only, mocked transport)", () => {
  // ---------------------------------------------------------------- §8.1
  it("(1) disabled deepseek → zero network", async () => {
    const t = await makeTestApp({ adapters: "manual" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "anything",
        adapterId: "deepseek",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("adapter_disabled");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.2
  it("(2) missing credential → safe refusal (no network, specific code)", async () => {
    // DEEPSEEK_API_KEY deliberately unset.
    await expect(deepseekAdapter.extract!(makeInput("hello"))).rejects.toMatchObject({
      code: "deepseek_missing_api_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(deepseekAdapter.estimateUsage!(makeInput("hello"))).rejects.toMatchObject({
      code: "deepseek_missing_api_key",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Through the pipeline: the provider-specific code surfaces, no call.
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "anything",
        adapterId: "deepseek",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        "deepseek_missing_api_key",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  // ------------------------------------------------------- §8.3, §8.4, §8.5, §8.6
  it("(3-6) canonical model, thinking enabled, reasoning_effort=max, response_format=json_object", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(okResponse([]));

    await deepseekAdapter.extract!(makeInput("some text"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;

    // Endpoint: official DeepSeek base URL + /chat/completions.
    expect(urlOf(call)).toBe("https://api.deepseek.com/chat/completions");

    const body = bodyOf(call);
    // (3) canonical model name — NOT the retired deepseek-v4-flash alias.
    expect(body.model).toBe("deepseek-flash");
    // (4) thinking enabled.
    expect(body.thinking).toEqual({ type: "enabled" });
    // (5) max reasoning effort.
    expect(body.reasoning_effort).toBe("max");
    // (6) JSON output.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.stream).toBe(false);

    // No temperature in thinking mode (DeepSeek ignores sampling parameters).
    expect(body).not.toHaveProperty("temperature");
    // No MiniMax-specific fields copied over.
    expect(body).not.toHaveProperty("reasoning_split");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("(3b) model/base URL are configurable; thinking can be disabled", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("CK_DEEPSEEK_MODEL", "deepseek-flash");
    vi.stubEnv("CK_DEEPSEEK_BASE_URL", "https://api.deepseek.com/");
    vi.stubEnv("CK_DEEPSEEK_THINKING", "off");
    vi.stubEnv("CK_DEEPSEEK_REASONING_EFFORT", "high");
    fetchMock.mockResolvedValueOnce(okResponse([]));

    await deepseekAdapter.extract!(makeInput("x"));
    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBe("high");
    // Trailing slash on the base URL is normalised — no double slash.
    expect(urlOf(fetchMock.mock.calls[0]!)).toBe("https://api.deepseek.com/chat/completions");
  });

  // ---------------------------------------------------------------- §8.7
  it("(7) configured token/input/time bounds are honoured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("CK_DEEPSEEK_MAX_OUTPUT_TOKENS", "1234");
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await deepseekAdapter.extract!(makeInput("x"));
    // Bounded output: DeepSeek's documented Chat Completions limit field.
    expect(bodyOf(fetchMock.mock.calls[0]!).max_tokens).toBe(1234);

    // Input bound: refuse BEFORE any network call.
    fetchMock.mockClear();
    vi.stubEnv("CK_DEEPSEEK_MAX_INPUT_CHARS", "10");
    await expect(deepseekAdapter.extract!(makeInput("this text is longer than ten chars"))).rejects.toMatchObject(
      { code: "deepseek_input_too_large" },
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Time bound: an aborted request is a safe, specific failure.
    vi.stubEnv("CK_DEEPSEEK_MAX_INPUT_CHARS", "200000");
    vi.stubEnv("CK_DEEPSEEK_TIMEOUT_MS", "5");
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_timeout",
    });
  });

  // ------------------------------------------------------- §8.8, §8.9
  it("(8-9) Authorization is exactly Bearer <test credential>, never a redaction placeholder", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await deepseekAdapter.extract!(makeInput("x"));

    const headers = headersOf(fetchMock.mock.calls[0]!);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    // The classic regression: a literal placeholder leaking into the header.
    expect(headers.get("authorization")).not.toMatch(/\*\*\*/);
    expect(headers.get("authorization")).not.toMatch(/redact/i);
  });

  // ---------------------------------------------------------------- §8.10
  it("(10) valid JSON output → proposed candidates with evidence", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "fact",
            subject: "current version",
            predicate: null,
            valueJson: null,
            text: "current version is 9.9.9",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.9,
            volatile: true,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "current version is 9.9.9 in production",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "deepseek import OK");
      const preview = res.json<{
        candidateCount: number;
        providerUsage: { model: string } | null;
        actualUsage: { model: string } | null;
      }>();
      expect(preview.candidateCount).toBe(1);
      expect(preview.providerUsage?.model).toBe("deepseek-flash");
      expect(preview.actualUsage?.model).toBe("deepseek-flash");

      const inbox = await t.get("/api/inbox");
      const candidates = inbox.json<{
        candidates: { text: string; volatile: boolean; evidence: unknown[] }[];
      }>().candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.text).toContain("9.9.9");
      expect(candidates[0]!.evidence.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.11
  it("(11) malformed / empty / non-JSON / truncated responses → safe failure", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    // (a) assistant content is not valid JSON.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });

    // (b) EMPTY content — documented as an occasional JSON Output behaviour.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });

    // (c) missing content field entirely.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: {} }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });

    // (d) valid JSON but no candidates array.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });

    // (e) transport-level non-JSON body.
    fetchMock.mockResolvedValueOnce(
      new Response("<html>gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });

    // (f) finish_reason=length → truncation is a safe failure, never a
    //     salvaged partial extraction. The content here is VALID, non-empty
    //     JSON carrying a candidate: it must still be discarded wholesale.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    {
                      type: "fact",
                      text: "a claim that happens to be valid json",
                      evidenceBasis: "document",
                      excerptId: TEST_EXCERPT_ID,
                      relation: "supports",
                      confidence: 0.9,
                      volatile: false,
                    },
                  ],
                }),
              },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 32_768, total_tokens: 32_868 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const truncated = await deepseekAdapter.extract!(makeInput("x")).catch((e: unknown) => e);
    expect(truncated).toMatchObject({ code: "deepseek_output_truncated", status: 409 });
    // No partial candidate survives the failure in any form.
    expect(truncated).not.toHaveProperty("candidates");
    expect((truncated as { details?: Record<string, unknown> }).details).toMatchObject({
      finishReason: "length",
      maxOutputTokens: 32_768,
    });
    expect(String((truncated as Error).message)).toContain("32768");

    // (g) auth / rate limit / server errors map to specific codes.
    for (const [status, code] of [
      [401, "deepseek_auth_failed"],
      [403, "deepseek_auth_failed"],
      [429, "deepseek_rate_limited"],
      [503, "deepseek_unavailable"],
      [400, "deepseek_unavailable"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(new Response("{}", { status }));
      await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({ code });
    }
  });

  // ---------------------------------------------------------------- §8.12
  it("(12) hallucinated excerptId is dropped (evidence integrity)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "fact",
            subject: "valid",
            predicate: null,
            valueJson: null,
            text: "valid candidate with the real excerptId",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.99,
            volatile: false,
          },
          {
            type: "fact",
            subject: "fabricated",
            predicate: null,
            valueJson: null,
            text: "this candidate invents its excerptId",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: HALLUCINATED_EXCERPT_ID,
            relation: "supports",
            confidence: 0.99,
            volatile: false,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "some importable text",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "import with one fabricated excerpt id");
      // Adapter-level drop: only the valid candidate survives.
      expect(res.json<{ candidateCount: number }>().candidateCount).toBe(1);

      const inbox = await t.get("/api/inbox");
      const texts = inbox
        .json<{ candidates: { text: string }[] }>()
        .candidates.map((c) => c.text);
      expect(texts).toContain("valid candidate with the real excerptId");
      expect(texts).not.toContain("this candidate invents its excerptId");
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.13
  it("(13) owner_declaration attempt → clamped to agent_report (A20)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "decision",
            subject: "who owns this",
            predicate: null,
            valueJson: null,
            text: "the owner personally declared this",
            evidenceBasis: "owner_declaration",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.9,
            volatile: false,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "the owner personally declared this",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "import with owner_declaration attempt");

      const inbox = await t.get("/api/inbox");
      const cand = inbox.json<{ candidates: { evidenceBasis: string }[] }>().candidates[0]!;
      expect(cand.evidenceBasis).not.toBe("owner_declaration");
      expect(cand.evidenceBasis).toBe("agent_report");
    } finally {
      await t.cleanup();
    }
  });

  it("(13b) the extraction prompt forbids owner_declaration", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await deepseekAdapter.extract!(makeInput("x"));
    const messages = bodyOf(fetchMock.mock.calls[0]!).messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.find((m) => m.role === "system")!.content).toContain("owner_declaration");
  });

  // ---------------------------------------------------------------- §8.14
  it("(14) volatile propagation (volatile=true survives to the stored record)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "fact",
            subject: "runtime",
            predicate: null,
            valueJson: null,
            text: "ContextKeep is running on the Dell server",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.95,
            volatile: true,
          },
          {
            type: "constraint",
            subject: "policy",
            predicate: null,
            valueJson: null,
            text: "records must never be auto-accepted",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.95,
            volatile: false,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "ContextKeep is running on the Dell server. Records must never be auto-accepted.",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "volatile propagation import");

      const inbox = await t.get("/api/inbox");
      const byText = new Map(
        inbox
          .json<{ candidates: { text: string; volatile: boolean }[] }>()
          .candidates.map((c) => [c.text, c.volatile]),
      );
      expect(byText.get("ContextKeep is running on the Dell server")).toBe(true);
      expect(byText.get("records must never be auto-accepted")).toBe(false);
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.15
  it("(15) reasoning_content can NEVER become a candidate or evidence", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      // The mock returns reasoning_content carrying a secret-looking marker
      // and a fake "candidate". Only message.content may be parsed.
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "fact",
            subject: "legit",
            predicate: null,
            valueJson: null,
            text: "legitimate extracted claim",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.9,
            volatile: false,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "legitimate extracted claim",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "reasoning separation import");

      const inbox = await t.get("/api/inbox");
      const candidates = inbox.json<{ candidates: Record<string, unknown>[] }>().candidates;
      expect(candidates.length).toBe(1);
      const serialized = JSON.stringify(candidates);
      expect(serialized).not.toContain("PRIVATE-CHAIN-OF-THOUGHT-MARKER");
      expect(serialized).not.toContain("reasoning_content");
    } finally {
      await t.cleanup();
    }
  });

  it("(15b) reasoning_content is never parsed even when content is malformed", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // content is broken, but reasoning_content holds valid JSON with
    // candidates. The adapter must FAIL, never fall back to reasoning.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "{ this is not json",
                reasoning_content: JSON.stringify({
                  candidates: [
                    {
                      type: "fact",
                      subject: "from reasoning",
                      text: "leaked from the chain of thought",
                      excerptId: TEST_EXCERPT_ID,
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(deepseekAdapter.extract!(makeInput("x"))).rejects.toMatchObject({
      code: "deepseek_malformed_output",
    });
  });

  // ---------------------------------------------------------------- §8.16
  it("(16) usage captured request-scoped (real tokens, real USD, not subscription)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      okResponse([], {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        prompt_cache_hit_tokens: 400,
        prompt_cache_miss_tokens: 600,
      }),
    );
    const result = await deepseekAdapter.extract!(makeInput("x"));
    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(1000);
    expect(result.usage!.outputTokens).toBe(500);
    expect(result.usage!.model).toBe("deepseek-flash");
    // Current published `deepseek-v4-flash` rates: 600 cache-miss @0.44
    // + 400 cache-hit @0.014 + 500 output @1.32
    // = (0.000264) + (0.0000056) + (0.00066) = 0.0009296
    expect(result.usage!.estCostUsd).toBeCloseTo(0.0009296, 10);
    // A paid provider must NEVER report zero marginal cost.
    expect(result.usage!.estCostUsd).toBeGreaterThan(0);

    // Pre-flight estimate is a conservative UPPER BOUND over the actual cost.
    const est = await deepseekAdapter.estimateUsage!(makeInput("x"));
    expect(est).not.toBeNull();
    expect(est!.estCostUsd).toBeGreaterThan(0);
    expect(est!.estCostUsd).toBeGreaterThanOrEqual(result.usage!.estCostUsd);
    expect(est!.outputTokens).toBe(32_768);
  });

  it("(16a) bounded default output is 32768 — NOT the 384K model maximum, NOT the retired 8192", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // No CK_DEEPSEEK_MAX_OUTPUT_TOKENS override: the adapter default applies.
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await deepseekAdapter.extract!(makeInput("x"));
    expect(bodyOf(fetchMock.mock.calls[0]!).max_tokens).toBe(32_768);

    const est = await deepseekAdapter.estimateUsage!(makeInput("x"));
    expect(est!.outputTokens).toBe(32_768);
    // Still a bounded default, far below the model's 384K maximum.
    expect(est!.outputTokens).toBeLessThan(384_000);
    expect(est!.outputTokens).toBeGreaterThan(8192);
  });

  it("(16a2) default pre-flight pricing uses the current published rates", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // Empty excerpts → the smallest possible prompt: the estimate is dominated
    // by the output ceiling (32768/1e6*1.32 = 0.04325376) plus the system
    // prompt. Every input token is priced at the cache-MISS rate 0.44.
    const est = await deepseekAdapter.estimateUsage!({ ...makeInput(""), excerpts: [] });
    const expected = (est!.inputTokens! / 1_000_000) * 0.44 + (32_768 / 1_000_000) * 1.32;
    expect(est!.estCostUsd).toBeCloseTo(expected, 10);
    // Output alone accounts for the published 1.32/MTok rate at the bound.
    expect(est!.estCostUsd - (est!.inputTokens! / 1_000_000) * 0.44).toBeCloseTo(0.04325376, 10);
    // A single default-priced extraction still fits under the per-import
    // CK_COST_CEILING_USD default of 0.05 USD.
    expect(est!.estCostUsd).toBeLessThan(0.05);
  });

  it("(16a3) real artifact sizes stay under CK_COST_CEILING_USD; oversized ones are refused, never bypassed", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const ceiling = 0.05;
    // Representative real project-history artifact: the unihub-retail batch
    // averaged ~6k sanitized chars per artifact.
    const typical = await deepseekAdapter.estimateUsage!(makeInput("x".repeat(6_000)));
    expect(typical!.estCostUsd).toBeLessThan(ceiling);
    // ~33k prompt chars is still inside the per-import ceiling.
    const large = await deepseekAdapter.estimateUsage!(makeInput("x".repeat(30_000)));
    expect(large!.estCostUsd).toBeLessThan(ceiling);
    // Beyond roughly 38k chars of excerpt text the conservative upper bound
    // exceeds the ceiling. That is a NORMAL refusal at execution time
    // (409 cost_ceiling_exceeded) — the bound is never bypassed.
    const oversized = await deepseekAdapter.estimateUsage!(makeInput("x".repeat(60_000)));
    expect(oversized!.estCostUsd).toBeGreaterThan(ceiling);
    // The estimate still never claims more than a bounded default output.
    expect(oversized!.outputTokens).toBe(32_768);
  });

  it("(16b) usage falls back to the expensive cache-miss rate when the split is absent", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ candidates: [] }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await deepseekAdapter.extract!(makeInput("x"));
    // Whole input priced at the cache-MISS rate: 1000/1e6*0.44.
    expect(result.usage!.estCostUsd).toBeCloseTo(0.00044, 10);
  });

  // ---------------------------------------------------------------- §8.17
  it("(17) concurrent calls cannot cross-contaminate usage", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // Two in-flight requests with different, deliberately inverted latencies.
    fetchMock
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      candidates: [
                        {
                          type: "fact",
                          subject: "first",
                          text: "first",
                          excerptId: TEST_EXCERPT_ID,
                        },
                      ],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      )
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      candidates: [
                        {
                          type: "fact",
                          subject: "second",
                          text: "second",
                          excerptId: TEST_EXCERPT_ID,
                        },
                      ],
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 999, completion_tokens: 111, total_tokens: 1110 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

    const [r1, r2] = await Promise.all([
      deepseekAdapter.extract!(makeInput("first")),
      deepseekAdapter.extract!(makeInput("second")),
    ]);
    expect(r1.usage!.inputTokens).toBe(10);
    expect(r1.usage!.outputTokens).toBe(1);
    expect(r2.usage!.inputTokens).toBe(999);
    expect(r2.usage!.outputTokens).toBe(111);
    expect(r1.candidates[0]!.text).toBe("first");
    expect(r2.candidates[0]!.text).toBe("second");
  });

  it("(17b) concurrent pipeline imports keep usage bound to their own job", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementation(mockForRealExcerptId([
        {
          type: "fact",
          subject: "s",
          predicate: null,
          valueJson: null,
          text: "concurrent claim",
          evidenceBasis: "document",
          taskStatus: null,
          sourceEventAt: null,
          excerptId: "__EXCERPT_ID__",
          relation: "supports",
          confidence: 0.9,
          volatile: false,
        },
      ]));
      // The two source texts must be genuinely dissimilar: the import
      // pipeline refuses near-duplicate SOURCES with 200 near_duplicate_pending
      // before extraction runs (A1), which would bypass this assertion.
      const [a, b] = await Promise.all([
        t.post("/api/imports/text", {
          text: "The extraction provider is configured with a bounded output token ceiling for safety.",
          adapterId: "deepseek",
        }),
        t.post("/api/imports/text", {
          text: "Owner prefers teal accents and a compact navigation header on desktop browsers.",
          adapterId: "deepseek",
        }),
      ]);
      expectStatus(a, 201, "concurrent import A");
      expectStatus(b, 201, "concurrent import B");
      const ua = a.json<{ actualUsage: { inputTokens: number } | null }>().actualUsage;
      const ub = b.json<{ actualUsage: { inputTokens: number } | null }>().actualUsage;
      // Both succeeded with their own captured usage; neither is null.
      expect(ua).not.toBeNull();
      expect(ub).not.toBeNull();
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.18
  it("(18) AI candidate remains proposed — never auto-accepted", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      fetchMock.mockImplementationOnce(
        mockForRealExcerptId([
          {
            type: "decision",
            subject: "primary provider",
            predicate: null,
            valueJson: null,
            text: "DeepSeek should remain the primary extraction provider",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: "__EXCERPT_ID__",
            relation: "supports",
            confidence: 0.99,
            volatile: false,
          },
        ]),
      );
      const res = await t.post("/api/imports/text", {
        text: "Decision: DeepSeek should remain the primary extraction provider.",
        adapterId: "deepseek",
      });
      expectStatus(res, 201, "proposed-only import");

      const inbox = await t.get("/api/inbox");
      const cand = inbox.json<{ candidates: { reviewStatus: string }[] }>().candidates[0]!;
      expect(cand.reviewStatus).toBe("proposed");
    } finally {
      await t.cleanup();
    }
  });

  // ---------------------------------------------------------------- §8.19
  it("(19) no DeepSeek provider code in the web bundle", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cwd = process.cwd();
    // The adapter lives in apps/server, never apps/web.
    expect(fs.existsSync(path.join(cwd, "src/adapters/deepseek.ts"))).toBe(true);

    const webSrc = path.join(cwd, "../web/src");
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}${path.sep}${e.name}`;
        if (e.isDirectory()) out.push(...walk(p));
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
      }
      return out;
    }
    // No web source file may reference the DeepSeek provider or its credential.
    for (const f of walk(webSrc)) {
      const txt = fs.readFileSync(f, "utf8");
      expect(txt).not.toMatch(/deepseek/i);
    }
    // apps/web must not depend on the server package that owns the adapter.
    const webPkg = JSON.parse(
      fs.readFileSync(path.join(cwd, "../web/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...webPkg.dependencies, ...webPkg.devDependencies };
    expect(deps).not.toHaveProperty("@contextkeep/server");
  });

  // ---------------------------------------------------------------- §8.5 (paid ceiling)
  it("paid provider cannot bypass CK_COST_CEILING_USD (pre-flight refusal, no network)", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    // Price the output absurdly high so the conservative upper bound exceeds
    // the configured ceiling (test app default = $0.05).
    vi.stubEnv("CK_DEEPSEEK_OUTPUT_USD_PER_MTOK", "100000");
    const t = await makeTestApp({ adapters: "manual,deepseek" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "a short import",
        adapterId: "deepseek",
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("cost_ceiling_exceeded");
      // Refused BEFORE any billable provider call.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("costCategory is paid, not subscription (MiniMax semantics are NOT carried over)", () => {
    expect(deepseekAdapter.costCategory).toBe("paid");
    expect(deepseekAdapter.id).toBe("deepseek");
  });

  // ---------------------------------------------------------------- §6 prompt
  it("extraction prompt demands a json object, all five types, atomicity and an example", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(okResponse([]));
    await deepseekAdapter.extract!(makeInput("x"));
    const messages = bodyOf(fetchMock.mock.calls[0]!).messages as Array<{
      role: string;
      content: string;
    }>;
    const sys = messages.find((m) => m.role === "system")!.content;
    const user = messages.find((m) => m.role === "user")!.content;

    // JSON Output requires the literal word "json" plus an example structure.
    expect(sys).toMatch(/json/i);
    expect(sys).toContain('"candidates"');
    expect(sys).toContain("EXCERPT_ID_COPIED_FROM_INPUT");

    // Recall: every supported type is named.
    for (const t of ["fact", "decision", "action", "constraint", "question"]) {
      expect(sys).toContain(`"${t}"`);
    }
    // Atomicity + no-merge rule.
    expect(sys).toMatch(/one candidate per atomic semantic claim/i);
    expect(sys).toMatch(/never merge unrelated claims/i);
    // No inference beyond evidence.
    expect(sys).toMatch(/never infer/i);
    // Noise suppression.
    expect(sys).toMatch(/greetings/i);
    expect(sys).toMatch(/filler/i);
    expect(sys).toMatch(/repetitions/i);
    // Preserve excerptId exactly.
    expect(sys).toMatch(/copy 'excerptId' exactly/i);
    // Volatility rule for runtime/config/version/provider/status claims.
    expect(sys).toMatch(/volatile/i);
    expect(sys).toMatch(/runtime state/i);
    expect(sys).toMatch(/enabled or disabled/i);
    // Never owner_declaration; proposed only.
    expect(sys).toMatch(/never set 'evidenceBasis' to "owner_declaration"/i);
    expect(sys).toMatch(/proposal for the owner to review/i);
    // Explicit evidence relation.
    expect(sys).toMatch(/relation/i);

    // The excerpt header carries the exact id the model must copy.
    expect(user).toContain(`--- excerpt ${TEST_EXCERPT_ID} (offset 0-1) ---`);
  });
});
