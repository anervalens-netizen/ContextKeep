import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { records, sources } from "../src/db/schema.js";
import { chunkText } from "../src/services/chunk.js";
import { normalizeText } from "../src/services/normalize.js";
import {
  expectStatus,
  getInboxCandidates,
  getProjectByName,
  makeTestApp,
  reviewCurrent,
  type TestApp,
} from "./helpers.js";

interface ImportResult {
  jobId: string;
  status: "created" | "duplicate_skipped" | "near_duplicate_pending";
  source: { id: string; contentHash: string; excerptCount: number } | null;
  duplicateOf: { sourceId: string; similarity: number } | null;
  nearDuplicates: { sourceId: string; similarity: number }[];
  excerptCount: number;
  candidateCount: number;
  warnings: string[];
}

const withApp = async (fn: (t: TestApp) => Promise<void>, opts?: { seed?: boolean }) => {
  const t = await makeTestApp(opts ?? {});
  try {
    await fn(t);
  } finally {
    await t.cleanup();
  }
};

describe("A1: manual import dedupes by content hash", () => {
  it("exact duplicate paste is skipped and points at the original source", async () => {
    await withApp(async (t) => {
      const text = "# Notes\n\ndecision: ship M0 by Friday\n\nfact: the workspace uses pnpm";
      const first = await t.post("/api/imports/text", { text, adapterId: "faketest" });
      expectStatus(first, 201, "first import");
      const r1 = first.json<ImportResult>();
      expect(r1.status).toBe("created");
      expect(r1.candidateCount).toBe(2);

      const second = await t.post("/api/imports/text", { text, adapterId: "faketest" });
      expectStatus(second, 200, "duplicate import");
      const r2 = second.json<ImportResult>();
      expect(r2.status).toBe("duplicate_skipped");
      expect(r2.duplicateOf?.sourceId).toBe(r1.source!.id);
      expect(r2.source).toBeNull();

      const audit = await t.get("/api/audit?action=source.duplicate_skipped");
      expect(audit.json<unknown[]>().length).toBeGreaterThan(0);
    });
  });

  it("same content with different whitespace/line endings dedupes via normalized hash", async () => {
    await withApp(async (t) => {
      const text = "# Notes\r\n\r\n\r\ndecision: ship M0 by Friday   \n\nfact: the workspace uses pnpm\t\t\n\n\n";
      const first = await t.post("/api/imports/text", { text, adapterId: "manual" });
      expectStatus(first, 201, "first");
      const plain = "# Notes\n\ndecision: ship M0 by Friday\n\nfact: the workspace uses pnpm";
      const second = await t.post("/api/imports/text", { text: plain, adapterId: "manual" });
      expectStatus(second, 200, "normalized duplicate");
      expect(second.json<ImportResult>().status).toBe("duplicate_skipped");
    });
  });

  it("near-duplicate surfaces for explicit confirmation, never silent merge", async () => {
    await withApp(async (t) => {
      const base =
        "Deployment notes.\n\n" +
        "The release process requires exact-SHA promotion and Sigstore verification. ".repeat(6);
      const first = await t.post("/api/imports/text", { text: base, adapterId: "manual" });
      expectStatus(first, 201, "base import");
      const r1 = first.json<ImportResult>();

      const variant = `${base}\n\nAlso check the staging dashboard before Friday.`;
      const pending = await t.post("/api/imports/text", { text: variant, adapterId: "manual" });
      expectStatus(pending, 200, "near duplicate pending");
      const r2 = pending.json<ImportResult>();
      expect(r2.status).toBe("near_duplicate_pending");
      expect(r2.source).toBeNull();
      expect(r2.nearDuplicates.length).toBeGreaterThan(0);
      expect(r2.nearDuplicates[0]!.sourceId).toBe(r1.source!.id);
      expect(r2.nearDuplicates[0]!.similarity).toBeGreaterThanOrEqual(0.85);

      // Explicit confirmation imports it as a separate source.
      const confirmed = await t.post("/api/imports/text", {
        text: variant,
        adapterId: "manual",
        confirmNearDuplicateOf: r1.source!.id,
      });
      expectStatus(confirmed, 201, "confirmed near duplicate");
      const r3 = confirmed.json<ImportResult>();
      expect(r3.status).toBe("created");
      expect(r3.source!.id).not.toBe(r1.source!.id);

      const audit = await t.get("/api/audit?action=source.near_duplicate_confirmed");
      expect(audit.json<unknown[]>().length).toBeGreaterThan(0);
    });
  });
});

