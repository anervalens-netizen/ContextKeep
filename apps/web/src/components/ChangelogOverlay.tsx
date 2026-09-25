import { useEffect,useRef,type ReactNode } from "react";
import { changelog } from "../changelog.js";
import { Icon } from "./Icon.js";

export function ChangelogOverlay({open,onClose}:{open:boolean;onClose:()=>void}):ReactNode{
 const closeRef=useRef<HTMLButtonElement|null>(null);const previousFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  if(!open)return;
  previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  closeRef.current?.focus();
  const onKey=(event:KeyboardEvent):void=>{
   if(event.key==="Escape"){event.preventDefault();onClose();return}
   if(event.key==="Tab"){event.preventDefault();closeRef.current?.focus()}
  };
  window.addEventListener("keydown",onKey);
  return()=>{window.removeEventListener("keydown",onKey);previousFocus.current?.focus()};
 },[open,onClose]);
 if(!open)return null;
 return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-3 sm:items-center" onClick={onClose}><div role="dialog" aria-modal="true" aria-labelledby="changelog-title" className="max-h-[70vh] w-full max-w-md overflow-auto rounded-2xl bg-ck-surface p-4 shadow-xl" onClick={(e)=>e.stopPropagation()}><div className="flex items-center"><h2 id="changelog-title" className="text-sm font-semibold">Changelog</h2><button ref={closeRef} type="button" onClick={onClose} className="ml-auto rounded-md p-1.5 text-ck-muted hover:bg-ck-bg" aria-label="Close changelog"><Icon name="close" className="h-4 w-4"/></button></div>{changelog.map((entry)=><section key={entry.version} className="mt-3"><h3 className="text-xs font-semibold text-ck-teal">{entry.version} — {entry.date}</h3><ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ck-muted">{entry.notes.map((note)=><li key={note}>{note}</li>)}</ul></section>)}</div></div>;
}
