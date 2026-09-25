/** Escapes LIKE wildcards so user input matches literally. Use with like(col, pattern, "\\"). */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
