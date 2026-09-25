import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let isolated;
let endpoint="http://127.0.0.1:3082/mcp";
if(process.argv.includes("--self-test")) {
  const {makeTestApp}=await import("../test/helpers.ts");
  process.env.CK_MCP_TOKEN=crypto.randomBytes(32).toString("hex");
  isolated=await makeTestApp({mcpToken:process.env.CK_MCP_TOKEN});
  await isolated.app.listen({host:"127.0.0.1",port:0});
  endpoint="http://127.0.0.1:"+isolated.app.server.address().port+"/mcp";
}
if (!process.env.CK_MCP_TOKEN) throw new Error("CK_MCP_TOKEN must be supplied through the private environment file.");
const client = new Client({name:"ContextKeep v2 live verification",version:"2"});
const called = new Set();
let projectId;
const key = () => crypto.randomUUID();
async function call(name,args={}) {
  const response = await client.callTool({name,arguments:args});
  if (response.isError) throw new Error(name + ": " + JSON.stringify(response.structuredContent));
  called.add(name);
  return response.structuredContent;
}
async function remove(recordId) {
  const row=await call("get_record",{recordId,includeUnreviewed:true});
  return call("delete_record",{recordId,revision:row.revision,reason:"End of isolated MCP verification",idempotencyKey:key()});
}
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{
  requestInit:{headers:{authorization:"Bearer "+process.env.CK_MCP_TOKEN}}
}));
try {
  const inventory=await client.listTools();
  assert.equal(inventory.tools.length,27);
  assert.equal((await call("get_capabilities")).version,"2.0.0");
  const project=await call("create_project",{name:"MCP verification "+new Date().toISOString(),description:"Isolated synthetic data for owner-authorized MCP v2 verification. Retired when complete.",idempotencyKey:key()});
  projectId=project.id;
  await call("update_project",{projectId,revision:project.revision,aliases:["MCP-v2-verification-"+key()],idempotencyKey:key()});
  await call("set_project_lifecycle",{projectId,revision:2,state:"active",reason:"Temporary owner-authorized verification project",idempotencyKey:key()});
  const listed=await call("list_projects",{q:project.name});
  assert(listed.projects.some(x=>x.id===projectId));
  await call("get_project",{projectId});
  const source=await call("add_source",{projectId,title:"Synthetic verification evidence",authorLabel:"MCP smoke agent",text:"Synthetic MCP verification evidence: read, edit, accept, delete and restore a temporary action. "+key(),idempotencyKey:key()});
  assert((await call("list_sources",{projectId})).items.some(x=>x.id===source.source.id));
  const evidence=await call("get_source",{sourceId:source.source.id});
  const made=await call("create_record",{projectId,sourceExcerptId:evidence.excerpts[0].id,recordType:"action",subject:"Synthetic verification",text:"Verify reversible MCP management.",evidenceBasis:"observed_technical",idempotencyKey:key()});
  const recordId=made.record.id;
  const edited=await call("edit_record",{recordId,revision:1,text:"Verify reversible MCP management end to end.",taskStatus:"open",idempotencyKey:key()});
  await call("list_records",{projectId,reviewStatus:"proposed"});
  await call("review_records",{items:[{recordId,revision:edited.revision}],action:"accept",idempotencyKey:key()});
  await call("get_record",{recordId});
  await call("get_project_brief",{projectId});
  await call("get_project_timeline",{projectId});
  assert((await call("search_context",{projectId,q:"reversible"})).records.length>0);
  const note=await call("add_owner_note",{projectId,recordType:"decision",subject:"Synthetic test only",statement:"Synthetic owner-authorized verification note; no business decision.",idempotencyKey:key()});
  const oldId=note.acceptedRecordIds[0];
  const correction=await call("propose_correction",{projectId,recordType:"decision",subject:"Synthetic test only",statement:"Corrected synthetic verification note; no business decision.",supersedesRecordIds:[oldId],idempotencyKey:key()});
  await call("get_correction",{jobId:correction.jobId});
  const confirmed=await call("confirm_correction",{jobId:correction.jobId,idempotencyKey:key()});
  const deleted=await remove(recordId);
  assert.equal((await call("search_context",{projectId,q:"reversible"})).records.length,0);
  await call("restore_record",{recordId,revision:deleted.revision,deletionId:deleted.deletionId,idempotencyKey:key()});
  assert((await call("search_context",{projectId,q:"reversible"})).records.length>0);
  const handoff=await call("create_handoff",{projectId,objective:"Synthetic verification snapshot",idempotencyKey:key()});
  await call("list_handoffs",{projectId});
  assert((await call("get_handoff",{handoffId:handoff.id})).markdown.length>0);
  await call("get_audit",{targetType:"record",targetId:recordId});
  await remove(recordId);await remove(oldId);
  for(const id of confirmed.acceptedRecordIds) await remove(id);
  assert.equal(called.size,27);
  console.log(JSON.stringify({ok:true,tools:inventory.tools.length,tested:called.size,projectId,toolsCalled:[...called].sort()}));
} finally {
  if(projectId) {
    const current=await call("get_project",{projectId});
    await call("set_project_lifecycle",{projectId,revision:current.project.revision,state:"retired",reason:"Isolated MCP verification finished; preserve audit and recovery evidence.",idempotencyKey:key()});
    console.log(JSON.stringify({verificationProject:projectId,lifecycle:"retired"}));
  }
  await client.close();
  if(isolated) await isolated.cleanup();
}
