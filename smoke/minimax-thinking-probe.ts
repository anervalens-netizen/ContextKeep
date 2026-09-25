// Probe MiniMax API to find the actual accepted format for thinking + 2-message.
// Reads MINIMAX_API_KEY safely. Prints only HTTP status + error snippet
// (NEVER the key, NEVER env contents).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const yaml = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const m = yaml.match(/MINIMAX_API_KEY:\s*['"]?([^'"\n]+)['"]?/);
if (!m) { console.error("no key"); process.exit(2); }
process.env.MINIMAX_API_KEY = m[1];
const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) process.exit(2);

const BASE = "https://api.minimax.io/v1";
const MODEL = "MiniMax-M3";

async function probe(label: string, body: unknown) {
  let status = 0;
  let snippet = "";
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    status = resp.status;
    const text = await resp.text();
    snippet = text.slice(0, 250).replace(/\s+/g, " ");
  } catch (e) {
    snippet = (e instanceof Error ? e.message : String(e)).slice(0, 250);
  }
  console.log(`${status}  ${label}  ${snippet}`);
  return status;
}

const SYS = "you are an extraction agent. Output JSON {candidates:[{type,subject,predicate,valueJson,text,evidenceBasis,taskStatus,sourceEventAt,excerptId,relation,confidence,volatile}]}";
const USR = '{"candidates":[{"type":"fact","subject":"x","predicate":null,"valueJson":null,"text":"hi","evidenceBasis":"document","taskStatus":null,"sourceEventAt":null,"excerptId":"smoke-ex-001","relation":"supports","confidence":0.9,"volatile":false}]}';

// Baseline: user-only message.
await probe("baseline user-only", { model: MODEL, messages: [{ role: "user", content: USR }], max_tokens: 256 });

// 1. Two messages (system + user) NO thinking.
await probe("2-msg NO thinking", {
  model: MODEL,
  messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
  max_tokens: 256,
});

// 2. thinking: {type:"enabled"}.
await probe("thinking:{type:enabled}", {
  model: MODEL,
  messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
  thinking: { type: "enabled" },
  max_tokens: 256,
});

// 3. thinking: true (boolean).
await probe("thinking:true", {
  model: MODEL,
  messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
  thinking: true,
  max_tokens: 256,
});

// 4. thinking: "enabled" (string).
await probe('thinking:"enabled"', {
  model: MODEL,
  messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
  thinking: "enabled",
  max_tokens: 256,
});

// 5. thinking_effort: "low" / "medium" / "high".
for (const eff of ["low", "medium", "high"]) {
  await probe(`thinking_effort:${eff}`, {
    model: MODEL,
    messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
    thinking_effort: eff,
    max_tokens: 256,
  });
}

// 6. reasoning_effort.
for (const eff of ["low", "medium", "high"]) {
  await probe(`reasoning_effort:${eff}`, {
    model: MODEL,
    messages: [{ role: "system", content: SYS }, { role: "user", content: USR }],
    reasoning_effort: eff,
    max_tokens: 256,
  });
}
