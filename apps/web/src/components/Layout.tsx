import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import type { AuthStatusDto } from "@contextkeep/shared";
import { useEffect, useState, type ReactNode } from "react";
import {
  apiFetch,
  isNetworkUnavailableError,
  setPrivateReadsPausedForAuthTransition,
} from "../lib/api.js";
import * as queue from "../lib/offline/queue.js";
import {
  captureInstallPrompt,
  currentInstallGate,
  type BeforeInstallPromptEvent,
} from "../lib/install-gate.js";
import { useUiStore } from "../state/ui.js";
import { AppShell } from "./AppShell.js";
import { CkMark } from "./CkMark.js";
import {
  purgeLocalContextKeepData,
  type LocalDataPurgeResult,
} from "../lib/offline/local-data.js";
import {
  isLocalDataAccessPaused,
  isLocalDataStorageUnavailable,
  setLocalDataAccessPaused,
  subscribeLocalDataAccess,
} from "../lib/offline/local-data-state.js";

export const LAST_AUTHENTICATED_KEY = "ck:auth:last-authenticated";

async function syncQueueState(): Promise<void> {
  const ui = useUiStore.getState();
  ui.setQueuedCount((await queue.listMutations()).length);
  ui.setConflicts(await queue.listConflicts());
}

function remembered(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(LAST_AUTHENTICATED_KEY) === "1";
  } catch {
    // Auth markers are never mirrored to volatile memory. A denied store
    // must not crash the shell or turn an offline session into an auth claim.
    return false;
  }
}

function clearRememberedAuth(): void {
  try { window.localStorage.removeItem(LAST_AUTHENTICATED_KEY); } catch { /* best effort */ }
}

function rememberAuth(): void {
  try { window.localStorage.setItem(LAST_AUTHENTICATED_KEY, "1"); } catch { /* best effort */ }
}

