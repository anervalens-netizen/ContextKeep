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
