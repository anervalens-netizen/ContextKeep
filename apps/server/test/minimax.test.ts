import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, makeTestApp, type TestApp } from "./helpers.js";

/**
 * M2.4e — MiniMax M3 provider adapter regressions (directive §9).
 *
 * All tests use mocked fetch transport (no real network in CI). The MiniMax
 * adapter is registered but NOT enabled by default in production; tests opt
 * in via makeTestApp({ adapters: "manual,minimax" }).
 *
 * 15 minimum regressions:
 *   1.  minimax disabled → zero network
 *   2.  credential unavailable → safe refusal
 *   3.  correct model = MiniMax-M3
 *   4.  thinking ON by default
 *   5.  thinking OFF configurable
 *   6.  output valid → proposed candidates
 *   7.  hallucinated excerptId → not persisted
 *   8.  owner_declaration attempt → A20 clamp
 *   9.  volatile propagation
 *  10.  malformed final output → safe failure
 *  11.  timeout → safe failure
 *  12.  usage captured (request-scoped, no module-global)
 *  13.  concurrent imports cannot cross-contaminate usage
 *  14.  no candidate can directly become accepted
 *  15.  MiniMax adapter is server-side only
 *
 * Server-side only means the MiniMax code lives in apps/server, NOT in
 * apps/web. Verified by web typecheck/build NOT touching the adapter file.
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
const minimaxModule = await import("../src/adapters/minimax.js");
const minimaxAdapter = minimaxModule.minimaxAdapter;

const TEST_EXCERPT_ID = "a3168434-76d7-4047-b8d4-84db1d1032cb";

/** Helper: build a fetch mock for a known excerptId. */
function minimaxMockFor(
  excerptId: string,
  candidates: Array<Record<string, unknown>>,
  usage: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; total_tokens?: number },
) {
  return async (): Promise<Response> => {
    const candidatesWithId = candidates.map((c) => ({ ...c, excerptId }));
    void excerptId;
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({ candidates: candidatesWithId }),
          },
        },
      ],
      usage,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Helper: build a fetch mock that captures the REAL excerptId from the
 *  server's request and substitutes the literal "__EXCERPT_ID__"
 *  placeholder in each candidate. Candidates that already carry a non-
 *  placeholder excerptId (e.g. "00000000-..." hallucinated ids) are NOT
 *  rewritten — they stay as-is so the evidence-integrity check drops
 *  them. */
