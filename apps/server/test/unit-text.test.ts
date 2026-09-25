import { describe, expect, it } from "vitest";
import { chunkText } from "../src/services/chunk.js";
import { normalizeText } from "../src/services/normalize.js";
import { diceSimilarity, isNearDuplicate, NEAR_DUPLICATE_THRESHOLD, shingles } from "../src/services/similarity.js";

describe("normalizeText (handoff §8 step 2)", () => {
  it("normalizes CRLF and collapses whitespace runs while keeping paragraph boundaries", () => {
    const raw = "# Title\r\n\r\n\r\nSome   text\twith  spaces.  \r\n\r\nSecond paragraph.\n";
    const out = normalizeText(raw);
    expect(out).toBe("# Title\n\nSome text with spaces.\n\nSecond paragraph.");
  });

  it("strips BOM and converts NBSP", () => {
    expect(normalizeText("\uFEFFa\u00a0b")).toBe("a b");
  });

  it("preserves Romanian diacritics intact (NFC-stable, searchable)", () => {
    const ro = "Aplicația este în producție; setările și fișierele rămân șterse ține cont.";
    const out = normalizeText(ro);
    expect(out).toBe(ro);
    expect(out).toContain("producție");
    // NFC composes decomposed input without changing visible text.
    const decomposed = "Aplica\u021Bia".normalize("NFD");
    expect(normalizeText(decomposed)).toBe("Aplica\u021Bia".normalize("NFC"));
  });
});

describe("chunkText (handoff §8 step 3 — offsets preserved)", () => {
  const doc = [
    "# Release notes",
    "",
    "The release process requires exact-SHA promotion and Sigstore verification before anything reaches production systems.",
    "",
    "## Rollback",
    "",
    "Rollback means restoring the previous promoted SHA via the restore center and verifying health endpoints afterwards.",
  ].join("\n");
  const normalized = normalizeText(doc);

  it("invariant: normalized.slice(startOffset, endOffset) === text for every chunk", () => {
    const chunks = chunkText(normalized);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(normalized.slice(c.startOffset, c.endOffset)).toBe(c.text);
    }
  });

  it("chunks appear in source order without overlap", () => {
    const chunks = chunkText(normalized);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startOffset).toBeGreaterThanOrEqual(chunks[i - 1]!.endOffset);
    }
  });

  it("splits headings from following paragraphs", () => {
    const chunks = chunkText(normalized);
    const kinds = chunks.map((c) => c.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("paragraph");
  });

  it("splits over-long paragraphs at sentence boundaries, still offset-exact", () => {
    const sentence = "Deployment verification requires exact SHA promotion before rollout. ";
    const long = sentence.repeat(150); // ~10k chars
    const chunks = chunkText(normalizeText(long));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(normalizeText(long).slice(c.startOffset, c.endOffset)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(4200);
    }
  });

  it("handles empty input", () => {
    expect(chunkText("")).toEqual([]);
  });
});

describe("similarity (A1 near-duplicate detection)", () => {
  it("identical texts score 1", () => {
    expect(diceSimilarity(shingles("abc def"), shingles("abc def"))).toBe(1);
  });

  it("unrelated texts score low", () => {
    const a = shingles("The release process requires exact-SHA promotion and Sigstore verification.");
    const b = shingles("Pisica doarme pe canapeaua verde din sufragerie toata dupa amiaza.");
    expect(diceSimilarity(a, b)).toBeLessThan(0.3);
  });

  it("a long text with one appended sentence is a near-duplicate", () => {
    const base = normalizeText(
      "Deployment notes.\n\n" + "The release process requires exact-SHA promotion and Sigstore verification. ".repeat(6),
    );
    const variant = normalizeText(base + "\n\nAlso check the staging dashboard.");
    const r = isNearDuplicate(base, variant);
    expect(r.similar).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
  });

  it("small edits to a long text stay near-duplicate; rewrites do not", () => {
    const base = "ContextKeep stores project memory with evidence links for every accepted statement. ".repeat(8);
    const smallEdit = base.replace("evidence links", "evidence references");
    expect(isNearDuplicate(base, smallEdit).similar).toBe(true);
    const rewrite = "With completely different wording the whole document says other things entirely now. ".repeat(8);
    expect(isNearDuplicate(base, rewrite).similar).toBe(false);
  });
});
