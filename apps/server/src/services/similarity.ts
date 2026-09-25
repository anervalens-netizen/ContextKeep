/**
 * Near-duplicate detection (A1): exact duplicates are caught by content hash;
 * near-duplicates are surfaced for explicit confirmation using a Sørensen–Dice
 * coefficient over character 5-gram shingle MULTISETS of the normalized text.
 * Multiset counts keep repetitive documents proportional to their length
 * (a set would collapse repeated paragraphs and over-weight small additions).
 */
export function shingles(text: string, k = 5): Map<string, number> {
  const s = text.toLowerCase();
  const counts = new Map<string, number>();
  if (s.length < k) {
    if (s.length > 0) counts.set(s, 1);
    return counts;
  }
  for (let i = 0; i + k <= s.length; i++) {
    const g = s.slice(i, i + k);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

function totalCount(counts: Map<string, number>): number {
  let n = 0;
  for (const c of counts.values()) n += c;
  return n;
}

export function diceSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  const totalA = totalCount(a);
  const totalB = totalCount(b);
  if (totalA === 0 && totalB === 0) return 1;
  if (totalA === 0 || totalB === 0) return 0;
  let overlap = 0;
  for (const [g, ca] of a) {
    const cb = b.get(g);
    if (cb !== undefined) overlap += Math.min(ca, cb);
  }
  return (2 * overlap) / (totalA + totalB);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.85;

export function isNearDuplicate(a: string, b: string): { similar: boolean; score: number } {
  const score = diceSimilarity(shingles(a), shingles(b));
  return { similar: score >= NEAR_DUPLICATE_THRESHOLD, score };
}
