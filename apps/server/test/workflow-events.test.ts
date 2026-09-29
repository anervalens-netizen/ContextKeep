import { Client,StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { randomUUID,randomBytes,createHash } from "node:crypto";
import { afterEach,describe,it,expect } from "vitest";
import { Webhook } from "standardwebhooks";
import { WorkflowEvents,enqueueExecutionEvent } from "../src/services/workflow-events.js";
import { publicAddress,callbackUrl } from "../src/services/webhook-http.js";
import { makeTestApp,type TestApp } from "./helpers.js";
import { reserveRun } from "../src/services/workflow.js";
const tracked:TestApp[]=[];afterEach(async()=>{for(const t of tracked.splice(0))await t.cleanup();});
async function fixture(){
 const token=randomUUID(),t=await makeTestApp({mcpToken:token});tracked.push(t);
 async function rpc(method:string,params:Record<string,unknown>={}){const r=await t.app.inject({method:"POST",url:"/mcp",headers:{authorization:`Bearer ${token}`,accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:randomUUID(),method,params}});return r.json();}
 async function call(name:string,args:Record<string,unknown>){const r=await rpc("tools/call",{name,arguments:args});expect(r.result.isError,JSON.stringify(r)).not.toBe(true);return r.result.structuredContent;}
 const p=await call("create_project",{name:"Event fixture",idempotencyKey:randomUUID()});
 await call("add_owner_note",{projectId:p.id,statement:"Verify fixture execution",recordType:"action",idempotencyKey:randomUUID()});
 const task=(await call("list_tasks",{projectId:p.id})).items[0];
 const deps=t.app.ck.deps,run=reserveRun(deps,{projectId:p.id,taskId:task.id,operationKey:"fixture",inputHash:"a".repeat(64),device:"fixture",identity:"owner",criteria:["Fixture checked"]}).run;
 const input={name:"execution.finished",arguments:{projectId:p.id,taskId:task.id},delivery:{mode:"webhook",url:"https://receiver.example.com/callback",secret:"whsec_"+randomBytes(32).toString("base64")}};
 const data={projectId:p.id,taskId:task.id,runId:run.id,revision:4,status:"completed" as const,verification:"pending" as const};
 return {t,deps,input,data,rpc,token,principal:createHash("sha256").update(token).digest("hex")};
}
describe("durable signed workflow events",()=>{
 it("advertises event methods through the actual MCP transport",async()=>{
  const {t,rpc,token}=await fixture();const list=await rpc("events/list");
  expect(list.result.events[0].name).toBe("execution.finished");
  await t.app.listen({host:"127.0.0.1",port:0});
  const address=t.app.server.address();if(!address||typeof address==="string")throw new Error("fixture port missing");
  const client=new Client({name:"events fixture",version:"1"},{versionNegotiation:{mode:"auto"}});
  let discovered:unknown;
  const wireFetch:typeof fetch=async(input,init)=>{const r=await fetch(input,init);if(typeof init?.body==="string" && JSON.parse(init.body).method==="server/discover")discovered=await r.clone().json();return r;};
  try{await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{fetch:wireFetch,requestInit:{headers:{authorization:`Bearer ${token}`}}}));
   expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
   expect(discovered).toHaveProperty("result.capabilities.events");
  }finally{await client.close();}
 });
 it("verifies, deduplicates, encrypts secrets and resumes pending delivery after restart",async()=>{
  const {deps,input,data}=await fixture();let challengeCount=0;const received:string[]=[];
  const post=async(_url:string,headers:Record<string,string>,body:string)=>{
   new Webhook(input.delivery.secret).verify(body,headers);
   const parsed=JSON.parse(body);if(parsed.type==="verification"){challengeCount++;return {status:200,body:JSON.stringify({challenge:parsed.challenge})};}
   received.push(body);return {status:received.length===1?503:204,body:""};
  };
  const events=new WorkflowEvents(deps,"owner","fixture-encryption",post);
  const first=await events.subscribe(input);expect((await events.subscribe(input)).id).toBe(first.id);expect(challengeCount).toBe(1);
  const stored=deps.sqlite.prepare("SELECT secret FROM workflow_subscriptions").get() as {secret:string};expect(stored.secret).not.toContain(input.delivery.secret);
  enqueueExecutionEvent(deps,data,new Date().toISOString(),"event-1");
  enqueueExecutionEvent(deps,data,new Date().toISOString(),"event-1");
  await events.pump();expect(received).toHaveLength(1);
  deps.sqlite.prepare("UPDATE workflow_deliveries SET next_at='2000-01-01'").run();
  await new WorkflowEvents(deps,"owner","fixture-encryption",post).pump();
  expect(received).toHaveLength(2);expect(received[0]).toBe(received[1]);
  expect((deps.sqlite.prepare("SELECT status FROM workflow_deliveries").get() as {status:string}).status).toBe("delivered");
  events.unsubscribe({...input,delivery:{mode:"webhook",url:input.delivery.url}});
  enqueueExecutionEvent(deps,{...data,revision:5},new Date().toISOString(),"event-2");
  await events.pump();expect(received).toHaveLength(2);
 });
 it("preserves callback verification age and key rotation overlap across refresh",async()=>{
  const {deps,input,data}=await fixture();const nextSecret="whsec_"+randomBytes(32).toString("base64");let challenges=0,deliveries=0;
  const events=new WorkflowEvents(deps,"owner","fixture",async(_u,headers,body)=>{const b=JSON.parse(body);if(b.type==="verification"){challenges++;return {status:200,body:JSON.stringify({challenge:b.challenge})};}deliveries++;new Webhook(nextSecret).verify(body,headers);new Webhook(input.delivery.secret).verify(body,headers);return {status:204,body:""};});
  await events.subscribe(input);const verifiedAt=new Date(Date.now()-120000).toISOString();deps.sqlite.prepare("UPDATE workflow_subscriptions SET verified_at=?").run(verifiedAt);
  await events.subscribe(input);expect((deps.sqlite.prepare("SELECT verified_at FROM workflow_subscriptions").get() as {verified_at:string}).verified_at).toBe(verifiedAt);expect(challenges).toBe(1);
  const rotated={...input,delivery:{...input.delivery,secret:nextSecret}};await events.subscribe(rotated);await events.subscribe(rotated);expect(challenges).toBe(2);
  expect((deps.sqlite.prepare("SELECT old_secret FROM workflow_subscriptions").get() as {old_secret:string|null}).old_secret).not.toBeNull();
  enqueueExecutionEvent(deps,data,new Date().toISOString(),"rotation");await events.pump();expect(deliveries).toBe(1);
  deps.sqlite.prepare("UPDATE workflow_subscriptions SET verified_at='2000-01-01'").run();await events.subscribe(rotated);expect(challenges).toBe(3);
 });
 it("fences unsubscribe during verification and rejects mismatched challenge",async()=>{
  const {deps,input}=await fixture();let release:(value:{status:number;body:string})=>void=()=>{};
  let body="";const events=new WorkflowEvents(deps,"owner","fixture",async(_u,_h,b)=>{body=b;return new Promise(r=>{release=r;});});
  const pending=events.subscribe(input);
  events.unsubscribe({...input,delivery:{mode:"webhook",url:input.delivery.url}});
  release({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})});
  await expect(pending).rejects.toMatchObject({data:{reason:"subscription_changed"}});
  const bad=new WorkflowEvents(deps,"owner","fixture",async()=>({status:200,body:'{"challenge":"wrong"}'}));
  await expect(bad.subscribe(input)).rejects.toMatchObject({data:{reason:"challenge_failed"}});
 });
 it("stops delivery for expiry, rejected tasks, rotated principals and permanent rejection",async()=>{
  const {deps,input,data}=await fixture();let sent=0;
  const post=async(_u:string,_h:Record<string,string>,body:string)=>{const b=JSON.parse(body);if(b.type==="verification")return {status:200,body:JSON.stringify({challenge:b.challenge})};sent++;return {status:410,body:""};};
  const events=new WorkflowEvents(deps,"owner","fixture",post);await events.subscribe(input);
  enqueueExecutionEvent(deps,data,new Date().toISOString(),"terminal");await events.pump();expect(sent).toBe(1);
  expect((deps.sqlite.prepare("SELECT active FROM workflow_subscriptions").get() as {active:number}).active).toBe(0);
  await events.subscribe(input);enqueueExecutionEvent(deps,data,new Date().toISOString(),"next");
  await new WorkflowEvents(deps,"rotated-owner","fixture",post).pump();expect(sent).toBe(1);
  await events.subscribe(input);enqueueExecutionEvent(deps,data,new Date().toISOString(),"third");
  deps.sqlite.prepare("UPDATE workflow_subscriptions SET expires_at='2000-01-01'").run();await events.pump();expect(sent).toBe(1);
  await events.subscribe(input);enqueueExecutionEvent(deps,data,new Date().toISOString(),"fourth");
  deps.sqlite.prepare("UPDATE records SET review_status='rejected' WHERE id=?").run(data.taskId);await events.pump();expect(sent).toBe(1);
 });
 it("has no implicit replay for jobs completed before subscription",async()=>{
  const {deps,input,data}=await fixture();let deliveries=0;
  enqueueExecutionEvent(deps,data,new Date().toISOString(),"early");
  const events=new WorkflowEvents(deps,"owner","fixture",async(_u,_h,body)=>{const b=JSON.parse(body);if(b.type!=="verification")deliveries++;return {status:200,body:JSON.stringify({challenge:b.challenge})};});
  expect((await events.subscribe(input)).cursor).toBeNull();await events.pump();expect(deliveries).toBe(0);
  expect((deps.sqlite.prepare("SELECT count(*) n FROM workflow_events").get() as {n:number}).n).toBe(1);
 });
 it("rejects nonpublic destinations and unsafe URL forms",()=>{
  for(const address of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.1.2","::1","::ffff:127.0.0.1","fd00::1","2002:7f00:1::"])expect(publicAddress(address),address).toBe(false);
  expect(publicAddress("8.8.8.8")).toBe(true);
  expect(()=>callbackUrl("http://receiver.example.com")).toThrow();
  expect(()=>callbackUrl("https://user:pass@example.com")).toThrow();
 });
});
