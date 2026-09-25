import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { search } from "../services/search.js";
import { synthesize } from "../services/synthesis.js";
import { AI_MEMORY_PROJECT_ID, seedAiMemoryFixture } from "./ai-memory-fixture.js";
import mainCorpusJson from "./ai-memory-corpus.json" with { type: "json" };
import heldoutJson from "./ai-memory-heldout.json" with { type: "json" };

export interface HeldoutCase {
  id: string;
  language: "ro" | "en";
  categories: string[];
  query: string;
  includeHistorical?: boolean;
  targetRecordIds: string[];
  currentRecordIds?: string[];
  forbiddenRecordIds?: string[];
  requiresEvidence?: boolean;
  shouldAbstain?: boolean;
  abstentionCheck?: "synthesis_unknown";
}

const CASES = heldoutJson as HeldoutCase[];
const MAIN = mainCorpusJson as Array<{ query: string }>;
export const HELDOUT_CORPUS_SHA256 = createHash("sha256")
  .update(readFileSync(new URL("./ai-memory-heldout.json", import.meta.url)))
  .digest("hex");

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function validateHeldoutCorpus(): void {
  if (CASES.length < 30) throw new Error("held-out corpus requires >=30 cases");
  const mainQueries = new Set(MAIN.map((item) => normalized(item.query)));
  const ids = new Set<string>();
  for (const item of CASES) {
    if (ids.has(item.id)) throw new Error(`duplicate held-out id ${item.id}`);
    ids.add(item.id);
    if (!item.query.trim()) throw new Error(`empty query ${item.id}`);
    if (mainQueries.has(normalized(item.query))) throw new Error(`held-out query duplicates training/eval corpus: ${item.id}`);
  }
  const count = (category: string) => CASES.filter((item) => item.categories.includes(category)).length;
  if (count("paraphrase") < 10) throw new Error("held-out requires >=10 paraphrase cases");
  if (count("dependency") < 8) throw new Error("held-out requires >=8 dependency cases");
  if (count("current_vs_old") < 5) throw new Error("held-out requires >=5 current cases");
  if (count("missing_info_abstention") < 5) throw new Error("held-out requires >=5 abstention cases");
  if (count("working_memory") < 5) throw new Error("held-out requires >=5 working-memory cases");
  if (!CASES.some((item) => item.language === "ro") || !CASES.some((item) => item.language === "en")) {
    throw new Error("held-out requires RO and EN cases");
  }
  const independent = CASES.filter((item) => item.categories.includes("ckr_independent"));
  if (independent.length < 24) throw new Error("CKR independent corpus requires >=24 frozen cases");
  if (independent.filter((item) => item.language === "ro").length < 8) throw new Error("CKR independent corpus requires >=8 RO cases");
  if (independent.filter((item) => item.language === "en").length < 8) throw new Error("CKR independent corpus requires >=8 EN cases");
  if (independent.filter((item) => item.shouldAbstain === true).length < 6) throw new Error("CKR independent corpus requires >=6 abstention cases");
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function rate(values: boolean[]): number | null {
  return values.length ? round(values.filter(Boolean).length / values.length) : null;
}
function avg(values: number[]): number | null {
  return values.length ? round(values.reduce((a,b)=>a+b,0)/values.length) : null;
}
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return round(sorted[Math.max(0, Math.ceil(sorted.length*p)-1)]! ,3);
}

