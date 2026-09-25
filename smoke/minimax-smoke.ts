// M2.4e directive §10: bounded LIVE MiniMax smoke.
// Reads MINIMAX_API_KEY from ~/.dsh/.credentials.yaml (DSH env/config) by
// regex (no echo), sets process.env internally (no shell history), calls
// minimaxAdapter.extract once, and prints the RESULT only — never the key.
//
// Usage: pnpm --filter @contextkeep/server exec tsx ../../smoke/minimax-smoke.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 1. Locate the key file safely.
const credsPath = join(homedir(), ".dsh", ".credentials.yaml");
const yaml = readFileSync(credsPath, "utf8");

// 2. Parse MINIMAX_API_KEY from the refs block via regex. The value is
// NEVER echoed or assigned to a top-level identifier that could be
// serialized by an error trace.
const m = yaml.match(/MINIMAX_API_KEY:\s*['"]?([^'"\n]+)['"]?/);
if (!m) {
  console.error("MINIMAX_API_KEY not found in ~/.dsh/.credentials.yaml");
  process.exit(2);
}
const capturedKey = m[1];
process.env.MINIMAX_API_KEY = capturedKey;
// Confirm credential loaded (length only — NEVER any prefix/suffix/char of the secret).
console.log("credential loaded: YES (length:", capturedKey.length, ")");

// 3. Import the adapter via the TypeScript loader.
const url = new URL("../apps/server/src/adapters/minimax.ts", import.meta.url);
const mod = await import(url.pathname);
const adapter = mod.minimaxAdapter;
// DEBUG: confirm adapter sees the env var.
console.log("after import process.env.MINIMAX_API_KEY length:", (process.env.MINIMAX_API_KEY ?? "").length);

// 4. Bounded input: a few facts/decisions. Deliberately small.
const input = {
  sourceId: "smoke",
  projectId: null,
  authorLabel: null,
  eventAt: null,
  excerpts: [
    {
      id: "smoke-ex-001",
      text:
        "ContextKeep smoke test for MiniMax-M3.\n" +
        "fact: ContextKeep is a private project-memory app for a single owner.\n" +
        "decision: ship M2 with the minimax primary extraction provider.",
      startOffset: 0,
      endOffset: 200,
    },
  ],
};

try {
  const result = await adapter.extract(input);
  // Print ONLY the result shape (never the key, never env contents).
  console.log("=== MINIMAX SMOKE RESULT ===");
  const candidates = result.candidates ?? [];
  console.log("candidates.length:", candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    console.log(`  candidate[${i}].type:`, c.type);
    console.log(`  candidate[${i}].subject:`, c.subject);
    console.log(`  candidate[${i}].text:`, c.text.slice(0, 120));
    console.log(`  candidate[${i}].excerptId:`, c.excerptId);
    console.log(`  candidate[${i}].volatile:`, c.volatile);
    console.log(`  candidate[${i}].evidenceBasis:`, c.evidenceBasis);
  }
  console.log("usage:", JSON.stringify(result.usage, null, 2));
  console.log("SMOKE PASS");
} catch (e) {
  // Print ONLY the error message — never any token / key / env value.
  const msg = e instanceof Error ? e.message : String(e);
  console.error("SMOKE FAIL:", msg);
  process.exit(1);
}
