import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterDisabledError, createAdapterRegistry, allAdapters } from "../src/adapters/registry.js";
import { fakeTestAdapter } from "../src/adapters/faketest.js";
import { manualAdapter } from "../src/adapters/manual.js";
import { deepseekAdapter } from "../src/adapters/deepseek.js";
import { minimaxAdapter } from "../src/adapters/minimax.js";
import { openaiAdapter } from "../src/adapters/openai.js";
import { makeTestApp, expectStatus, type TestApp } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * A14: with no provider enabled, zero provider calls happen. Adapters are
 * either pure/synchronous (manual, faketest) or async (asynctest ships in
 * source for M2.4d async-contract proof but is NOT enabled by default —
 * CK_ADAPTERS=manual,faketest). Enabling asynctest happens only in tests
 * that explicitly opt in via makeTestApp({ adapters: "...,asynctest" }).
 */
describe("A14: adapter registry", () => {
  it("registers manual + faketest + asynctest + paid-no-estimate + paid-with-null-estimate + paid-with-invalid-estimate + deepseek + minimax + openai (9 entries; deepseek is M2.5 primary, minimax is DISABLED history, openai is DISABLED fallback)", () => {
    expect(Object.keys(allAdapters).sort()).toEqual([
      "asynctest",
      "deepseek",
      "faketest",
      "manual",
      "minimax",
      "openai",
      "paid-no-estimate",
      "paid-with-invalid-estimate",
      "paid-with-null-estimate",
    ]);
  });

  it("default CK_ADAPTERS enables exactly manual + faketest (A14: no provider reachable)", () => {
    const registry = createAdapterRegistry(["manual", "faketest"]);
    expect(registry.enabledIds().sort()).toEqual(["faketest", "manual"]);
    expect(() => registry.get("asynctest")).toThrow(AdapterDisabledError);
    expect(() => registry.get("paid-no-estimate")).toThrow(AdapterDisabledError);
    expect(() => registry.get("paid-with-null-estimate")).toThrow(AdapterDisabledError);
    expect(() => registry.get("paid-with-invalid-estimate")).toThrow(AdapterDisabledError);
    expect(() => registry.get("openai")).toThrow(AdapterDisabledError);
    expect(() => registry.get("deepseek")).toThrow(AdapterDisabledError);
    expect(() => registry.get("minimax")).toThrow(AdapterDisabledError);
  });

  it("FakeTest and AsyncTest are declared costCategory='free' (no real provider cost)", () => {
    // M2.4d cleanup §1: FakeTest and AsyncTest do NO real provider work. They
    // are declared costCategory='free' so their null estimateUsage (no usage
    // line in the input) means "zero cost" — not a paid-adapter cost bypass.
    const faketestMeta = allAdapters["faketest"] as unknown as { costCategory?: string };
    const asynctestMeta = allAdapters["asynctest"] as unknown as { costCategory?: string };
    expect(faketestMeta.costCategory).toBe("free");
    expect(asynctestMeta.costCategory).toBe("free");
  });

  it("refuses unknown provider adapters (e.g. openai)", () => {
    const registry = createAdapterRegistry(["manual", "faketest"]);
    expect(() => registry.get("openai")).toThrow(AdapterDisabledError);
    expect(() => registry.get("anthropic")).toThrow(AdapterDisabledError);
  });

  it("refuses disabled adapters", () => {
    const registry = createAdapterRegistry(["manual"]);
    expect(() => registry.get("faketest")).toThrow(AdapterDisabledError);
    expect(registry.get("manual")).toBe(manualAdapter);
  });

  it("manual adapter extracts nothing", () => {
    expect(manualAdapter.extract({ sourceId: "s", projectId: null, authorLabel: null, eventAt: null, excerpts: [{ id: "e1", text: "fact: something", startOffset: 0, endOffset: 14 }] })).toEqual({ candidates: [], usage: null });
  });

  it("faketest adapter is deterministic", () => {
    const input = {
      sourceId: "s1",
      projectId: null,
      authorLabel: null,
      eventAt: "2026-09-09T00:00:00.000Z",
      excerpts: [
        {
          id: "e1",
          text: "fact: store uses WAL\ndecision: ship M0\naction: write tests\nquestion: what about backups?\nconstraint: local only\nstatus: done — migration applied\nowner-claim: owner says deployed\nobserved: health endpoint 200",
          startOffset: 0,
          endOffset: 200,
        },
      ],
    };
    const a = fakeTestAdapter.extract(input);
    const b = fakeTestAdapter.extract(input);
    expect(a).toEqual(b);
    // M2.4e directive §7: extract returns AdapterExtractResult
    // (request-scoped candidates AND usage). Free adapters use null usage.
    expect(a.candidates.length).toBe(8);
    expect(a.usage).toBeNull();
  });
});

