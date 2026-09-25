#!/usr/bin/env node

import { runAiMemoryEval } from "../src/evals/ai-memory-harness.js";

const report = await runAiMemoryEval();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