export function Layout(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const offline = useUiStore((s) => s.offline);
  const setNotice = useUiStore((s) => s.setNotice);
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [lastAuth, setLastAuth] = useState(remembered);
  const [localDataPaused, setLocalDataPaused] = useState(
    isLocalDataAccessPaused,
  );
  const [localPurgeErrors, setLocalPurgeErrors] = useState<string[]>([]);
  const [storageUnavailable] = useState(isLocalDataStorageUnavailable);

  const auth = useQuery({
    queryKey: ["auth-status"],
    queryFn: ({ signal }) =>
      apiFetch<AuthStatusDto>("/api/auth/status", { noQueue: true, signal }),
    retry: false,
    enabled: !localDataPaused,
    staleTime: 60_000,
  });
  const authenticated = auth.data?.authenticated === true;
  const login = location.pathname === "/login";

  useEffect(() => {
    const release = captureInstallPrompt((event) => setInstallEvent(event));
    if (!localDataPaused && !storageUnavailable) void syncQueueState().catch(() => {
      setNotice({ kind: "error", text: "Local browser data could not be read. Offline changes were not replayed." });
    });

    const unauthorized = (): void => {
      clearRememberedAuth();
      setLastAuth(false);
      void qc.invalidateQueries({ queryKey: ["auth-status"] });
      void navigate({ to: "/login" });
    };

    window.addEventListener("ck:unauthorized", unauthorized);
    return () => {
      release();
      window.removeEventListener("ck:unauthorized", unauthorized);
    };
  }, []);

  useEffect(() => {
    return subscribeLocalDataAccess((paused) => {
      setLocalDataPaused(paused);
      if (paused) {
        void (async () => {
          await qc.cancelQueries();
          qc.clear();
        })();
      }
    });
  }, [qc]);

  useEffect(() => {
    if (!auth.isSuccess) return;
    if (authenticated) {
      // A failed logout may leave the server-side session valid. If auth
      // subsequently revalidates that session, release the transition fence
      // before the authenticated shell resumes its private reads.
      setPrivateReadsPausedForAuthTransition(false);
      rememberAuth();
      setLastAuth(true);
    } else {
      clearRememberedAuth();
      setLastAuth(false);
    }
  }, [auth.isSuccess, authenticated]);

  useEffect(() => {
    if (auth.isError && lastAuth && isNetworkUnavailableError(auth.error)) {
      useUiStore.getState().setOffline(true);
      return;
    }
    if (
      auth.isSuccess &&
      typeof navigator !== "undefined" &&
      navigator.onLine !== false
    ) {
      useUiStore.getState().setOffline(false);
    }
  }, [auth.isError, auth.error, auth.isSuccess, lastAuth]);

  useEffect(() => {
    if (auth.isSuccess && !authenticated && !login) {
      void navigate({ to: "/login" });
    }
    if (auth.isSuccess && authenticated && login) {
      void navigate({ to: "/" });
    }
  }, [auth.isSuccess, authenticated, login, navigate]);

  const gate =
    typeof window === "undefined"
      ? { allowed: false, reason: "" }
      : currentInstallGate();
  const showInstall = gate.allowed && installEvent !== null;
  const installGateReason = !gate.allowed
    ? gate.reason
    : installEvent === null
      ? "Install from your browser menu (Add to Home screen) if the install button is not offered yet."
      : "";
  const serverUnavailable =
    auth.isError && isNetworkUnavailableError(auth.error);
  const canRender =
    authenticated ||
    (lastAuth && auth.isError && (offline || serverUnavailable));

  const install = async (): Promise<void> => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice;
    setInstallEvent(null);
    setNotice({
      kind: choice.outcome === "accepted" ? "success" : "info",
      text:
        choice.outcome === "accepted"
          ? "ContextKeep installed to your home screen."
          : "Install dismissed.",
    });
  };

  const logout = async (): Promise<void> => {
    setPrivateReadsPausedForAuthTransition(true);
    await qc.cancelQueries();
    try {
      await apiFetch("/api/auth/logout", {
        method: "POST",
        body: {},
        noQueue: true,
      });
    } catch {
      // The local auth marker still needs to be cleared if the server is unreachable.
    }
    await qc.cancelQueries();
    clearRememberedAuth();
    setLastAuth(false);
    qc.setQueryData<AuthStatusDto>(["auth-status"], {
      authenticated: false,
      needsSetup: false,
    });
    void navigate({ to: "/login" });
  };

  const deleteLocalData = async (
    discardUnsynced: boolean,
  ): Promise<LocalDataPurgeResult> => {
    const result = await purgeLocalContextKeepData({
      discardUnsynced,
      onPause: async () => {
        setLocalDataPaused(true);
        await qc.cancelQueries();
        qc.clear();
      },
    });
    if (result.status === "blocked") {
      setLocalDataPaused(false);
      setLocalPurgeErrors([]);
    } else {
      setLocalDataPaused(true);
      setLocalPurgeErrors(result.errors);
    }
    return result;
  };

  const continueAfterLocalPurge = (): void => {
    if (storageUnavailable) {
      // Explicit owner consent permits an online-only view for this document.
      // The durable-store pause remains enforced: never stage or replay writes
      // under an unknown persisted privacy decision, and never reload-loop.
      setLocalDataPaused(false);
      setNotice({ kind: "info", text: "Online-only session: local browser storage is unavailable. Offline changes cannot be saved or replayed." });
      return;
    }
    setLocalDataAccessPaused(false);
    window.location.reload();
  };

  if (localDataPaused) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-ck-bg px-5 text-center text-sm text-ck-muted">
        <CkMark className="h-9 w-9 text-ck-teal" />
        <h1 className="text-base font-semibold text-ck-ink">
          {storageUnavailable
            ? "Browser storage unavailable"
            : localPurgeErrors.length > 0
              ? "Local cleanup was incomplete"
              : "Local ContextKeep data cleared"}
        </h1>
        <p className="max-w-md">
          {storageUnavailable
            ? "The browser refused access to its local privacy setting. Nothing is claimed to be cleared. Continue only to view live server data; local persistence and offline replay remain disabled."
            : localPurgeErrors.length > 0
              ? "ContextKeep stopped local data access because one or more browser stores could not be fully cleared. Server data was not deleted."
              : "Browser copies are cleared and paused. Server data was not deleted. Continue only when you want this device to fetch ContextKeep data again."}
        </p>
        {localPurgeErrors.length > 0 ? (
          <ul className="max-w-md list-disc space-y-1 pl-5 text-left text-xs text-ck-amber">
            {localPurgeErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
        <button
          type="button"
          onClick={continueAfterLocalPurge}
          className="rounded-lg border border-ck-line bg-ck-surface px-3 py-2 text-xs font-semibold text-ck-ink"
        >
          {storageUnavailable ? "Continue online without local storage" : "Continue using ContextKeep"}
        </button>
      </div>
    );
  }

  if (login) {
    return (
      <div className="min-h-dvh bg-ck-bg px-4 py-8 text-ck-ink">
        <div className="mx-auto mb-6 flex max-w-sm items-center justify-center gap-2 text-ck-teal">
          <CkMark className="h-8 w-8" />
          <span className="text-base font-semibold text-ck-ink">
            ContextKeep
          </span>
        </div>
        <Outlet />
      </div>
    );
  }

  if (!canRender) {
    if (auth.isError) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-ck-bg px-5 text-center text-sm text-ck-muted">
          <p>
            {offline || serverUnavailable
              ? "Sign in successfully once while ContextKeep is reachable before using cached ContextKeep offline."
              : "Could not verify the ContextKeep session."}
          </p>
          {!offline && !serverUnavailable ? (
            <button
              type="button"
              className="rounded-lg border border-ck-line px-3 py-2 text-xs text-ck-ink"
              onClick={() => void auth.refetch()}
            >
              Retry
            </button>
          ) : null}
        </div>
      );
    }

    return (
      <div className="flex min-h-dvh items-center justify-center bg-ck-bg text-sm text-ck-muted">
        Loading ContextKeep…
      </div>
    );
  }

  return (
    <AppShell
      authenticated={authenticated}
      showInstall={showInstall}
      installGateReason={installGateReason}
      onInstall={install}
      onLogout={logout}
      onDeleteLocalData={deleteLocalData}
    />
  );
}