describe("§8.8: record-level exact duplicates are skipped per project", () => {
  it("identical candidate text from a different source is skipped with a warning", async () => {
    await withApp(async (t) => {
      const a = await t.post("/api/imports/text", {
        text: "fact: shared dedup line about the release train",
        adapterId: "faketest",
      });
      expectStatus(a, 201, "source A");
      expect(a.json<ImportResult>().candidateCount).toBe(1);

      const b = await t.post("/api/imports/text", {
        text: "A completely different introduction paragraph explaining unrelated context in detail.\n\nfact: shared dedup line about the release train",
        adapterId: "faketest",
      });
      expectStatus(b, 201, "source B");
      const rb = b.json<ImportResult>();
      expect(rb.candidateCount).toBe(0);
      expect(rb.warnings.join(" ")).toMatch(/§8\.8|duplicate/i);
    });
  });
});

describe("chunk offsets: excerpts slice exactly out of normalized text", () => {
  it("every stored excerpt satisfies normalized.slice(start, end) === text", async () => {
    await withApp(async (t) => {
      const doc = [
        "# Handoff document",
        "",
        "First paragraph with enough content to stand alone as a chunk in the excerpt list.",
        "",
        "## Section two",
        "",
        "Second paragraph describing the deployment steps in more detail than the first one did.",
        "",
        "Third paragraph wraps up with follow-up actions and open questions for the next owner.",
      ].join("\n");
      const res = await t.post("/api/imports/text", { text: doc, adapterId: "manual", title: "Handoff" });
      expectStatus(res, 201, "doc import");
      const sourceId = res.json<ImportResult>().source!.id;

      const detail = await t.get(`/api/sources/${sourceId}`);
      expectStatus(detail, 200, "source detail");
      const { excerpts } = detail.json<{
        excerpts: { id: string; startOffset: number; endOffset: number; text: string }[];
      }>();
      expect(excerpts.length).toBeGreaterThan(1);

      const row = t.app.ck.deps.db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
      const normalized = normalizeText(doc);
      expect(row.normalizedText).toBe(normalized);
      for (const e of excerpts) {
        expect(normalized.slice(e.startOffset, e.endOffset)).toBe(e.text);
      }
      // Re-chunking the stored normalized text must reproduce the same offsets.
      const chunks = chunkText(normalized);
      expect(chunks.map((c) => [c.startOffset, c.endOffset])).toEqual(
        excerpts.map((e) => [e.startOffset, e.endOffset]),
      );
    });
  });
});

describe("file upload: .md/.txt accepted, other types refused", () => {
  it("uploads a .md file through multipart", async () => {
    await withApp(async (t) => {
      const form = new FormData();
      form.append(
        "file",
        new Blob(["# Uploaded notes\n\nfact: uploaded via multipart\ndecision: keep uploads local"], {
          type: "text/markdown",
        }),
        "upload-test.md",
      );
      form.append("adapterId", "faketest");
      const res = await t.postForm("/api/imports/file", form);
      expectStatus(res, 201, "md upload");
      const r = res.json<ImportResult>();
      expect(r.status).toBe("created");
      expect(r.candidateCount).toBe(2);
    });
  });

  it("refuses a .pdf upload with a clear reason", async () => {
    await withApp(async (t) => {
      const form = new FormData();
      form.append("file", new Blob(["%PDF-1.4 fake"], { type: "application/pdf" }), "report.pdf");
      const res = await t.postForm("/api/imports/file", form);
      expectStatus(res, 415, "pdf refused");
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("unsupported_file_type");
      expect(body.error.message).toMatch(/\.md and \.txt/);
    });
  });
});

