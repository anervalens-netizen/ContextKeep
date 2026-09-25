import assert from "node:assert/strict";
import { makeTestApp, reviewCurrent } from "../test/helpers.js";
import { buildBrief, buildTimeline } from "../src/services/brief.js";
import { readBrief, readTimeline } from "../src/mcp/reads.js";

const t=await makeTestApp();
try {
  const project=(await t.post("/api/projects",{name:"Isolated MCP benchmark"})).json<{id:string}>();
  for(let batch=0;batch<10;batch++) {
    const topic=["deployment","database","networking","security","monitoring","backups","search","export","auth","pwa"][batch]!;
    const text="# "+topic+" corpus batch "+batch+"\n\n"+Array.from({length:100},(_,i)=>"fact: "+topic+" note "+batch+"-"+i+" describing "+topic+" behavior for component "+(i%7)+" in environment "+(i%3)).join("\n");
    const imported=await t.post("/api/imports/text",{projectId:project.id,adapterId:"faketest",text});
    assert.equal(imported.statusCode,201);
  }
  const inbox=(await t.get("/api/inbox?projectId="+project.id+"&limit=1000")).json<{candidates:{id:string}[]}>();
  const ids=inbox.candidates.map(x=>x.id);assert.equal(ids.length,1000);
  for(let i=0;i<ids.length;i+=500) {
    const accepted=await reviewCurrent(t,ids.slice(i,i+500),"accept");assert.equal(accepted.statusCode,200);
  }
  const deps=t.app.ck.deps;
  const page={projectId:project.id,offset:0,limit:10};
  const baselineBrief=()=>{const b=buildBrief(deps,project.id);return b.facts.slice(0,10);};
  const baselineTimeline=()=>buildTimeline(deps,project.id).entries.reverse().slice(0,10);
  const seen=new Set<string>();
  for(let offset=0;offset<1000;offset+=50)for(const e of readTimeline(deps,{...page,offset,limit:50}).entries)seen.add(e.record.recordId);
  assert.equal(seen.size,1000);assert.equal(readBrief(deps,page).sections.facts!.total,1000);
  function measure(fn:()=>unknown) {
    for(let i=0;i<5;i++)fn();
    const samples:number[]=[];
    for(let i=0;i<40;i++){const start=performance.now();fn();samples.push(performance.now()-start);}
    samples.sort((a,b)=>a-b);
    return {medianMs:Number(samples[20]!.toFixed(3)),p95Ms:Number(samples[37]!.toFixed(3))};
  }
  console.log(JSON.stringify({corpus:1000,pageSize:10,samples:40,
    oldBrief:measure(baselineBrief),newBrief:measure(()=>readBrief(deps,page)),
    oldTimeline:measure(baselineTimeline),newTimeline:measure(()=>readTimeline(deps,page)),
    pagination:"1000 distinct records; no loss"}));
}finally{await t.cleanup();}
