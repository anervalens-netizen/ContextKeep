import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.js";
import { search } from "../src/services/search.js";

const TOTAL = 12_000;
const RUNS = 18;
const WARMUP = 4;
const quantile = (a: number[], p: number) => {
  const sorted = [...a].sort((x,y)=>x-y);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))]!;
};
describe("synthetic saturated temporal A/B qualification", () => {
 it("reports bounded and comparable current/historical/neutral search response timings", async () => {
   const t = await makeTestApp({seed:true});
   try {
     const db = t.app.ck.deps.sqlite;
     const proj = db.prepare("SELECT id FROM projects LIMIT 1").get() as {id:string};
     const inserted = db.prepare(
       "INSERT INTO records (id,project_id,type,subject,text,review_status,evidence_basis,record_dedup_hash,recorded_at,source_event_at,created_at,updated_at) "+
       "VALUES (? ,?, 'fact', ?, ?, ?, 'document', ?, ?, ?, ?, ?)");
     const baseDay = Date.parse("2026-01-01T00:00:00.000Z");
     const recorded = "2026-09-01T00:00:00.000Z";
     db.transaction(()=>{
       for (let i=0;i<TOTAL;i++){
         const id="b7temporal-"+String(i).padStart(6,"0");
         const event = new Date(baseDay+((i*13)%1400)*60000).toISOString();
         const status=i%5===0?"superseded":"accepted";
         const text="Beacon current deployment runtime status operational evidence "+String(i);
         inserted.run(id,proj.id,"Beacon synthetic "+String(i),text,status,"synthetic-"+id,recorded,event,recorded,recorded);
       }
     })();
     const queries=[
       {name:"current",q:"Beacon current deployment",historical:false},
       {name:"historical",q:"Beacon historical deployment",historical:true},
       {name:"neutral",q:"Beacon deployment",historical:false},
     ];
     const samples:Record<string,number[]>={current:[],historical:[],neutral:[]};
     const returned:Record<string,number>={current:0,historical:0,neutral:0};
     const saturated:Record<string,boolean>={current:false,historical:false,neutral:false};
     for(let round=0;round<WARMUP+RUNS;round++){
       for (const choice of queries.slice(round%2===0?0:1).concat(round%2===0?[]:queries.slice(0,1))){
         const start=performance.now();
         const res=search(t.app.ck.deps,{q:choice.q,projectId:proj.id,mode:"canonical",scope:"canonical",includeHistorical:choice.historical,match:"terms",limit:10});
         const elapsed=performance.now()-start;
         expect(res.records.length).toBeGreaterThan(0);
         if(round>=WARMUP)samples[choice.name]!.push(elapsed);
         returned[choice.name]=res.records.length;
         saturated[choice.name]=res.completeness.records.candidateLimitReached;
       }
     }
     const report={version:"synthetic_bench_v1",rows:TOTAL,measured:RUNS,warmup:WARMUP,results:Object.fromEntries(
       queries.map(({name})=>{
         const a=samples[name]!;
         return [name,{meanMs:+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2),medianMs:+quantile(a,0.5).toFixed(2),p95Ms:+quantile(a,0.95).toFixed(2),returned:returned[name],candidateSaturated:saturated[name]}];
       })
     )};
     console.log("CK_TEMPORAL_SATURATED_BENCH "+JSON.stringify(report));
   } finally {await t.cleanup();}
 },180000);
});