describe("A20: adapter output can never fabricate owner-confirmed evidence", () => {
  it("owner-claim candidates are downgraded to agent_report", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "owner-claim: the owner confirmed the deployment succeeded",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "owner-claim import");
      const r = res.json<ImportResult>();
      expect(r.candidateCount).toBe(1);
      expect(r.warnings.join(" ")).toMatch(/A20/);

      const candidates = await getInboxCandidates(t);
      const c = candidates.find((x) => (x.text as string).includes("owner confirmed"))!;
      expect(c.evidenceBasis).toBe("agent_report");
      expect(c.evidenceBasis).not.toBe("owner_declaration");
      expect(c.reviewStatus).toBe("proposed");
    });
  });
});

describe("A19/A3 groundwork: importing into a retired project stays proposal-only", () => {
  it("warns that the project is retired and creates proposals only", async () => {
    await withApp(async (t) => {
      const exampleSuiteServer = await getProjectByName(t, "ExampleSuite Server");
      const res = await t.post("/api/imports/text", {
        text: "fact: ExampleSuite Server was deployed at 192.168.0.68 in 2024 and served the API",
        adapterId: "faketest",
        projectId: exampleSuiteServer.id,
      });
      expectStatus(res, 201, "import into retired project");
      const r = res.json<ImportResult>();
      expect(r.warnings.join(" ")).toMatch(/retired/i);

      const rows = t.app.ck.deps.db
        .select()
        .from(records)
        .where(eq(records.projectId, exampleSuiteServer.id))
        .all()
        .filter((x) => x.text.includes("192.168.0.68"));
      expect(rows.length).toBe(1);
      expect(rows[0]!.reviewStatus).toBe("proposed");

      // Project lifecycle untouched by the import.
      const after = await getProjectByName(t, "ExampleSuite Server");
      expect(after.lifecycle).toBe("retired");
    }, { seed: true });
  });
});

describe("Romanian source text stays intact and searchable", () => {
  it("imports diacritics unchanged and finds them via search", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "fact: Aplicația este în producție; setările rămân valide pentru fișiere șterse",
        adapterId: "faketest",
        title: "Note în română",
      });
      expectStatus(res, 201, "romanian import");
      const sourceId = res.json<ImportResult>().source!.id;

      const row = t.app.ck.deps.db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
      expect(row.normalizedText).toContain("Aplicația este în producție");
      expect(row.normalizedText).toContain("setările");

      const candidates = await getInboxCandidates(t);
      const c = candidates.find((x) => (x.text as string).includes("producție"))!;
      const accept = await reviewCurrent(t, [c.id as string], "accept");
      expectStatus(accept, 200, "accept romanian record");

      const search = await t.get(`/api/search?q=${encodeURIComponent("producție")}`);
      expectStatus(search, 200, "search diacritics");
      const found = search.json<{ records: { text: string }[] }>();
      expect(found.records.some((r) => r.text.includes("producție"))).toBe(true);
    });
  });
});

/**
 * Cost-ceiling enforcement (handoff §12 item 13, §16 item 5).
 * FakeTest recognises an optional `usage-estimate:` line in the input text and
 * reports the parsed usage via `estimateUsage()`; the import pipeline enforces
 * CK_COST_CEILING_USD (default 0.05 USD per import) before any candidates are
 * persisted. Adapters that do not implement `estimateUsage` (e.g. Manual)
 * imply no provider cost — the ceiling check is skipped.
 */
