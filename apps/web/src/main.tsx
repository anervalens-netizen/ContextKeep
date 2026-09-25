import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router.js";
import { queryClient } from "./lib/queryClient.js";
import { useUiStore } from "./state/ui.js";
import { useThemeStore } from "./state/theme.js";
import { RETRY_OFFLINE_QUEUE_EVENT } from "./lib/idempotency-key.js";
import { scheduleOfflineRetry, cancelOfflineRetry } from "./lib/offline/scheduler.js";
import * as offlineQueue from "./lib/offline/queue.js";
import "./styles.css";
import "./codex-theme.css";

async function syncAfterReconnect(): Promise<void> {
  const { listConflicts, listMutations, replayQueue } = offlineQueue;
  const result = await replayQueue();
  const ui = useUiStore.getState();
  const remaining = await listMutations();
  ui.setQueuedCount(remaining.length);
  const conflicts = await listConflicts();
  ui.setConflicts(conflicts);

  if (result.stoppedReason === "auth") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued. Sign in again and they will retry in order.`,
    });
  } else if (result.stoppedReason === "forbidden") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued because authorization could not be refreshed. Retry after reloading or signing in again.`,
    });
  } else if (result.stoppedReason === "rate_limit") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued because the server is rate-limiting requests. They were not discarded.`,
    });
    if (typeof result.retryAfterMs === "number") {
      scheduleOfflineRetry(result.retryAfterMs);
    }
  } else if (result.stoppedReason === "idempotency_in_progress") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued. The server is still processing an earlier identical request; retrying automatically.`,
    });
    if (typeof result.retryAfterMs === "number") {
      scheduleOfflineRetry(result.retryAfterMs);
    }
  } else if (result.stoppedReason === "client_in_flight") {
    // F07 in-flight lease (this remediation): another apiFetch() is still
    // actively sending this row. Replay did zero fetches so the queue
    // remains intact and later rows were NOT skipped ahead. Schedule a
    // single same-key retry after a fraction of the remaining lease.
    if (typeof result.retryAfterMs === "number") {
      scheduleOfflineRetry(result.retryAfterMs);
    }
  } else if (result.stoppedReason === "transport_timeout") {
    ui.setNotice({
      kind: "queued",
      text: result.retryBudgetExhausted
        ? `${remaining.length} offline change(s) remain queued after repeated transport timeouts. The server may already have applied the oldest change; its original request identity is preserved and automatic retries are paused.`
        : `${remaining.length} offline change(s) remain queued after a transport timeout. The server may already have applied the oldest change; its original request identity is preserved while reconciliation retries continue.`,
    });
  } else if (result.stoppedReason === "caller_abort") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued after cancellation. The oldest request may already have reached the server, so its original request identity is preserved for reconciliation.`,
    });
  } else if (result.stoppedReason === "response_invalid") {
    ui.setNotice({
      kind: "queued",
      text: `${remaining.length} offline change(s) remain queued because the server response could not be verified. The same request identity was preserved for a safe retry.`,
    });
  } else if (result.stoppedReason === "idempotency_outcome_unknown") {
    // Durable barrier: at least one prior mutation may have already been
    // applied. The owner must dismiss the conflict before any later queued
    // mutation can be replayed. The ConflictOverlay dismissal dispatches
    // ck:retry-offline-queue to resume automatically.
    ui.setNotice({
      kind: "error",
      text: `Offline changes are paused: at least one earlier change has an unconfirmed outcome. Review and dismiss the conflict banner to resume.`,
    });
  } else if (conflicts.length > 0) {
    ui.setNotice({
      kind: "error",
      text: `${conflicts.length} offline change(s) need attention — review the persistent banner.`,
    });
  } else if (result.replayed > 0) {
    ui.setNotice({ kind: "success", text: `Replayed ${result.replayed} offline change(s).` });
    void queryClient.invalidateQueries();
  }
}

function boot(): void {
  // Apply persisted theme (or system default) BEFORE the first paint to
  // avoid a light->dark flash — see docs/decisions/0017.
  useThemeStore.getState().init();

  const ui = useUiStore.getState();
  ui.setOffline(typeof navigator !== "undefined" && navigator.onLine === false);

  // PWA registration is deferred to idle time (dynamic import keeps
  // workbox-window out of the initial JS budget) — autoUpdate + prompt flow.
  const initPwaWhenIdle = async (): Promise<void> => {
    if ("requestIdleCallback" in window) {
      await new Promise<void>((resolve) => window.requestIdleCallback(() => resolve()));
    }
    const { initPwa } = await import("./lib/pwa.js");
    initPwa({
      onUpdateReady: () => useUiStore.getState().setUpdateReady(true),
      onOfflineReady: () =>
        useUiStore.getState().setNotice({ kind: "info", text: "ContextKeep is ready to work offline." }),
    });
  };
  void initPwaWhenIdle();

  // Restore persisted queue/conflict state; replay anything left from a previous offline period.
  void (async () => {
    const { listConflicts, listMutations } = offlineQueue;
    const state = useUiStore.getState();
    const pending = await listMutations();
    state.setQueuedCount(pending.length);
    state.setConflicts(await listConflicts());
    if (navigator.onLine && pending.length > 0) {
      await syncAfterReconnect();
    }
  })();

  window.addEventListener("online", () => {
    useUiStore.getState().setOffline(false);
    void syncAfterReconnect();
  });
  window.addEventListener("offline", () => {
    useUiStore.getState().setOffline(true);
    cancelOfflineRetry();
  });

  // F07 durable barrier release + client_in_flight + 5xx + 429 retry path:
  // when an apiFetch() path or the ConflictOverlay dispatches this event we
  // transparently resume replay if the browser is online. The single retry
  // scheduler (lib/offline/scheduler) is the only place that owns a timer.
  window.addEventListener(RETRY_OFFLINE_QUEUE_EVENT, () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    void syncAfterReconnect();
  });

  const el = document.getElementById("root");
  if (!el) throw new Error("Root element #root not found");
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

boot();
