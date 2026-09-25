import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useThemeStore, type ThemeChoice } from "../state/theme.js";
import { readMeta } from "../lib/provenance-query.js";
import type { LocalDataPurgeResult, LocalDataSummary } from "../lib/offline/local-data.js";
import { queryKeys } from "../lib/query-contracts.js";

type Props = {
  authenticated: boolean;
  showInstall: boolean;
  installGateReason: string;
  onInstall: () => Promise<void>;
  onLogout: () => Promise<void>;
  onDeleteLocalData: (discardUnsynced: boolean) => Promise<LocalDataPurgeResult>;
};

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "auto", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function blockerLabel(summary: LocalDataSummary): string {
  const parts = [
    summary.queued > 0 ? `${summary.queued} queued/in-flight mutation(s)` : null,
    summary.unknownOutcome > 0 ? `${summary.unknownOutcome} unknown outcome(s)` : null,
    summary.reviewRequired > 0 ? `${summary.reviewRequired} conflict(s) needing review` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

export function ShellAccountControls(p: Props): ReactNode {
  const [open, setOpen] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [blocked, setBlocked] = useState<LocalDataSummary | null>(null);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const theme = useThemeStore((s) => s.choice);
  const setTheme = useThemeStore((s) => s.setChoice);
  const meta = useQuery({
    queryKey: queryKeys.meta,
    queryFn: readMeta,
    enabled: open,
    staleTime: 60_000,
  });
  const backup = meta.data?.data.backup;
  const backupAge =
    backup?.ageSeconds === null || backup?.ageSeconds === undefined
      ? null
      : backup.ageSeconds < 3600
        ? `${Math.max(1, Math.floor(backup.ageSeconds / 60))}m`
        : `${Math.floor(backup.ageSeconds / 3600)}h`;

  const deleteLocal = async (discardUnsynced: boolean): Promise<void> => {
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      const result = await p.onDeleteLocalData(discardUnsynced);
      if (result.status === "blocked") {
        setBlocked(result.summary);
      } else if (result.status === "partial") {
        setBlocked(null);
        setPurgeError(result.errors.join(" "));
      } else {
        setBlocked(null);
      }
    } catch (error) {
      setPurgeError(error instanceof Error ? error.message : "Local data cleanup failed.");
    } finally {
      setPurgeBusy(false);
    }
  };

  const discardAndDelete = (): void => {
    if (!blocked) return;
    const confirmed = window.confirm(
      `Discard ${blocked.unsafeCount} unsynced/review-required local item(s) and delete ContextKeep browser data on this device? Server data is not deleted.`,
    );
    if (confirmed) void deleteLocal(true);
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full rounded-md px-2 py-1.5 text-left text-[12px] text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
      >
        Account &amp; app
      </button>
      {open ? (
        <div className="mt-1 grid gap-1 rounded-lg border border-ck-line bg-ck-bg p-1.5 text-[12px]">
          <div className="px-1 py-1">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-medium text-ck-ink">Appearance</span>
              <span className="text-[10px] text-ck-muted">{THEMES.find((item) => item.value === theme)?.label}</span>
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-ck-surface p-1">
              {THEMES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setTheme(item.value)}
                  aria-pressed={theme === item.value}
                  className={`rounded px-2 py-1.5 text-center text-[11px] font-medium ${
                    theme === item.value ? "bg-ck-teal text-on-brand" : "text-ck-muted hover:bg-ck-bg hover:text-ck-ink"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {meta.data?.provenance.source === "cache" ? <p className="px-2 text-xs text-ck-amber">Cached backup metadata ({meta.data.provenance.fetchedAt ?? "fetch time unknown"}).</p> : null}
          {backup ? (
            <div className="rounded px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span>Backup</span>
                <span className={backup.status === "fresh" ? "text-ck-green" : backup.status === "stale" ? "text-ck-amber" : "text-ck-red"}>
                  {backup.status === "missing" ? "missing" : `${backupAge ?? "?"} ago`}
                </span>
              </div>
              {backup.status !== "fresh" ? (
                <p className="mt-0.5 text-[10px] text-ck-muted">
                  {backup.status === "missing"
                    ? "No rotating SQLite backup found."
                    : `Latest rotating backup is older than ${backup.staleAfterHours}h.`}
                </p>
              ) : null}
            </div>
          ) : null}

          {p.showInstall ? (
            <button type="button" onClick={() => void p.onInstall()} className="rounded px-2 py-1.5 text-left hover:bg-ck-surface">
              Install app
            </button>
          ) : null}
          <button type="button" onClick={() => window.location.reload()} className="rounded px-2 py-1.5 text-left hover:bg-ck-surface">
            Reload app
          </button>
          {p.installGateReason && !p.showInstall ? (
            <p className="px-2 py-1 text-[10px] text-ck-muted">{p.installGateReason}</p>
          ) : null}

          <div className="mt-1 border-t border-ck-line px-2 pt-2">
            <p className="text-[11px] font-medium text-ck-ink">Data on this device</p>
            <p className="mt-0.5 text-[10px] leading-relaxed text-ck-muted">
              Sign out keeps offline copies. Delete them separately here; ContextKeep server data is not deleted.
            </p>
            <button
              type="button"
              disabled={purgeBusy}
              onClick={() => void deleteLocal(false)}
              className="mt-1.5 w-full rounded border border-ck-line px-2 py-1.5 text-left text-[11px] text-ck-red disabled:opacity-50"
            >
              {purgeBusy ? "Checking local data…" : "Delete data on this device"}
            </button>
            {blocked ? (
              <div className="mt-2 rounded border border-ck-amber/30 bg-ck-amber/10 p-2 text-[10px] text-ck-amber">
                <p>Deletion blocked: {blockerLabel(blocked)}.</p>
                <p className="mt-1">Resolve/review these items first, or explicitly discard them.</p>
                <button
                  type="button"
                  disabled={purgeBusy}
                  onClick={discardAndDelete}
                  className="mt-1.5 rounded border border-ck-red/40 px-2 py-1 font-semibold text-ck-red disabled:opacity-50"
                >
                  Discard unsynced local items and delete
                </button>
              </div>
            ) : null}
            {purgeError ? <p className="mt-1.5 text-[10px] text-ck-red">{purgeError}</p> : null}
          </div>

          {p.authenticated ? (
            <button
              type="button"
              onClick={() => void p.onLogout()}
              className="rounded px-2 py-1.5 text-left text-ck-red hover:bg-ck-surface"
            >
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