export async function runHeldoutEval() {
  validateHeldoutCorpus();
  const root = mkdtempSync(path.join(tmpdir(), "contextkeep-heldout-"));
  const config = loadConfig({
    NODE_ENV:"test",
    CK_DATA_DIR:root,
    CK_BACKUP_DIR:path.join(root,"backups"),
    CK_SESSION_SECRET:"heldout-evaluation-secret-0123456789",
    CK_COOKIE_SECURE:"false",
    CK_ADAPTERS:"manual,faketest",
    CK_SYNC_INTERVAL_MINUTES:"0",
    CK_HOUSEKEEPING_INTERVAL_MINUTES:"0",
  }, {});
  const app=await buildApp({config,logger:false});
  try {
    const fixture=seedAiMemoryFixture(app.ck.deps);
    for (const item of CASES) {
      search(app.ck.deps,{q:item.query,projectId:AI_MEMORY_PROJECT_ID,includeHistorical:item.includeHistorical===true,mode:"canonical",scope:item.categories.includes("working_memory")?"working":"canonical",limit:10});
    }
    const results=[] as any[];
    for (const item of CASES) {
      const scope=item.categories.includes("working_memory")?"working":"canonical";
      const started=performance.now();
      const found=search(app.ck.deps,{q:item.query,projectId:AI_MEMORY_PROJECT_ID,includeHistorical:item.includeHistorical===true,mode:"canonical",scope,limit:10});
      const selected=scope==="working"?found.workingRecords:found.records;
      let synthesis:null|ReturnType<typeof synthesize>=null;
      let calls=1;
      if (item.abstentionCheck==="synthesis_unknown") {
        synthesis=synthesize(app.ck.deps,{question:item.query,projectId:AI_MEMORY_PROJECT_ID,includeHistorical:item.includeHistorical===true,limit:10});
        calls++;
      }
      const top10=selected.slice(0,10).map((r:any)=>r.id);
      const top5=top10.slice(0,5);
      const target=item.targetRecordIds;
      const recall5=target.length?target.filter(id=>top5.includes(id)).length/target.length:null;
      const recall10=target.length?target.filter(id=>top10.includes(id)).length/target.length:null;
      const currentIds=item.currentRecordIds??[];
      const forbidden=item.forbiddenRecordIds??[];
      const currentness=(currentIds.length||forbidden.length)
        ? currentIds.every(id=>top10.includes(id)) && forbidden.every(id=>!top10.includes(id))
        : null;
      let evidence:null|number=null;
      if (item.requiresEvidence && target.length) {
        evidence=target.filter(id=>{
          const row=(selected as any[]).find(r=>r.id===id);
          return row?.evidence?.some((e:any)=>e.relation==="supports");
        }).length/target.length;
      }
      const observedAbstention=item.shouldAbstain ? synthesis?.status==="unknown" : null;
      const payload={scope,records:found.records,workingRecords:found.workingRecords,synthesis};
      results.push({
        ...item,scope,top5RecordIds:top5,top10RecordIds:top10,
        recallAt5:recall5===null?null:round(recall5),
        recallAt10:recall10===null?null:round(recall10),
        currentnessCorrect:currentness,
        evidenceCoverage:evidence===null?null:round(evidence),
        observedAbstention,
        synthesisStatus:synthesis?.status??null,
        contextBytes:Buffer.byteLength(JSON.stringify(payload)),
        localLatencyMs:round(performance.now()-started,3),
        toolCallsProxy:calls,
      });
    }
    const subset=(category:string)=>results.filter(r=>r.categories.includes(category));
    const metricsFor=(rows:any[])=>{
      const recall=rows.filter(r=>r.recallAt10!==null).map(r=>r.recallAt10 as number);
      const currents=rows.filter(r=>r.currentnessCorrect!==null).map(r=>r.currentnessCorrect as boolean);
      const evid=rows.filter(r=>r.evidenceCoverage!==null).map(r=>r.evidenceCoverage as number);
      const abst=rows.filter(r=>r.shouldAbstain===true).map(r=>r.observedAbstention===true);
      return {
        caseCount:rows.length,
        recallAt5:avg(rows.filter(r=>r.recallAt5!==null).map(r=>r.recallAt5)),
        recallAt10:avg(recall),
        currentness:rate(currents),
        evidenceCoverageEligible:avg(evid),
        abstention:rate(abst),
      };
    };
    const overall=metricsFor(results);
    const paraphrase=metricsFor(subset("paraphrase"));
    const language=metricsFor(subset("ro_en_wording"));
    const dependency=metricsFor(subset("dependency"));
    const latencies=results.map(r=>r.localLatencyMs as number);
    const contextSizes=results.map(r=>r.contextBytes as number);
    const semanticNeeded=![
      overall.recallAt10!==null && overall.recallAt10>=0.95,
      overall.currentness!==null && overall.currentness>=0.95,
      overall.evidenceCoverageEligible!==null && overall.evidenceCoverageEligible>=0.95,
      overall.abstention!==null && overall.abstention>=0.95,
      paraphrase.recallAt10!==null && paraphrase.recallAt10>=0.95,
      language.recallAt10!==null && language.recallAt10>=0.95,
    ].every(Boolean);
    const relationNeeded=![
      dependency.recallAt10!==null && dependency.recallAt10>=0.95,
      dependency.evidenceCoverageEligible!==null && dependency.evidenceCoverageEligible>=0.95,
    ].every(Boolean);
    return {
      schemaVersion:2,evaluation:"A5.3-A5.4-heldout",generatedAt:new Date().toISOString(),providerCalls:0,
      corpusHashSha256: HELDOUT_CORPUS_SHA256,
      corpus:{caseCount:CASES.length,ro:CASES.filter(x=>x.language==="ro").length,en:CASES.filter(x=>x.language==="en").length,
        categories:Object.fromEntries([...new Set(CASES.flatMap(x=>x.categories))].sort().map(c=>[c,CASES.filter(x=>x.categories.includes(c)).length]))},
      fixture,
      metrics:{overall,paraphrase,roEn:language,dependency,
        latencyMs:{p50:percentile(latencies,0.5),p95:percentile(latencies,0.95),max:Math.max(...latencies)},
        contextBytes:{p50:percentile(contextSizes,0.5),p95:percentile(contextSizes,0.95),max:Math.max(...contextSizes)},
        meanToolCalls:round(results.reduce((s,r)=>s+r.toolCallsProxy,0)/results.length)},
      gates:{
        semanticRetrieval:semanticNeeded?"PILOT_WARRANTED":"CLOSED_NOT_NEEDED",
        explicitRelations:relationNeeded?"PILOT_WARRANTED":"CLOSED_NOT_NEEDED",
      },
      notes:[
        "Held-out queries were authored after A5.2 retrieval code and are not used to tune retrieval.",
        "No provider calls or owner/live data are used.",
        "A semantic gate requires >=0.95 overall/paraphrase/RO-EN retrieval plus currentness/evidence/abstention.",
        "A relation gate requires >=0.95 dependency Recall@10 and eligible evidence coverage.",
      ],
      cases:results,
    };
  } finally {
    await app.close();
    rmSync(root,{recursive:true,force:true});
  }
}
