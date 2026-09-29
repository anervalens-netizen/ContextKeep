import { describe,it,expect,vi } from "vitest";
import { render,screen,fireEvent,waitFor,cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { TaskPanel,type TaskTransport,type TaskView } from "../src/components/TaskPanel.js";
afterEach(cleanup);
const task={id:"task-a",subject:"Verify synthetic result",taskStatus:"in_progress",reviewStatus:"proposed",revision:2};
const view:TaskView={task,latestCheckpoint:{recordedAt:"2026-01-01T00:00:00.000Z",provenance:"agent_report",status:"proposed",checkpoint:{summary:"Build completed",nextAction:"Inspect artifact"}},blockers:{active:[]},runs:[{id:"run-a",status:"completed",verification:"pending",externalJobId:"job-a",updatedAt:"2026-01-01T00:00:00.000Z",criteria:["Artifact exists"]}],records:[{id:"evidence",text:"Unreviewed fixture evidence",reviewStatus:"proposed",recordedAt:"2026-01-01T00:00:00.000Z"}],pagination:{nextOffset:null}};
describe("shared task dossier",()=>{
 it("selects read-only context and shows execution separately from verification",async()=>{
  const select=vi.fn(),read=vi.fn(async()=>view);
  const transport:TaskTransport={projects:async()=>[{id:"project",name:"Synthetic"}],tasks:async()=>({items:[task],nextOffset:null}),task:read};
  render(<TaskPanel transport={transport} onSelection={select}/>);
  await screen.findByRole("option",{name:"Synthetic"});
  fireEvent.change(screen.getByLabelText("Project"),{target:{value:"project"}});
  await screen.findByRole("option",{name:/Verify synthetic/});
  expect(read).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Task"),{target:{value:"task-a"}});
  await screen.findByText("Verification: pending");
  expect(screen.getByText("Inspect artifact")).toBeTruthy();
  expect(select).toHaveBeenCalledWith({projectId:"project",taskId:"task-a",revision:2});
 });
 it("does not present an old task response after selection changes",async()=>{
  let resolveOld:(value:TaskView)=>void=()=>{};
  const old=new Promise<TaskView>(resolve=>{resolveOld=resolve;});
  const transport:TaskTransport={projects:async()=>[],tasks:async()=>({items:[task,{...task,id:"task-b",subject:"Other task"}],nextOffset:null}),task:async(_p,t)=>t==="task-a"?old:{...view,task:{...task,id:"task-b",subject:"Other task"},latestCheckpoint:null,runs:[],records:[]}};
  render(<TaskPanel transport={transport} projectId="project"/>);
  await screen.findByRole("option",{name:/Verify synthetic/});
  fireEvent.change(screen.getByLabelText("Task"),{target:{value:"task-a"}});
  fireEvent.change(screen.getByLabelText("Task"),{target:{value:"task-b"}});
  await screen.findByText("No checkpoint for this task.");
  resolveOld(view);
  await waitFor(()=>expect(screen.queryByText("Build completed")).toBeNull());
 });
});
