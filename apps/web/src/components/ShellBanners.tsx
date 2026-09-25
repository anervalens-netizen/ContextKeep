import type { ReactNode } from "react";
import { useUiStore } from "../state/ui.js";

export function ShellBanners():ReactNode{
 const updateReady=useUiStore((s)=>s.updateReady);const notice=useUiStore((s)=>s.notice);const setNotice=useUiStore((s)=>s.setNotice);
 return <>{updateReady?<div className="border-b border-ck-teal/30 bg-ck-teal-soft px-3 py-2 text-xs"><span className="font-medium text-ck-teal-dark">A new version is ready.</span><button type="button" className="ml-2 underline" onClick={()=>window.location.reload()}>Reload</button></div>:null}{notice?<div className="flex items-center gap-2 border-b border-ck-line bg-ck-surface px-3 py-2 text-xs"><span className={notice.kind==="error"?"text-ck-red":notice.kind==="success"?"text-ck-green":notice.kind==="queued"?"text-ck-blue":"text-ck-muted"}>{notice.text}</span><button type="button" onClick={()=>setNotice(null)} className="ml-auto text-[10px] text-ck-muted underline">dismiss</button></div>:null}</>;
}
