export const MCP_RESULT_BYTE_BUDGET = 750_000;

export function dualContentResultBytes(value: unknown): number {
  const text = JSON.stringify(value);
  const result = {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
