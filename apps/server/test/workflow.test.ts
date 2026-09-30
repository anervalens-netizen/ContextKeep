import { randomUUID, createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.js";
import { reserveRun,beginRun,attachJob,observeRun,verifyRun,getTaskView } from "../src/services/workflow.js";
const token=randomUUID(); const tracked:TestApp[]=[];
afterEach(async()=>{for(const t of tracked.splice(0)) await t.cleanup();});
async function call(t:TestApp,name:string,args:Record<string,unknown>={}) {
 const r=await t.app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:randomUUID(),method:"tools/call",params:{name,arguments:args}}});
 expect(r.statusCode).toBe(200);
 const result=r.json().result; expect(result.isError,JSON.stringify(result)).not.toBe(true); return result.structuredContent;
}
const identity=()=>({clientId:"test",sessionId:"workflow",idempotencyKey:randomUUID()});
async function setup(){
 const t=await makeTestApp({mcpToken:token});tracked.push(t);
 const p=await call(t,"create_project",{name:"Synthetic workflow",idempotencyKey:randomUUID()});
 for(const s of ["First synthetic task","Second synthetic task"]) await call(t,"add_owner_note",{projectId:p.id,statement:s,recordType:"action",idempotencyKey:randomUUID()});
 const tasks=await call(t,"list_tasks",{projectId:p.id});
 return {t,projectId:p.id,taskId:tasks.items[0].id,otherTaskId:tasks.items[1].id,deps:t.app.ck.deps};
}
describe("task-scoped workflow integration",()=>{
 it("keeps equal checkpoint contents distinct for two tasks and preserves a legacy capture",async()=>{
  const {t,projectId,taskId,otherTaskId}=await setup();
  const base={projectId,outcome:"Synthetic evidence",checkpoint:{summary:"Work",nextAction:"Check artifact",blockers:["Artifact missing"]}};
  const a=await call(t,"capture_work",{...base,taskId,...identity()});
  const b=await call(t,"capture_work",{...base,taskId:otherTaskId,...identity()});
  expect(a.outcome.recordId).not.toBe(b.outcome.recordId);
  await call(t,"capture_work",{projectId,taskId:otherTaskId,outcome:"Other task progressed",checkpoint:{nextAction:"Other next step"},...identity()});
  await call(t,"capture_work",{projectId,outcome:"Legacy capture",checkpoint:{nextAction:"Legacy step"},...identity()});
  const context=await call(t,"get_work_context",{projectId,taskId});
  expect(context.latestCheckpoint.recordId).toBe(a.outcome.recordId);
  expect(context.latestCheckpoint.checkpoint.taskId).toBe(taskId);
  expect(context.blockerState.activeCount).toBe(1);
  const view=await call(t,"get_task",{projectId,taskId});
  expect(view.records).toHaveLength(1);
  expect(view.records[0].reviewStatus).toBe("proposed");
 });
 it("fences concurrent starts; an expired reservation never authorizes replay",async()=>{
  const {deps,projectId,taskId}=await setup();
  const input={projectId,taskId,operationKey:"one-effect",inputHash:"a".repeat(64),device:"fixture",identity:"owner",criteria:["artifact exists"]};
  const a=reserveRun(deps,input); expect(reserveRun(deps,input).run.id).toBe(a.run.id);
  expect(()=>reserveRun(deps,{...input,inputHash:"b".repeat(64)})).toThrow(expect.objectContaining({code:"run_operation_conflict"}));
  const scope={projectId,taskId,runId:a.run.id}; const begin=beginRun(deps,{...scope,revision:1});
  expect(()=>beginRun(deps,{...scope,revision:1})).toThrow(expect.objectContaining({code:"run_revision_conflict"}));
  deps.sqlite.prepare("UPDATE workflow_runs SET lease_until=? WHERE id=?").run("2000-01-01T00:00:00.000Z",a.run.id);
  expect(()=>beginRun(deps,{...scope,revision:2})).toThrow(expect.objectContaining({code:"job_start_uncertain"}));
  expect(attachJob(deps,{...scope,leaseToken:begin.leaseToken,externalJobId:"job-fixture"}).run.status).toBe("running");
 });
 it("journals duplicate and out-of-order results; exit zero does not verify a missing artifact",async()=>{
  const {t,deps,projectId,taskId,otherTaskId}=await setup();
  const a=reserveRun(deps,{projectId,taskId,operationKey:"check",inputHash:createHash("sha256").update("fixture").digest("hex"),device:"fixture",identity:"owner",criteria:["artifact exists"]});
  const scope={projectId,taskId,runId:a.run.id};const start=beginRun(deps,{...scope,revision:1});
  attachJob(deps,{...scope,leaseToken:start.leaseToken,externalJobId:"job-fixture"});
  const input={...scope,eventKey:"done",externalJobId:"job-fixture",device:"fixture",identity:"owner",status:"completed" as const,exitCode:0,observedAt:"2026-01-02T00:00:00.000Z"};
  const done=observeRun(deps,input);expect(done.run.verification).toBe("pending");
  expect(observeRun(deps,input).duplicate).toBe(true);
  expect(observeRun(deps,{...input,eventKey:"older",status:"lost",exitCode:null,observedAt:"2026-01-01T00:00:00.000Z"}).run.status).toBe("completed");
  const wrong=await call(t,"capture_work",{projectId,taskId:otherTaskId,outcome:"Artifact missing",...identity()});
  expect(()=>verifyRun(deps,{...scope,revision:done.run.revision,recordId:wrong.outcome.recordId,verdict:"passed"})).toThrow(expect.objectContaining({code:"verification_evidence_missing"}));
  const evidence=await call(t,"capture_work",{projectId,taskId,outcome:"Artifact missing",runEvidence:{runId:scope.runId,runRevision:done.run.revision,externalJobId:"job-fixture"},...identity()});
  const verified=verifyRun(deps,{...scope,revision:done.run.revision,recordId:evidence.outcome.recordId,verdict:"failed"});
  expect(verified.run.verification).toBe("failed");expect(verified.taskUpdated).toBe(false);
  expect(getTaskView(deps,scope).task.taskStatus).not.toBe("done");
 });
});