describe("M2 §12 item 13: provider cost ceiling is enforced before extraction", () => {
  it("Manual adapter: no usage reported, no ceiling check applied", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "# Manual import\n\ndecision: keep manual imports free of any provider cost.",
        adapterId: "manual",
      });
      expectStatus(res, 201, "manual import");
      const r = res.json<ImportResult & { providerUsage: unknown; costCeilingUsd: number }>();
      expect(r.providerUsage).toBeNull();
      expect(r.costCeilingUsd).toBe(0.05);
    });
  });

  it("FakeTest under the default ceiling: import succeeds, providerUsage is surfaced", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: [
          "usage-estimate: input=500 output=200 cost=0.0200 model=fake-test-v1",
          "",
          "fact: a small fact that fits comfortably under the cost ceiling",
        ].join("\n"),
        adapterId: "faketest",
      });
      expectStatus(res, 201, "under-ceiling import");
      const r = res.json<
        ImportResult & { providerUsage: { estCostUsd: number; model: string } | null; costCeilingUsd: number }
      >();
      expect(r.providerUsage).not.toBeNull();
      expect(r.providerUsage!.estCostUsd).toBeCloseTo(0.02, 6);
      expect(r.providerUsage!.model).toBe("fake-test-v1");
      expect(r.costCeilingUsd).toBe(0.05);
      expect(r.candidateCount).toBe(1);
    });
  });

  it("FakeTest over the default ceiling: 409 cost_ceiling_exceeded + audit row, no candidates persisted", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: [
          "usage-estimate: input=8000 output=4000 cost=0.5000 model=fake-test-v1",
          "",
          "fact: a fact that should never reach the inbox because the cost estimate is too high",
          "decision: refuse the call",
        ].join("\n"),
        adapterId: "faketest",
      });
      expectStatus(res, 409, "over-ceiling refused");
      const body = res.json<{
        error: { code: string; message: string; details: { estCostUsd: number; ceilingUsd: number; jobId: string } | null };
      }>();
      expect(body.error.code).toBe("cost_ceiling_exceeded");
      expect(body.error.message).toMatch(/cost ceiling/i);
      expect(body.error.message).toMatch(/0\.5000/);
      expect(body.error.message).toMatch(/0\.05/);
      expect(body.error.details).not.toBeNull();
      expect(body.error.details!.estCostUsd).toBeCloseTo(0.5, 6);
      expect(body.error.details!.ceilingUsd).toBe(0.05);
      expect(body.error.details!.jobId).toBeTruthy();

      // Audit row written.
      const audit = await t.get("/api/audit?action=provider_call.cost_ceiling_exceeded");
      const events = audit.json<{ action: string; detail: { usage: { estCostUsd: number }; ceilingUsd: number } }[]>();
      expect(events.length).toBe(1);
      expect(events[0]!.action).toBe("provider_call.cost_ceiling_exceeded");
      expect(events[0]!.detail.usage.estCostUsd).toBeCloseTo(0.5, 6);
      expect(events[0]!.detail.ceilingUsd).toBe(0.05);

      // No inbox candidates created (refusal happened before extraction).
      const inbox = await getInboxCandidates(t);
      expect(inbox.some((c) => String(c.text).includes("refuse the call"))).toBe(false);
    });
  });

  it("FakeTest exactly at the ceiling: import succeeds (boundary is inclusive)", async () => {
    await withApp(async (t) => {
      const res = await t.post("/api/imports/text", {
        text: "usage-estimate: input=100 output=100 cost=0.0500 model=fake-test-v1\n\nfact: boundary case is accepted",
        adapterId: "faketest",
      });
      expectStatus(res, 201, "at-ceiling import");
      const r = res.json<ImportResult & { providerUsage: { estCostUsd: number } | null }>();
      expect(r.providerUsage!.estCostUsd).toBeCloseTo(0.05, 6);
      expect(r.candidateCount).toBe(1);
    });
  });
});
