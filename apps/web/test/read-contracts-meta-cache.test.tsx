import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const { api } = vi.hoisted(() => ({api: vi.fn()}));
vi.mock("../src/lib/api.js", () => ({apiFetch: api, isNetworkUnavailableError: () => false, ApiError: class extends Error {}}));
vi.mock("../src/lib/offline/queue.js", () => ({listConflicts: async () => []}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({children, to}: {children: React.ReactNode; to: string}) => <a href={to}>{children}</a>,
  useSearch: () => ({}),
}));
import Import from "../src/pages/Import.js";
import { ProjectMemoryDashboard } from "../src/components/ProjectMemoryDashboard.js";
const clients: QueryClient[] = [];
afterEach(() => {cleanup(); for(const c of clients.splice(0)) c.clear();vi.clearAllMocks();});
for (const first of ["import", "dashboard"] as const) it(`RC02 metadata retains adapters and provenance when ${first} loads first`, async () => {
  api.mockImplementation(async (url: string) => {
    if (url === "/api/meta") return {appVersion:"test",schemaVersion:16,adapters:[{id:"manual",label:"Configured manual adapter",enabled:true}]};
    if (url === "/api/projects") return [];
    throw new Error(`Unexpected request ${url}`);
  });
  const c=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});clients.push(c);
  c.setQueryData(["work-context","project"],{data:{
    project:{id:"project",name:"ContextKeep"},freshness:{canonicalCursor:1,workingCursor:1},goals:{items:[]},constraints:{items:[]},actions:{items:[]},workingMemory:{items:[],total:0},latestCheckpoint:null,indicators:{stale:false,truncated:false,unknown:[]},
  },provenance:{source:"network",fetchedAt:"2026-09-24T12:00:00Z"}});
  const page=(which: typeof first)=>which==="import"?<Import/>:<ProjectMemoryDashboard projectId="project"/>;
  const wrap=(which: typeof first)=><QueryClientProvider client={c}>{page(which)}</QueryClientProvider>;
  const view=render(wrap(first));
  await waitFor(()=>expect(c.getQueryData(["meta"])).toMatchObject({data:{adapters:[{label:"Configured manual adapter"}]},provenance:{source:"network"}}));
  view.unmount();
  render(wrap(first==="import"?"dashboard":"import"));
  if(first==="dashboard")expect(await screen.findByRole("option",{name:"Configured manual adapter"})).toBeTruthy();
  else expect(screen.getByTestId("memory-dashboard")).toBeTruthy();
  expect(api.mock.calls.filter(([url])=>url==="/api/meta")).toHaveLength(1);
});
