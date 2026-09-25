import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const { api, clipboard } = vi.hoisted(() => ({ api: vi.fn().mockImplementation(() => new Promise(() => {})), clipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/lib/api.js", () => ({apiFetch: api, isNetworkUnavailableError: () => true, ApiError: class extends Error {}}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({children, params, search, to}: any) => <a href={`${to.replace('$projectId', params?.projectId ?? '')}?${new URLSearchParams(search)}`}>{children}</a>,
  useParams: () => ({projectId: "p1"}), useSearch: () => ({}), useLocation: () => ({pathname:"/projects/p1"}),
}));
import { ProjectMemoryDashboard } from "../src/components/ProjectMemoryDashboard.js";
import ProjectDetail from "../src/pages/ProjectDetail.js";
const clients: QueryClient[] = [];
afterEach(() => {cleanup(); for (const client of clients.splice(0)) client.clear(); clipboard.mockClear();});
function client() {const c = new QueryClient({defaultOptions:{queries:{retry:false, staleTime:Infinity}}}); clients.push(c); return c;}
function context(id: string) {return {
  project:{id, name:id}, freshness:{canonicalCursor:1,workingCursor:2},
  goals:{items:[]}, constraints:{items:[]}, actions:{items:[]},
  workingMemory:{total:1,items:[{recordId:'w1',subject:'Compact capture',recordedAt:'2026-09-24'}]},
  facts:{items:[{recordId:'s1',text:'Stale runtime',stale:true}]},
  latestCheckpoint:{recordId:'c1',status:'proposed',recordedAt:'2026-09-24',provenance:'agent_report',checkpoint:{summary:'Checkpoint'}},
  blockerState:{activeCount:1,resolvedCount:0,active:[{blockerId:'b1',text:'Verify release',checkpointRecordId:'c1'}]},
  indicators:{stale:true,truncated:false,unknown:[]},
};}
it("RC01/RC02/RC10 retain visible compact links and atomic provenance through remount, switching and copy", async () => {
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:clipboard}});
  const c=client();
  c.setQueryData(['work-context','p1'], {data:context('p1'),provenance:{source:'cache',fetchedAt:'2026-09-20T00:00:00Z'}});
  c.setQueryData(['work-context','p2'], {data:context('p2'),provenance:{source:'network',fetchedAt:'2026-09-24T00:00:00Z'}});
  c.setQueryData(['meta'], {data:{schemaVersion:16},provenance:{source:'cache',fetchedAt:'2026-09-19T00:00:00Z'}});
  const view=render(<QueryClientProvider client={c}><ProjectMemoryDashboard projectId="p1"/></QueryClientProvider>);
  expect(screen.getByRole('link',{name:'Compact capture'}).getAttribute('href')).toContain('recordId=w1');
  expect(screen.getByRole('link',{name:/Review stale record/}).getAttribute('href')).toContain('recordId=s1');
  expect(screen.getByRole('link',{name:/Blocker: Verify/}).getAttribute('href')).toContain('recordId=c1');
  expect(screen.getByRole('link',{name:'Search evidence'}).getAttribute('href')).toContain('projectId=p1');
  fireEvent.click(screen.getByRole('button',{name:'Copy context'}));
  await waitFor(()=>expect(clipboard).toHaveBeenCalled());
  expect(clipboard.mock.calls[0][0]).toContain('2026-09-20');
  view.unmount();
  const remount=render(<QueryClientProvider client={c}><ProjectMemoryDashboard projectId="p1"/></QueryClientProvider>);
  expect(screen.getByText(/Offline\/cached snapshot/)).toBeTruthy();
  remount.rerender(<QueryClientProvider client={c}><ProjectMemoryDashboard projectId="p2"/></QueryClientProvider>);
  expect(screen.queryByText(/Offline\/cached snapshot/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Copy context'}));
  await waitFor(()=>expect(clipboard).toHaveBeenCalledTimes(2));
  expect(clipboard.mock.calls[1][0]).not.toContain('2026-09-19');
  expect(clipboard.mock.calls[1][0]).not.toContain('2026-09-20');
});
it("RC10 selected tabs identify their panel and support keyboard navigation", () => {
  const c=client();
  render(<QueryClientProvider client={c}><ProjectDetail/></QueryClientProvider>);
  const tabs=screen.getAllByRole('tab');
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(tabs[0],{key:'ArrowRight'});
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1].id);
  fireEvent.keyDown(tabs[1],{key:'Home'});
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
});

vi.mock("../src/lib/offline/queue.js", () => ({listConflicts: vi.fn().mockResolvedValue([]), listMutations: vi.fn().mockResolvedValue([{seq:1,method:'POST',url:'/api/inbox/decide',label:'Review proposal',deliveryState:'in_flight',body:{private:'not shown'}}])}));
import { OfflineOperationInspector } from "../src/components/OfflineOperationInspector.js";
it("RC10 offline inspection displays operation status without changing or exposing its payload", async () => {
  render(<OfflineOperationInspector/>);
  fireEvent.click(screen.getByRole('button',{name:'Inspect offline operations'}));
  expect(await screen.findByText(/Review proposal · in_flight/)).toBeTruthy();
  expect(screen.queryByText(/not shown/)).toBeNull();
});

import { useShellData } from "../src/components/useShellData.js";
function ShellReadStatus() { const data = useShellData(); return <p role="status">{data.projectsStatus ?? "Ready"}</p>; }
it("RC10 shell keeps loading, cached and unavailable states distinct", async () => {
  const c=client();
  const view=render(<QueryClientProvider client={c}><ShellReadStatus/></QueryClientProvider>);
  expect(screen.getByRole('status').textContent).toBe('Loading projects…');
  c.setQueryData(['projects','shell-provenance'],{data:[],provenance:{source:'cache',fetchedAt:null}});
  await waitFor(()=>expect(screen.getByRole('status').textContent).toMatch(/Cached projects.*fetch time unknown/));
  view.unmount();
  const failed=client();
  api.mockRejectedValue(new Error('offline'));
  render(<QueryClientProvider client={failed}><ShellReadStatus/></QueryClientProvider>);
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('Projects unavailable'));
  api.mockImplementation(() => new Promise(() => {}));
});