describe("A14/A21 via API: disabled or unknown adapters are refused and audited", () => {
  let t: TestApp;
  const withApp = async (fn: (t: TestApp) => Promise<void>) => {
    t = await makeTestApp();
    try {
      await fn(t);
    } finally {
      await t.cleanup();
    }
  };

  it("import with adapterId=openai → 409 adapter_disabled + audit provider_call.refused_disabled (A21)", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "Some text to import.",
        adapterId: "openai",
      });
      expectStatus(res, 409, "unknown adapter refused");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("adapter_disabled");

      const audit = await t.get("/api/audit?action=provider_call.refused_disabled");
      expectStatus(audit, 200, "audit");
      const events = audit.json<{ targetId: string; detail: unknown }[]>();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.targetId).toBe("openai");
    });
  });

  it("import with a real adapter while the network is poisoned still succeeds (no provider calls, A14)", async () => {
    await withApp(async (t) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error("A14 violation: network call attempted during import");
      }) as typeof fetch;
      try {
        const res = await t.post("/api/imports/text", {
          text: "fact: offline-only extraction works",
          adapterId: "faketest",
        });
        expectStatus(res, 201, "faketest import without network");
        expect(res.json<{ candidateCount: number }>().candidateCount).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }

      const meta = await t.get("/api/meta");
      expectStatus(meta, 200, "meta");
      const adapters = meta.json<{ adapters: { id: string; enabled: boolean }[] }>().adapters;
      // A14: only the ENABLED adapters can be invoked; asynctest is registered
      // but disabled by default so it must NOT show up in the enabled set.
      expect(
        adapters
          .filter((a) => a.enabled)
          .map((a) => a.id)
          .sort(),
      ).toEqual(["faketest", "manual"]);
      // asynctest appears in the registry list but with enabled=false.
      const asynctestEntry = adapters.find((a) => a.id === "asynctest");
      expect(asynctestEntry).toBeDefined();
      expect(asynctestEntry!.enabled).toBe(false);
    });
  });

  it("CK_ADAPTERS=manual disables faketest at the API level too", async () => {
    const tm = await makeTestApp({ adapters: "manual" });
    try {
      const res = await tm.post("/api/imports/text", {
        text: "fact: should be refused",
        adapterId: "faketest",
      });
      expectStatus(res, 409, "disabled adapter refused");
      expect(res.json<{ error: { code: string } }>().error.code).toBe("adapter_disabled");
    } finally {
      await tm.cleanup();
    }
  });
});