function minimaxMockForRealExcerptId(
  candidates: Array<Record<string, unknown>>,
  usage: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; total_tokens?: number },
) {
  return async (...callArgs: Parameters<typeof fetch>): Promise<Response> => {
    const reqInit = callArgs[1] as RequestInit;
    const reqBody = JSON.parse(String(reqInit.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userContent = reqBody.messages.find((m) => m.role === "user")!.content;
    const match = userContent.match(/excerpt ([a-f0-9-]+)/);
    const realExcerptId = match![1]!;
    const PLACEHOLDER = "__EXCERPT_ID__";
    const candidatesWithId = candidates.map((c) => ({
      ...c,
      // Only substitute the literal placeholder. Hallucinated ids (anything
      // else) stay as-is and will fail the evidence-integrity check.
      excerptId: c.excerptId === PLACEHOLDER ? realExcerptId : c.excerptId,
    }));
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({ candidates: candidatesWithId }),
          },
        },
      ],
      usage,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Helper: build the adapter input shape that minimaxAdapter.extract expects. */
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

describe("M2.4e: minimax provider adapter (server-side only, mocked transport)", () => {
  // ===== HTTP-pipeline tests =====

  it("(1) minimax disabled → zero network", async () => {
    const t = await makeTestApp(); // default: manual,faketest
    try {
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      const res = await t.post("/api/imports/text", {
        text: "fact: a fact we route through faketest, never minimax",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "faketest import OK");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await t.cleanup();
    }
  });

  it("(2) credential unavailable → safe refusal", async () => {
    vi.stubEnv("MINIMAX_API_KEY", ""); // explicitly unset
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      const res = await t.post("/api/imports/text", {
        text: "any input — adapter refuses without a credential",
        adapterId: "minimax",
      });
      expectStatus(res, 409, "missing credential refused");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("minimax_missing_api_key");
      expect(fetchMock).not.toHaveBeenCalled();

      const audit = await t.get("/api/audit?action=provider_call.estimate_required");
      const events = audit.json<{ targetId: string }[]>();
      expect(events.some((e) => e.targetId === "minimax")).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("(3) correct model = MiniMax-M3 (request body carries CK_MINIMAX_MODEL default)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    // Unset CK_MINIMAX_MODEL so the adapter falls back to DEFAULTS.model.
    // Note: stubEnv(name, "") sets an empty string, which is treated as
    // set (?? only catches null/undefined). To unset we pass undefined.
    vi.stubEnv("CK_MINIMAX_MODEL", undefined as unknown as string);
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "any input",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      // Verify the request body contained the expected model.
      const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
      const reqBody = JSON.parse(String(reqInit.body)) as { model: string };
      expect(reqBody.model).toBe("MiniMax-M3");
    } finally {
      await t.cleanup();
    }
  });

  it("(4) thinking ON by default (request body contains thinking.type=enabled)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    vi.stubEnv("CK_MINIMAX_THINKING", ""); // unset → defaults to on
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "any input",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
      const reqBody = JSON.parse(String(reqInit.body)) as {
        thinking?: { type?: string };
      };
      expect(reqBody.thinking).toEqual({ type: "enabled" });
    } finally {
      await t.cleanup();
    }
  });

  it("(5) thinking OFF configurable (CK_MINIMAX_THINKING=off → thinking.type=disabled)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    vi.stubEnv("CK_MINIMAX_THINKING", "off");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "any input",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
      const reqBody = JSON.parse(String(reqInit.body)) as {
        thinking?: { type?: string };
      };
      expect(reqBody.thinking).toEqual({ type: "disabled" });
    } finally {
      await t.cleanup();
    }
  });

  it("(6) output valid → proposed candidates (with evidence links)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockImplementationOnce(
        minimaxMockForRealExcerptId(
          [
            {
              type: "fact",
              subject: "current version",
              predicate: null,
              valueJson: null,
              text: "current version is 9.9.9",
              evidenceBasis: "document",
              taskStatus: null,
              sourceEventAt: null,
              excerptId: "__EXCERPT_ID__", // substituted with server's real id
              relation: "supports",
              confidence: 0.9,
              volatile: true,
            },
          ],
          { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 20, total_tokens: 170 },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "current version is 9.9.9 in production",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      const preview = res.json<{
        candidateCount: number;
        providerUsage: { model: string } | null;
        actualUsage: { model: string } | null;
      }>();
      expect(preview.candidateCount).toBe(1);
      expect(preview.providerUsage?.model).toBe("MiniMax-M3");
      expect(preview.actualUsage?.model).toBe("MiniMax-M3");

      const inbox = await t.get("/api/inbox");
      const candidates = inbox.json<{
        candidates: { text: string; volatile: boolean; evidence: unknown[] }[];
      }>().candidates;
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.volatile).toBe(true);
      expect(candidates[0]!.text).toContain("9.9.9");
      expect(Array.isArray(candidates[0]!.evidence) && candidates[0]!.evidence.length).toBeGreaterThan(0);
    } finally {
      await t.cleanup();
    }
  });

  it("(7) hallucinated excerptId → not persisted (evidence integrity)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      // The mock helper substitutes every `__EXCERPT_ID__` placeholder with
      // the server's REAL excerpt id. We craft candidates so that:
      //  - candidate A: excerptId="__EXCERPT_ID__" → after substitution, matches real id → VALID.
      //  - candidate B: excerptId="00000000-0000-0000-0000-000000000000" → not a placeholder → NOT substituted → does NOT match real id → DROPPED.
      fetchMock.mockImplementationOnce(
        minimaxMockForRealExcerptId(
          [
            {
              type: "fact",
              subject: "valid",
              predicate: null,
              valueJson: null,
              text: "valid candidate with real excerptId",
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
              subject: "fake id",
              predicate: null,
              valueJson: null,
              text: "this candidate invents its excerptId",
              evidenceBasis: "document",
              taskStatus: null,
              sourceEventAt: null,
              excerptId: "00000000-0000-0000-0000-000000000000",
              relation: "supports",
              confidence: 0.99,
              volatile: false,
            },
          ],
          { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "any input",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      const preview = res.json<{ candidateCount: number }>();
      // Only the valid excerptId survives; hallucinated one is dropped.
      expect(preview.candidateCount).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it("(8) owner_declaration attempt → A20 clamp (evidenceBasis=agent_report)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockImplementationOnce(
        minimaxMockForRealExcerptId(
          [
            {
              type: "fact",
              subject: "fake owner declaration",
              predicate: null,
              valueJson: null,
              text: "this would be owner-confirmed if A20 failed",
              evidenceBasis: "owner_declaration", // ← forbidden
              taskStatus: null,
              sourceEventAt: null,
              excerptId: "__EXCERPT_ID__", // substituted with server's real id
              relation: "supports",
              confidence: 0.99,
              volatile: false,
            },
          ],
          { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "any input",
        adapterId: "minimax",
      });
      expectStatus(res, 201, "import OK");
      const inbox = await t.get("/api/inbox");
      const candidates = inbox.json<{
        candidates: { evidenceBasis: string; text: string }[];
      }>().candidates;
      const matched = candidates.find((c) => c.text.includes("owner-confirmed"));
      expect(matched).toBeDefined();
      expect(matched!.evidenceBasis).toBe("agent_report"); // NOT owner_declaration
    } finally {
      await t.cleanup();
    }
  });

  it("(10) malformed final output → safe failure", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{not valid json at all" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const res = await t.post("/api/imports/text", {
        text: "fact: malformed output test",
        adapterId: "minimax",
      });
      expectStatus(res, 409, "malformed output");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("minimax_malformed_output");
    } finally {
      await t.cleanup();
    }
  });

  it("(11) timeout → safe failure (AbortError → minimax_timeout)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    vi.stubEnv("CK_MINIMAX_TIMEOUT_MS", "100");
    const t = await makeTestApp({ adapters: "manual,minimax" });
    try {
      fetchMock.mockImplementationOnce(() =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const e = new Error("The operation was aborted.");
            e.name = "AbortError";
            reject(e);
          }, 50);
        }),
      );
      const res = await t.post("/api/imports/text", {
        text: "fact: timeout test",
        adapterId: "minimax",
      });
      expectStatus(res, 409, "timeout");
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("minimax_timeout");
    } finally {
      await t.cleanup();
    }
  });

  it("(14) no candidate can directly become accepted (provider produces proposed only)", async () => {
    // The MiniMax adapter returns AdapterCandidate — the pipeline sets
    // review_status='proposed' on persist. The A22 contract (accepted-only
    // brief) is verified by existing review.test.ts A22 tests.
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    fetchMock.mockImplementationOnce(
      minimaxMockFor(
        TEST_EXCERPT_ID,
        [
          {
            type: "fact",
            subject: "candidate that wants to be accepted",
            predicate: null,
            valueJson: null,
            text: "provider cannot create accepted records",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: TEST_EXCERPT_ID,
            relation: "supports",
            confidence: 0.99,
            volatile: false,
          },
        ],
        { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      ),
    );
    const result = await minimaxAdapter.extract!(
      makeInput("any input — provider cannot directly accept"),
    );
    // AdapterCandidate type does NOT carry reviewStatus; the pipeline
    // assigns review_status='proposed' on persist. Verify the structural
    // invariant: the adapter returns a normal candidate shape, no
    // reviewStatus field.
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.type).toBe("fact");
    expect(result.candidates[0]!.excerptId).toBeTruthy();
    expect((result.candidates[0]! as unknown as { reviewStatus?: unknown }).reviewStatus).toBeUndefined();
  });

  // ===== Direct-adapter tests =====

  it("(9) volatile propagation (volatile=true survives through extract)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    fetchMock.mockImplementationOnce(
      minimaxMockFor(
        TEST_EXCERPT_ID,
        [
          {
            type: "fact",
            subject: "deployment version",
            predicate: null,
            valueJson: null,
            text: "current version is 9.9.9",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: TEST_EXCERPT_ID,
            relation: "supports",
            confidence: 0.95,
            volatile: true,
          },
        ],
        { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      ),
    );
    const result = await minimaxAdapter.extract!(
      makeInput("current version is 9.9.9"),
    );
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0]!.volatile).toBe(true);
  });

  it("(12) usage captured (request-scoped, no module-global)", async () => {
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    fetchMock.mockImplementationOnce(
      minimaxMockFor(
        TEST_EXCERPT_ID,
        [
          {
            type: "fact",
            subject: "usage capture",
            predicate: null,
            valueJson: null,
            text: "actual usage captured",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: TEST_EXCERPT_ID,
            relation: "supports",
            confidence: 0.9,
            volatile: false,
          },
        ],
        { prompt_tokens: 1000, completion_tokens: 250, reasoning_tokens: 50, total_tokens: 1300 },
      ),
    );
    const result = await minimaxAdapter.extract!(makeInput("any text"));
    expect(result.candidates.length).toBe(1);
    expect(result.usage).not.toBeNull();
    expect(result.usage!.inputTokens).toBe(1000);
    expect(result.usage!.outputTokens).toBe(250);
    expect(result.usage!.model).toBe("MiniMax-M3");
    // Subscription: no estCostUsd fabrication (estCostUsd=0).
    expect(result.usage!.estCostUsd).toBe(0);
  });

  it("(13) concurrent imports cannot cross-contaminate usage (request-scoped)", async () => {
    // Directive §7: NO module-global mutable state. Two concurrent
    // invocations of extract() with different mock responses must each
    // return their OWN usage — no leakage between them.
    vi.stubEnv("MINIMAX_API_KEY", "test-key");

    // First invocation: returns 1000 input tokens.
    fetchMock.mockImplementationOnce(
      minimaxMockFor(
        TEST_EXCERPT_ID,
        [
          {
            type: "fact",
            subject: "first call",
            predicate: null,
            valueJson: null,
            text: "first",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: TEST_EXCERPT_ID,
            relation: "supports",
            confidence: 0.9,
            volatile: false,
          },
        ],
        { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 },
      ),
    );
    // Second invocation: returns 2000 input tokens.
    fetchMock.mockImplementationOnce(
      minimaxMockFor(
        TEST_EXCERPT_ID,
        [
          {
            type: "fact",
            subject: "second call",
            predicate: null,
            valueJson: null,
            text: "second",
            evidenceBasis: "document",
            taskStatus: null,
            sourceEventAt: null,
            excerptId: TEST_EXCERPT_ID,
            relation: "supports",
            confidence: 0.9,
            volatile: false,
          },
        ],
        { prompt_tokens: 2000, completion_tokens: 500, total_tokens: 2500 },
      ),
    );

    const input = makeInput("any text");
    const [r1, r2] = await Promise.all([
      minimaxAdapter.extract!(input),
      minimaxAdapter.extract!(input),
    ]);

    // Each invocation's usage travels with it; no cross-contamination.
    // (The exact mapping depends on mock-call order, but each value MUST be
    // one of the two configured values — never a leak from the other.)
    const usages = [r1.usage?.inputTokens, r2.usage?.inputTokens].sort();
    expect(usages).toEqual([1000, 2000]);

    // Each candidate text MUST be one of the two configured texts.
    const texts = [r1.candidates[0]!.text, r2.candidates[0]!.text].sort();
    expect(texts).toEqual(["first", "second"]);
  });

  it("(16) Authorization regression — exact Bearer <credential>, no literal '***', Content-Type application/json", async () => {
    // Directive §2: regression so the bug that produced the literal
    // 'Bearer ***}' cannot recur. Asserts on the mocked request:
    //   - Authorization header EXISTS
    //   - EXACTLY "Bearer test-key" for the test credential
    //   - does NOT contain the literal "***" placeholder
    //   - Content-Type is "application/json"
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await minimaxAdapter.extract!(makeInput("any input"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const reqInit = call[1] as RequestInit;
    const headers = new Headers(reqInit.headers);
    const auth = headers.get("authorization");
    expect(auth).not.toBeNull();
    expect(auth).toBe("Bearer test-key");
    // Guard against the literal '***' placeholder regression — the
    // original bug emitted 'Bearer ***}' instead of 'Bearer test-key'.
    expect(auth).not.toMatch(/\*\*\*/);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("(15) MiniMax adapter is server-side only (not in web bundle)", async () => {
    // The directive §12: "Nu introduce MiniMax code în frontend." This
    // is verified by:
    //  - the adapter file lives in apps/server/src/adapters/, NOT apps/web
    //  - the registry that exposes adapters lives in apps/server
    //  - the web bundle does not import from apps/server
    // Resolve paths from process.cwd() (vitest sets cwd = package root)
    // — apps/server — so adapterPath is `src/adapters/minimax.ts` and
    // webSrc is `../web/src`.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cwd = process.cwd();
    const adapterPath = path.join(cwd, "src/adapters/minimax.ts");
    expect(fs.existsSync(adapterPath)).toBe(true);

    // No import of minimax in the web source.
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
    for (const f of walk(webSrc)) {
      const txt = fs.readFileSync(f, "utf8");
      expect(txt).not.toMatch(/minimax/i);
    }
  });

  it("(17) request body carries reasoning_split: true and max_completion_tokens (not max_tokens)", async () => {
    // M2.4e directive §10 follow-up: with reasoning_split=true the M3 model
    // returns content / reasoning_content as separate message fields and
    // JSON.parse on content succeeds. The token-limit field is renamed
    // to max_completion_tokens (still bounded by CK_MINIMAX_MAX_OUTPUT_TOKENS).
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    vi.stubEnv("CK_MINIMAX_MAX_OUTPUT_TOKENS", "1234");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ candidates: [] }),
                reasoning_content: "should be ignored",
                reasoning_details: [{ kind: "ignored" }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await minimaxAdapter.extract!(makeInput("x"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reqInit = fetchMock.mock.calls[0]![1] as RequestInit;
    const reqBody = JSON.parse(String(reqInit.body)) as Record<string, unknown>;
    expect(reqBody["reasoning_split"]).toBe(true);
    expect(reqBody["max_completion_tokens"]).toBe(1234);
    expect(reqBody).not.toHaveProperty("max_tokens");
    // Thinking remains enabled (reasoning_split controls separation, not on/off).
    expect(reqBody["thinking"]).toEqual({ type: "enabled" });
  });

  it("(18) reasoning_content / reasoning_details CANNOT become candidates or evidence", async () => {
    // Even if the model injects reasoning-shaped JSON in reasoning_content,
    // it MUST NOT be parsed or surfaced as a candidate. Only message.content
    // is parsed, and only candidate-shaped entries with valid excerptId
    // become candidates.
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const evilReasoning = JSON.stringify({
      candidates: [
        {
          type: "fact",
          subject: "INJECTED-FROM-REASONING",
          text: "leaked via reasoning_content",
          evidenceBasis: "owner_declaration",
          excerptId: TEST_EXCERPT_ID,
          volatile: true,
        },
      ],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ candidates: [] }),
                reasoning_content: evilReasoning,
                reasoning_details: [{ candidates: [{ type: "fact", subject: "DETAILS-LEAK" }] }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const r = await minimaxAdapter.extract!(makeInput("x"));
    expect(r.candidates).toEqual([]);
    // Nothing from reasoning surfaces into evidence / persisted state — the
    // adapter returned an empty candidate set and the reasoning JSON was
    // never touched.
  });

  it("(19) defensive fallback: legacy <think>...</think> inside content is still stripped", async () => {
    // If a future M3 revision (or a third-party mirror) ever puts the
    // thinking back into content, the defensive regex MUST still strip it
    // and JSON.parse MUST succeed on the remainder.
    vi.stubEnv("MINIMAX_API_KEY", "test-key");
    const contentWithThink =
      "<think>internal chain-of-thought not exposed via reasoning_split field</think>\n" +
      JSON.stringify({ candidates: [] });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: contentWithThink } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const r = await minimaxAdapter.extract!(makeInput("x"));
    expect(r.candidates).toEqual([]);
  });
});
