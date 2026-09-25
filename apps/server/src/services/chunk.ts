/**
 * Chunk normalized text on paragraph and heading boundaries, preserving exact
 * offsets into the normalized string (handoff §8 step 3).
 * Invariant: normalized.slice(startOffset, endOffset) === text for every chunk.
 */
export interface Chunk {
  startOffset: number;
  endOffset: number;
  text: string;
  kind: "heading" | "paragraph";
}

const MAX_CHUNK = 4000;
const MIN_CHUNK = 40;
const HEADING_RE = /^#{1,6}\s+\S/;

export function chunkText(normalized: string): Chunk[] {
  const raw: Chunk[] = [];
  let cursor = 0;
  const len = normalized.length;

  while (cursor < len) {
    // Skip paragraph separators, tracking position.
    while (cursor < len && normalized[cursor] === "\n") cursor++;
    if (cursor >= len) break;

    let end = normalized.indexOf("\n\n", cursor);
    if (end === -1) end = len;
    // Also split blocks when a heading line begins mid-block.
    const block = normalized.slice(cursor, end);
    const headingSplit = findHeadingSplit(block);
    if (headingSplit > 0) {
      end = cursor + headingSplit;
    }

    const text = normalized.slice(cursor, end);
    const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
    const kind: Chunk["kind"] = HEADING_RE.test(firstLine) ? "heading" : "paragraph";

    if (text.trim().length > 0) {
      if (text.length > MAX_CHUNK) {
        raw.push(...splitLong(cursor, text));
      } else {
        raw.push({ startOffset: cursor, endOffset: end, text, kind });
      }
    }
    cursor = end;
    if (headingSplit > 0) {
      // Do not skip the separator we did not consume; loop continues at heading.
      continue;
    }
  }

  // Merge tiny chunks into the previous one (offsets stay exact via slice).
  const merged: Chunk[] = [];
  for (const chunk of raw) {
    const prev = merged[merged.length - 1];
    if (prev && chunk.text.trim().length < MIN_CHUNK) {
      prev.endOffset = chunk.endOffset;
      prev.text = normalized.slice(prev.startOffset, prev.endOffset);
    } else {
      merged.push({ ...chunk });
    }
  }
  return merged;
}

/** Offset within `block` where a heading line starts (not at position 0). */
function findHeadingSplit(block: string): number {
  let idx = block.indexOf("\n");
  while (idx !== -1) {
    const lineStart = idx + 1;
    const lineEnd = block.indexOf("\n", lineStart);
    const line = block.slice(lineStart, lineEnd === -1 ? block.length : lineEnd);
    if (HEADING_RE.test(line)) return lineStart;
    idx = block.indexOf("\n", lineStart);
  }
  return -1;
}

/** Split an over-long paragraph at sentence (preferred) or line boundaries, preserving offsets. */
function splitLong(startOffset: number, text: string): Chunk[] {
  const out: Chunk[] = [];
  let from = 0;
  while (text.length - from > MAX_CHUNK) {
    const windowEnd = from + MAX_CHUNK;
    let cut = -1;
    const m = /[^.!?…\n][.!?…](?=\s)/g;
    m.lastIndex = from + Math.floor(MAX_CHUNK / 2);
    let match: RegExpExecArray | null;
    while ((match = m.exec(text)) && match.index < windowEnd) {
      cut = match.index + match[0].length;
    }
    if (cut === -1 || cut <= from) {
      // No sentence boundary (e.g. line-oriented notes without end punctuation):
      // prefer the last newline in the second half of the window so lines are
      // never broken mid-content; hard cut only as the last resort.
      const nl = text.lastIndexOf("\n", windowEnd);
      cut = nl > from + Math.floor(MAX_CHUNK / 2) ? nl + 1 : windowEnd;
    }
    out.push({
      startOffset: startOffset + from,
      endOffset: startOffset + cut,
      text: text.slice(from, cut),
      kind: "paragraph",
    });
    from = cut;
    // Skip separating whitespace so slices stay contiguous.
    while (from < text.length && /\s/.test(text[from]!) && text[from] === " ") from++;
  }
  if (from < text.length) {
    out.push({
      startOffset: startOffset + from,
      endOffset: startOffset + text.length,
      text: text.slice(from),
      kind: "paragraph",
    });
  }
  return out;
}
