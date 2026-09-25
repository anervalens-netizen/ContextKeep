#!/usr/bin/env node
import { runHeldoutEval } from "../src/evals/ai-memory-heldout.js";
const report=await runHeldoutEval();
process.stdout.write(JSON.stringify(report,null,2)+"\n");
