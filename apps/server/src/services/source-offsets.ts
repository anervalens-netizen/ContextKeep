/** Source offsets are UTF-16 units in the length-preserving redacted normalized text. */
export function sliceUtf16Excerpt(
  mask: string,
  start: number,
  end: number,
  maxChars = 4_000,
) {
  const limit = Math.min(end, mask.length);
  let cursor = start;
  for (let count = 0; count < maxChars && cursor < limit; count++) {
    cursor += cursor + 1 < limit && mask.codePointAt(cursor)! > 0xffff ? 2 : 1;
  }
  return {
    text: mask.slice(start, cursor),
    textTruncated: cursor < limit,
    deliveredEndOffset: cursor,
  };
}

/** A persisted excerpt must name an intact span in its declared representation. */
export function isUtf16ExcerptSpan(text: string, start: number, end: number) {
  const splitsPair = (offset: number) =>
    (text.charCodeAt(offset) & 0xfc00) === 0xdc00;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    !splitsPair(start) &&
    !splitsPair(end)
  );
}

export function unavailableUtf16Excerpt() {
  return {
    startOffset: 0,
    endOffset: 0,
    text: "",
    unavailableReason: "invalid_normalized_utf16_span" as const,
  };
}

/** The owner HTTP surfaces retain the stored text for usable spans. */
export function ownerSourceExcerpt(
  normalizedText: string,
  row: {
    id: string;
    sourceId: string;
    startOffset: number;
    endOffset: number;
    exactText: string;
    exactTextHash: string;
  },
) {
  const { id, sourceId, startOffset, endOffset, exactText, exactTextHash } = row;
  const excerpt = isUtf16ExcerptSpan(normalizedText, startOffset, endOffset)
    ? { startOffset, endOffset, text: exactText }
    : unavailableUtf16Excerpt();
  return { id, sourceId, exactTextHash, ...excerpt };
}
