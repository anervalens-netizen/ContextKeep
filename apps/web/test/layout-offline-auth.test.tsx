import React from "react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { cleanup,render,screen,waitFor } from "@testing-library/react";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { useUiStore } from "../src/state/ui.js";

const {apiFetchMock,navigateMock,privateReadsPauseMock}=vi.hoisted(()=>({apiFetchMock:vi.fn(),navigateMock:vi.fn(),privateReadsPauseMock:vi.fn()}));
vi.mock("../src/lib/api.js",()=>({apiFetch:apiFetchMock,isNetworkUnavailableError:(error:unknown)=>error instanceof TypeError,setPrivateReadsPausedForAuthTransition:privateReadsPauseMock}));
vi.mock("../src/lib/offline/queue.js",()=>({listConflicts:vi.fn(async()=>[]),listMutations:vi.fn(async()=>[])}));
vi.mock("../src/lib/install-gate.js",()=>({captureInstallPrompt:vi.fn(()=>()=>undefined),currentInstallGate:vi.fn(()=>({allowed:false,reason:""}))}));
vi.mock("@tanstack/react-router",async()=>{const R=await import("react");return{Outlet:()=>R.createElement("div",null,"LOGIN OUTLET"),useLocation:()=>({pathname:"/"}),useNavigate:()=>navigateMock}});
vi.mock("../src/components/AppShell.js",async()=>{const R=await import("react");return{AppShell:()=>R.createElement("div",{"data-testid":"app-shell"},"SHELL")}});
vi.mock("../src/components/CkMark.js",async()=>{const R=await import("react");return{CkMark:()=>R.createElement("span",null,"CK")}});
const {Layout,LAST_AUTHENTICATED_KEY}=await import("../src/components/Layout.js");
function mount(){const q=new QueryClient({defaultOptions:{queries:{retry:false}}});const view=render(<QueryClientProvider client={q}><Layout/></QueryClientProvider>);return{q,view}}

beforeEach(()=>{localStorage.clear();apiFetchMock.mockReset();navigateMock.mockReset();privateReadsPauseMock.mockReset();useUiStore.getState().setOffline(true);useUiStore.getState().setQueuedCount(0);useUiStore.getState().setConflicts([])});afterEach(cleanup);

describe("offline auth shell",()=>{
 it("mounts cached routes when the last successful session was authenticated and auth lookup is offline",async()=>{localStorage.setItem(LAST_AUTHENTICATED_KEY,"1");apiFetchMock.mockRejectedValue(new TypeError("network offline"));mount();expect(await screen.findByTestId("app-shell")).toBeTruthy();expect(navigateMock).not.toHaveBeenCalledWith({to:"/login"})});
 it("does not invent authentication on a first offline launch",async()=>{apiFetchMock.mockRejectedValue(new TypeError("network offline"));mount();expect(await screen.findByText(/Sign in successfully once while ContextKeep is reachable/)).toBeTruthy();expect(screen.queryByTestId("app-shell")).toBeNull()});
 it("records a successful authenticated lookup for later offline use",async()=>{useUiStore.getState().setOffline(false);apiFetchMock.mockResolvedValue({authenticated:true});mount();await screen.findByTestId("app-shell");await waitFor(()=>{expect(localStorage.getItem(LAST_AUTHENTICATED_KEY)).toBe("1");expect(privateReadsPauseMock).toHaveBeenCalledWith(false)})});
 it("uses the cached authenticated shell when ContextKeep is unreachable but the browser still reports online",async()=>{useUiStore.getState().setOffline(false);Object.defineProperty(navigator,"onLine",{value:true,configurable:true});localStorage.setItem(LAST_AUTHENTICATED_KEY,"1");apiFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));mount();expect(await screen.findByTestId("app-shell")).toBeTruthy();await waitFor(()=>expect(useUiStore.getState().offline).toBe(true));expect(navigateMock).not.toHaveBeenCalledWith({to:"/login"})});
 it("does not use cached authentication for semantic HTTP-style errors",async()=>{useUiStore.getState().setOffline(false);localStorage.setItem(LAST_AUTHENTICATED_KEY,"1");apiFetchMock.mockRejectedValue(new Error("server rejected request"));mount();expect(await screen.findByText("Could not verify the ContextKeep session.")).toBeTruthy();expect(screen.queryByTestId("app-shell")).toBeNull()});
 it("makes auth-status cancellable so stale authenticated responses cannot survive logout fencing",async()=>{useUiStore.getState().setOffline(false);let signal:AbortSignal|undefined;apiFetchMock.mockImplementation((_url:string,opts?:{signal?:AbortSignal})=>new Promise((_resolve,reject)=>{signal=opts?.signal;signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true})}));const{q}=mount();await waitFor(()=>expect(signal).toBeDefined());await q.cancelQueries();expect(signal?.aborted).toBe(true)});
});