describe("A3.1 provider response deadlines", () => {
  const input = {
    sourceId: "timeout-fixture",
    projectId: null,
    authorLabel: null,
    eventAt: null,
    excerpts: [{ id: "excerpt-1", text: "fact: body timeout must abort", startOffset: 0, endOffset: 29 }],
  };

  const providers = [
    { name: "DeepSeek", adapter: deepseekAdapter, key: "DEEPSEEK_API_KEY", timeout: "CK_DEEPSEEK_TIMEOUT_MS", errorCode: "deepseek_timeout" },
    { name: "OpenAI", adapter: openaiAdapter, key: "OPENAI_API_KEY", timeout: "CK_OPENAI_TIMEOUT_MS", errorCode: "openai_timeout" },
    { name: "MiniMax", adapter: minimaxAdapter, key: "MINIMAX_API_KEY", timeout: "CK_MINIMAX_TIMEOUT_MS", errorCode: "minimax_timeout" },
  ] as const;

  for (const provider of providers) {
    it(`${provider.name} aborts a response whose body stalls after headers`, async () => {
      vi.stubEnv(provider.key, "synthetic-fixture");
      vi.stubEnv(provider.timeout, "5");
      let signal: AbortSignal | undefined;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          },
        }));
      }));

      await expect(provider.adapter.extract(input)).rejects.toMatchObject({ code: provider.errorCode });
      expect(signal?.aborted).toBe(true);
    });
  }
});

/**
 * M2.4d async adapter contract proof (handoff §12 item 13 readiness).
 *
 * `runImport` must support a real async adapter (`await adapter.estimateUsage(...)`
 * + `await adapter.extract(...)`) without any further architectural change. We
 * prove this by enabling the test-only `asynctest` adapter (deterministic,
 * no network) and exercising the full pipeline — cost ceiling pre-flight,
 * extraction, candidate persistence, A11 volatile plumbing, audit trail.
 */
describe("M2.4d: async adapter contract proof", () => {
  it("asynctest end-to-end: estimateUsage + extract both awaited; proposals persisted; cost ceiling enforced", async () => {
    const t = await makeTestApp({ adapters: "manual,asynctest" });
    try {
      // (a) Cost ceiling enforced via async estimateUsage: $0.10 > $0.05 ceiling.
      const over = await t.post("/api/imports/text", {
        text: [
          "async-usage-estimate: input=4000 output=2000 cost=0.1000 model=asynctest-model-v1",
          "",
          "async-fact: this fact would be produced if not refused by cost ceiling",
        ].join("\n"),
        adapterId: "asynctest",
      });
      expectStatus(over, 409, "async over-ceiling refused");
      expect(over.json<{ error: { code: string } }>().error.code).toBe("cost_ceiling_exceeded");

      // (b) Under ceiling: async extract awaits, proposals persisted with volatile=true.
      const ok = await t.post("/api/imports/text", {
        text: [
          "async-usage-estimate: input=200 output=100 cost=0.0200 model=asynctest-model-v1",
          "",
          "async-fact: async adapter wrote a volatile fact through the pipeline",
          "async-decision: async adapter wrote a stable decision",
        ].join("\n"),
        adapterId: "asynctest",
      });
      expectStatus(ok, 201, "async under-ceiling import");
      const preview = ok.json<{
        candidateCount: number;
        providerUsage: { estCostUsd: number; model: string } | null;
        costCeilingUsd: number;
      }>();
      expect(preview.candidateCount).toBe(2);
      expect(preview.providerUsage).not.toBeNull();
      expect(preview.providerUsage!.estCostUsd).toBeCloseTo(0.02, 6);
      expect(preview.providerUsage!.model).toBe("asynctest-model-v1");
      expect(preview.costCeilingUsd).toBe(0.05);

      // (c) The async-produced candidate is in the inbox with the expected shape.
      const inbox = await t.get("/api/inbox");
      const candidates = inbox.json<{ candidates: { text: string; volatile: boolean }[] }>().candidates;
      const asyncFact = candidates.find((c) => c.text.includes("async adapter wrote a volatile fact"));
      expect(asyncFact).toBeDefined();
      expect(asyncFact!.volatile).toBe(true);
      const asyncDecision = candidates.find((c) =>
        c.text.includes("async adapter wrote a stable decision"),
      );
      expect(asyncDecision).toBeDefined();
      expect(asyncDecision!.volatile).toBe(false);

      // (d) The provider_usage invariant from the directive holds:
      //     actual billable cost <= preflight upper-bound estimate <= configured ceiling.
      expect(preview.providerUsage!.estCostUsd).toBeLessThanOrEqual(preview.costCeilingUsd);
    } finally {
      await t.cleanup();
    }
  });
});
