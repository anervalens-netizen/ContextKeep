import { OfflineOperationInspector } from "./OfflineOperationInspector.js";
import type { ReactNode } from "react";
import { useThemeStore, type ThemeChoice } from "../state/theme.js";

type Props={offline:boolean;queuedCount:number;onOpenChangelog:()=>void};
export function ShellUtilities(p:Props):ReactNode{
 const theme=useThemeStore((s)=>s.choice);const setTheme=useThemeStore((s)=>s.setChoice);
 return <><div className="flex gap-1"><select aria-label="Color theme" value={theme} onChange={(e)=>setTheme(e.target.value as ThemeChoice)} className="min-w-0 flex-1 rounded-md border border-ck-line bg-ck-bg px-2 py-1 text-[10px]"><option value="light">Light</option><option value="dark">Dark</option><option value="auto">Auto</option></select><button type="button" onClick={p.onOpenChangelog} className="rounded-md border border-ck-line px-2 text-[10px] text-ck-muted">Changelog</button></div><div className="mt-1 flex items-center gap-2 px-1 text-[9px] text-ck-muted"><span className={`h-1.5 w-1.5 rounded-full ${p.offline?"bg-ck-amber":"bg-ck-green"}`}/>{p.offline?"Offline":"Connected"}{p.queuedCount>0?<span className="ml-auto">{p.queuedCount} queued</span>:null}</div><OfflineOperationInspector /></>;
}
