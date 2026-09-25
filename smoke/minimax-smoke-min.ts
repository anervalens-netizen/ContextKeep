// Minimal smoke: use the EXACT body shape that the probe used successfully.
// If this returns 401, the issue is elsewhere (key, env propagation).
// If this returns 200, the smoke's body is the problem.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const m = yaml.match(/MINIMAX_API_KEY:\s*['"]?([^'"\n]+)['"]?/);
if (!m) { console.error("no key"); process.exit(2); }
process.env.MINIMAX_API_KEY = m[1];

const url = new URL("../apps/server/src/adapters/minimax.ts", import.meta.url);
const mod = await import(url.pathname);
const adapter = mod.minimaxAdapter;

// EXACT body shape that the probe confirmed works (200 OK).
const input = {
  sourceId: "smoke",
  projectId: null,
  authorLabel: null,
  eventAt: null,
  excerpts: [
    {
      id: "smoke-ex-001",
      text: "hi",
      startOffset: 0,
      endOffset: 2,
    },
  ],
};
// Note: the adapter will add the system prompt and large max_tokens. To
// reproduce the probe exactly, override env so the adapter uses the same
// params.
process.env.CK_MINIMAX_MAX_OUTPUT_TOKENS = "8";

try {
  const result = await adapter.extract(input);
  console.log("SMOKE PASS");
  console.log("candidates.length:", result.candidates.length);
  console.log("usage:", JSON.stringify(result.usage));
} catch (e) {
  console.error("SMOKE FAIL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
