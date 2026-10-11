import { describeToolError } from "../lib/tool-error.js";
import { usePanelText } from "../lib/panel-locale.js";
import type { PanelPreferences } from "@contextkeep/shared";
import { useEffect, useRef, useState } from "react";
import type { TaskSelection, TaskTransport } from "./TaskPanel.js";

export type TaskContextPayload = TaskSelection & {
  title: string;
  text: string;
  provenance: { stateSource: string; report: unknown };
};
export type TaskHostActions = {
  attach?: (payload: TaskContextPayload) => Promise<{ updateId: string }>;
  send?: (payload: TaskContextPayload) => Promise<void>;
  currentUpdateId?: string | null;
  pending?: boolean;
  messageUncertain?: boolean;
};
export function TaskContextActions({
  selection,
  title,
  resume,
  host,
  contextBudget = "balanced",
}: {
  selection: TaskSelection;
  title: string;
  resume: NonNullable<TaskTransport["resume"]>;
  host: TaskHostActions;
  contextBudget?: PanelPreferences["contextBudget"];
}) {
  const tr = usePanelText();
  const key = selection.projectId + ":" + selection.taskId;
  const current = useRef(key);
  current.current = key;
  const generation = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [attachment, setAttachment] = useState<string | null>(null);
  useEffect(() => {
    ++generation.current;
    setNotice("");
    setPrompt("");
    setAttachment(null);
    // An unresolved send belongs to this panel, even after task changes.
    // Keep the no-replay fence until the user inspects the active conversation.
  }, [key]);
  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );
  useEffect(() => {
    if (attachment && host.currentUpdateId === null) {
      setAttachment(null);
      setNotice(tr("Contextul atașat a fost eliminat din conversație."));
    }
  }, [attachment, host.currentUpdateId]);

  const sendUncertain = uncertain || host.messageUncertain === true;
  async function act(kind: "attach" | "send" | "copy") {
    if (pending.current || host.pending || (kind === "send" && sendUncertain))
      return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    setPrompt("");
    const expected = key,
      epoch = generation.current;
    let dispatched = false;
    let prepared = false;
    try {
      const result = await resume(
        selection.projectId,
        selection.taskId,
        contextBudget,
      );
      if (current.current !== expected || generation.current !== epoch) return;
      const d = result.dossier;
      if (d.projectId !== selection.projectId || d.taskId !== selection.taskId)
        throw new Error("Selection identity changed");
      const text = result.resumeText;
      prepared = true;
      const payload: TaskContextPayload = {
        projectId: d.projectId,
        taskId: d.taskId,
        revision: d.taskRevision,
        stateToken: d.stateToken,
        title: d.title,
        text,
        provenance: { stateSource: d.stateSource, report: d.lastReported },
      };
      setPrompt(text);
      if (kind === "copy") {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          if (current.current === expected && generation.current === epoch)
            setNotice(tr("Prompt copiat."));
        } else setNotice(tr("Selectează și copiază promptul de mai jos."));
      } else if (kind === "attach") {
        if (!host.attach) throw new Error("Attachment unsupported");
        dispatched = true;
        const ack = await host.attach(payload);
        if (!ack?.updateId) throw new Error("Attachment not acknowledged");
        if (current.current === expected && generation.current === epoch) {
          setAttachment(ack.updateId);
          setNotice(tr("Context atașat: ") + payload.title);
        }
      } else {
        if (!host.send) throw new Error("Message unsupported");
        dispatched = true;
        await host.send(payload);
        if (current.current === expected && generation.current === epoch)
          setNotice(
            tr("Mesaj acceptat în conversație. Execuția nu este confirmată."),
          );
      }
    } catch (error) {
      if (kind === "send" && dispatched) setUncertain(true);
      if (current.current === expected && generation.current === epoch) {
        setNotice(
          describeToolError(
            error,
            kind === "copy" && prepared
              ? tr(
                  "Copierea automată nu este disponibilă. Selectează și copiază promptul de mai jos.",
                )
              : dispatched
                ? tr(
                    "Confirmarea hostului lipsește. Verifică conversația; nu retrimitem automat.",
                  )
                : tr(
                    "Contextul nu poate fi pregătit. Reîncearcă după verificarea conexiunii.",
                  ),
          ),
        );
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="ck-context-actions"
      aria-label={tr("Acțiuni pentru conversație")}
    >
      <strong>{title}</strong>
      <small>
        {tr("Profunzime context: ")}
        {contextBudget}
        {tr(". Limite în caractere, nu tokenuri facturabile.")}
      </small>
      <div className="ck-context-buttons">
        <button
          disabled={busy || host.pending || !host.attach}
          onClick={() => void act("attach")}
        >
          {tr("Atașează contextul")}
        </button>
        <button
          disabled={busy || host.pending || sendUncertain || !host.send}
          onClick={() => void act("send")}
        >
          {tr("Continuă în chat")}
        </button>
        <button disabled={busy} onClick={() => void act("copy")}>
          {tr("Copiază promptul")}
        </button>
      </div>
      {(!host.attach || !host.send) && (
        <small>
          {tr(
            "Hostul nu oferă toate acțiunile. Poți copia promptul în conversație.",
          )}
        </small>
      )}
      {busy && <p role="status">{tr("Se verifică starea curentă…")}</p>}
      {notice && <p role="status">{tr(notice)}</p>}
      {sendUncertain && (
        <p role="alert">
          {tr(
            "Trimitere cu rezultat incert. Verifică mesajele din conversație înainte de orice reluare.",
          )}
        </p>
      )}
      {prompt && (
        <details>
          <summary>{tr("Prompt și proveniență")}</summary>
          <textarea
            aria-label={tr("Prompt pentru conversație")}
            readOnly
            rows={7}
            value={prompt}
            onFocus={(e) => e.target.select()}
          />
        </details>
      )}
    </section>
  );
}
