import { usePanelText } from "../lib/panel-locale.js";
import { useEffect, useRef, useState } from "react";
import type { PanelPreferences } from "@contextkeep/shared";
type Patch = Partial<PanelPreferences>;
const fields: Array<{
  key: keyof PanelPreferences;
  label: string;
  options: Array<[string, string]>;
}> = [
  {
    key: "landingView",
    label: "Deschidere",
    options: [
      ["recent", "Recente"],
      ["attention", "Atenție"],
      ["active", "Active"],
    ],
  },
  {
    key: "taskVisibility",
    label: "Vizibilitate",
    options: [
      ["actual_tasks", "Taskuri"],
      ["all_actions", "Toate acțiunile"],
    ],
  },
  {
    key: "contextBudget",
    label: "Profunzime",
    options: [
      ["compact", "Compact"],
      ["balanced", "Echilibrat"],
      ["deep", "Detaliat"],
    ],
  },
  {
    key: "refreshInterval",
    label: "Actualizare",
    options: [
      ["manual", "Manual"],
      ["15s", "15 secunde"],
      ["30s", "30 secunde"],
      ["60s", "60 secunde"],
      ["120s", "120 secunde"],
    ],
  },
  {
    key: "language",
    label: "Limbă",
    options: [
      ["ro", "Română"],
      ["en", "English"],
    ],
  },
];
export function PanelSettings({
  values,
  save,
  reload,
}: {
  values: PanelPreferences;
  save: (patch: Patch) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const tr = usePanelText();
  const [patch, setPatch] = useState<Patch>({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const pending = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function perform(write: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice("");
    try {
      if (write) await save(patch);
      else await reload();
      if (active.current) {
        setPatch({});
        setNotice(
          write ? tr("Preferințe salvate.") : tr("Preferințe recitite."),
        );
      }
    } catch {
      if (active.current)
        setNotice(
          tr(
            "Confirmarea lipsește. Recitește preferințele înainte de a reîncerca salvarea.",
          ),
        );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <details className="ck-task-panel">
      <summary>{tr("Preferințe panou")}</summary>
      <p>
        {tr(
          "Editor alternativ pentru aceleași preferințe disponibile în setările native ale hostului.",
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(true);
        }}
      >
        <div className="ck-task-controls">
          {fields.map((field) => (
            <label key={field.key}>
              {tr(field.label)}
              <select
                aria-label={tr(field.label)}
                disabled={busy}
                value={patch[field.key] ?? values[field.key]}
                onChange={(event) =>
                  setPatch((p) => ({ ...p, [field.key]: event.target.value }))
                }
              >
                {field.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {tr(label)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={busy || Object.keys(patch).length === 0}
        >
          {tr("Salvează preferințele")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(false)}
        >
          {tr("Recitește preferințele")}
        </button>
      </form>
      {notice && <p role="status">{tr(notice)}</p>}
    </details>
  );
}
