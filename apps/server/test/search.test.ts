import { describe, expect, it } from "vitest";
import type { SearchResultDto } from "@contextkeep/shared";
import { expectStatus, getProjectByName, makeTestApp, type TestApp } from "./helpers.js";

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

describe("A5: search returns accepted records by default, historical only via explicit toggle", () => {
  it("excludes superseded records by default and includes them with includeHistorical", async () => {
    await withApp(
      async (t) => {
        const def = await t.get(`/api/search?q=${encodeURIComponent("voice input")}`);
        expectStatus(def, 200, "default search");
        const d = def.json<SearchResultDto>();
        expect(d.mode).toBe("discovery");
        expect(d.match).toBe("terms");
        expect(d.includeHistorical).toBe(false);
        const texts = d.records.map((r) => r.text);
        expect(texts.some((x) => x.includes("uses the OpenAI-powered"))).toBe(true); // accepted
        expect(texts.some((x) => x.includes("on-device STT"))).toBe(false); // superseded, hidden
        expect(d.records.every((r) => r.reviewStatus === "accepted")).toBe(true);

        // The browser sends the literal query string "false" for an unchecked toggle.
        const current = await t.get(`/api/search?q=${encodeURIComponent("voice input")}&includeHistorical=false`);
        expectStatus(current, 200, "explicit current-only search");
        const c = current.json<SearchResultDto>();
        expect(c.includeHistorical).toBe(false);
        expect(c.records.map((r) => r.id)).toEqual(d.records.map((r) => r.id));

        const hist = await t.get(`/api/search?q=${encodeURIComponent("voice input")}&includeHistorical=true`);
        const h = hist.json<SearchResultDto>();
        expect(h.includeHistorical).toBe(true);
        const htexts = h.records.map((r) => r.text);
        expect(htexts.some((x) => x.includes("uses the OpenAI-powered"))).toBe(true);
        expect(htexts.some((x) => x.includes("on-device STT"))).toBe(true); // now visible
        expect(h.records.some((r) => r.reviewStatus === "superseded")).toBe(true);
      },
      { seed: true },
    );
  });

  it("never returns proposed records; sources and projects still match", async () => {
    await withApp(
      async (t) => {
        const res = await t.get(`/api/search?q=${encodeURIComponent("NimbusDemo")}`);
        const r = res.json<SearchResultDto>();
        // The ExampleAssistant fact is a proposal → not in record results.
        expect(r.records.length).toBe(0);
        // But the source library matches the raw text...
        expect(r.sources.some((s) => (s.source.title ?? "").includes("codex-memory"))).toBe(true);
        // ...and projects match by name/description.
        const projRes = await t.get(`/api/search?q=${encodeURIComponent("ExampleSuite")}`);
        const p = projRes.json<SearchResultDto>();
        expect(p.projects.length).toBeGreaterThanOrEqual(4);
      },
      { seed: true },
    );
  });

  it("separates canonical record search from discovery/source scan without changing history rules", async () => {
    await withApp(
      async (t) => {
        const discovery = (await t.get(`/api/search?q=${encodeURIComponent("NimbusDemo")}&mode=discovery`)).json<SearchResultDto>();
        expect(discovery.mode).toBe("discovery");
        expect(discovery.sources.length).toBeGreaterThan(0);

        const canonical = (await t.get(`/api/search?q=${encodeURIComponent("NimbusDemo")}&mode=canonical`)).json<SearchResultDto>();
        expect(canonical.mode).toBe("canonical");
        expect(canonical.projects).toEqual([]);
        expect(canonical.sources).toEqual([]);
        expect(canonical.records.every((record) => record.reviewStatus === "accepted")).toBe(true);

        const historical = (await t.get(`/api/search?q=${encodeURIComponent("voice input")}&mode=canonical&includeHistorical=true`)).json<SearchResultDto>();
        expect(historical.mode).toBe("canonical");
        expect(historical.records.some((record) => record.reviewStatus === "superseded")).toBe(true);
        expect(historical.projects).toEqual([]);
        expect(historical.sources).toEqual([]);
      },
      { seed: true },
    );
  });

  it("matches source excerpts with stable offsets and reports tookMs", async () => {
    await withApp(
      async (t) => {
        const res = await t.get(`/api/search?q=${encodeURIComponent("remains in use")}`);
        const r = res.json<SearchResultDto>();
        expect(typeof r.tookMs).toBe("number");
        const withExcerpts = r.sources.find((s) => s.matchedExcerpts.length > 0);
        expect(withExcerpts).toBeTruthy();
        const ex = withExcerpts!.matchedExcerpts[0]!;
        expect(ex.text).toMatch(/remains in use/);
        expect(ex.endOffset).toBeGreaterThan(ex.startOffset);
      },
      { seed: true },
    );
  });

  it("filters by project", async () => {
    await withApp(
      async (t) => {
        const kb = await getProjectByName(t, "ExampleSuite Keyboard");
        const res = await t.get(
          `/api/search?q=${encodeURIComponent("voice")}&projectId=${kb.id}&includeHistorical=true`,
        );
        const r = res.json<SearchResultDto>();
        expect(r.records.length).toBeGreaterThan(0);
        expect(r.records.every((rec) => rec.projectId === kb.id)).toBe(true);
        expect(r.projects.every((project) => project.id === kb.id)).toBe(true);
      },
      { seed: true },
    );
  });

  it("escapes LIKE wildcards in user input", async () => {
    await withApp(
      async (t) => {
        const res = await t.get(`/api/search?q=${encodeURIComponent("100%_%")}`);
        expectStatus(res, 200, "wildcard query");
        expect(res.json<SearchResultDto>().records.length).toBe(0);
      },
      { seed: true },
    );
  });

  it("returns source excerpt counts without changing source membership", async () => {
    await withApp(
      async (t) => {
        const response = await t.get("/api/sources?limit=20&offset=0");
        expectStatus(response, 200, "source list");
        const rows = response.json<Array<{ id: string; excerptCount: number }>>();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          const expected = (t.app.ck.handle.sqlite.prepare("SELECT count(*) AS n FROM source_excerpts WHERE source_id=?").get(row.id) as { n: number }).n;
          expect(row.excerptCount).toBe(expected);
        }
      },
      { seed: true },
    );
  });
});
