// M2.4e directive §10: probe MiniMax API to discover actual URL + model + auth.
// Reads MINIMAX_API_KEY from ~/.dsh/.credentials.yaml safely (no echo, no
// shell history). Tries multiple URL / model combinations and reports which
// ones return 200 OK. Prints only HTTP status + minimal model name in the
// body — NEVER the API key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const m = yaml.match(/MINIMAX_API_KEY:\s*['"]?([^'"\n]+)['"]?/);
if (!m) {
  console.error("MINIMAX_API_KEY not found");
  process.exit(2);
}
process.env.MINIMAX_API_KEY = m[1];

const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) { console.error("no key"); process.exit(2); }

const BASES = [
  "https://api.minimax.io/v1",
  "https://api.minimaxi.com/v1",
  "https://www.minimax.io/v1",
  "https://www.minimaxi.com/v1",
];
const MODELS = [
  "MiniMax-M3",
  "MiniMax-M2",
  "MiniMax-Text-01",
  "MiniMax-M1",
  "abab6.5s-chat",
  "abab6.5-chat",
  "abab5.5-chat",
];

async function probe(base: string, model: string) {
  const url = `${base}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
    }),
    // 20s hard timeout.
    signal: AbortSignal.timeout(20_000),
  });
  return resp.status;
}

const tests: Array<{ base: string; model: string; status: number }> = [];
for (const base of BASES) {
  for (const model of MODELS) {
    let status = 0;
    try {
      status = await probe(base, model);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tests.push({ base, model, status: -1 });
      console.error(`ERR ${base} ${model}: ${msg.slice(0, 80)}`);
      continue;
    }
    tests.push({ base, model, status });
    console.log(`${status} ${base}  model=${model}`);
    if (status === 200) {
      console.log(`>>> WORKING: ${base} ${model}`);
      // Continue probing all to map the surface.
    }
  }
}

console.log("=== PROBE SUMMARY ===");
for (const t of tests) {
  console.log(`${t.status}  ${t.base}  ${t.model}`);
}
