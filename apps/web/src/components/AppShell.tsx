import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useUiStore } from "../state/ui.js";
import { ChangelogOverlay } from "./ChangelogOverlay.js";
import { CkMark } from "./CkMark.js";
import { ConflictOverlay } from "./ConflictOverlay.js";
import { Icon } from "./Icon.js";
import { ShellAccountControls } from "./ShellAccountControls.js";
import { ShellBanners } from "./ShellBanners.js";
import { ShellLeftPane } from "./ShellLeftPane.js";
import { NAV_ITEMS, isActiveNav } from "./ShellPrimitives.js";
import { useShellData } from "./useShellData.js";
import { useShellUi } from "./useShellUi.js";
import type { LocalDataPurgeResult } from "../lib/offline/local-data.js";
import { AppErrorBoundary } from "./AppErrorBoundary.js";

export { NAV_ITEMS, isActiveNav } from "./ShellPrimitives.js";

type Props = {
  authenticated: boolean;
  showInstall: boolean;
  installGateReason: string;
  onInstall: () => Promise<void>;
  onLogout: () => Promise<void>;
  onDeleteLocalData: (discardUnsynced: boolean) => Promise<LocalDataPurgeResult>;
};

export function AppShell(p: Props): ReactNode {
  const data = useShellData();
  const ui = useShellUi(data.location.pathname);
  const offline = useUiStore((s) => s.offline);
  const queuedCount = useUiStore((s) => s.queuedCount);

  const left = (compact: boolean, surface: "desktop" | "drawer"): ReactNode => (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ShellLeftPane
          compact={compact}
          surface={surface}
          pathname={data.location.pathname}
          projects={data.projects}
          projectsStatus={data.projectsStatus}
          signals={data.signals}
          activeProjectId={data.activeProjectId}
          offline={offline}
          queuedCount={queuedCount}
          onCollapse={ui.collapseLeft}
          onCloseDrawer={() => ui.setLeftDrawer(false)}
          onOpenChangelog={() => ui.setChangelogOpen(true)}
        />
      </div>
      {!compact ? (
        <div className="shrink-0 border-t border-ck-line bg-ck-surface px-2 pb-2">
          <ShellAccountControls
            authenticated={p.authenticated}
            showInstall={p.showInstall}
            installGateReason={p.installGateReason}
            onInstall={p.onInstall}
            onLogout={p.onLogout}
            onDeleteLocalData={p.onDeleteLocalData}
          />
        </div>
      ) : null}
    </div>
  );


  return (
    <div
      className="h-dvh overflow-hidden bg-ck-bg text-ck-ink lg:grid"
      data-shell="app"
      style={{ gridTemplateColumns: ui.columns }}
    >
      <aside
        className="hidden h-full min-h-0 min-w-0 overflow-hidden border-r border-ck-line lg:block"
        data-pane="navigation"
      >
        {left(ui.leftCollapsed, "desktop")}
      </aside>

      {!ui.leftCollapsed ? (
        <button
          type="button"
          role="separator"
          aria-label="Resize left sidebar"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={360}
          aria-valuenow={ui.leftWidth}
          onPointerDown={ui.resizeLeft}
          onKeyDown={ui.resizeLeftKeyboard}
          className="hidden cursor-col-resize bg-ck-line/40 hover:bg-ck-teal/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ck-teal lg:block"
          style={{ touchAction: "none" }}
        />
      ) : (
        <div className="hidden lg:block" />
      )}

      <div className="flex h-full min-h-0 min-w-0 flex-col bg-ck-bg" data-pane="center">
        <header
          className="flex h-12 shrink-0 items-center gap-2 border-b border-ck-line bg-ck-surface px-3 lg:hidden"
          data-shell="mobile"
        >
          <button
            ref={ui.drawerTriggerRef}
            type="button"
            onClick={() => ui.setLeftDrawer(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ck-muted"
            aria-label="Open navigation"
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>

          <Link to="/" className="flex items-center gap-2 text-ck-teal">
            <CkMark className="h-6 w-6" />
            <span className="text-sm font-semibold text-ck-ink">ContextKeep</span>
          </Link>

          {data.activeProject ? (
            <span className="ml-1 min-w-0 flex-1 truncate text-[10px] text-ck-muted">
              {data.activeProject.name}
            </span>
          ) : (
            <span className="flex-1" />
          )}

          {p.showInstall ? (
            <button
              type="button"
              onClick={() => void p.onInstall()}
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-ck-teal-soft text-ck-teal-dark"
              aria-label="Install ContextKeep"
              title="Install ContextKeep"
            >
              <Icon name="download" className="h-4 w-4" />
            </button>
          ) : null}

        </header>

        <ShellBanners />

        <main
          className="min-h-0 flex-1 overflow-y-auto px-3 py-3 lg:px-4 lg:py-4 xl:px-5"
          data-shell-center="true"
        >
          <div className="mx-auto w-full max-w-6xl">
            <AppErrorBoundary>
              <Outlet />
            </AppErrorBoundary>
          </div>
        </main>
      </div>


      {ui.leftDrawer ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/35 lg:hidden"
          aria-label="Close drawer"
          onClick={() => ui.setLeftDrawer(false)}
        />
      ) : null}

      <aside
        ref={ui.drawerRef}
        inert={!ui.leftDrawer}
        aria-hidden={!ui.leftDrawer}
        role="dialog"
        aria-modal={ui.leftDrawer ? true : undefined}
        aria-label="Navigation"
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-50 min-h-0 w-[86vw] max-w-[320px] transform overflow-hidden border-r border-ck-line bg-ck-surface shadow-xl transition-transform lg:hidden ${
          ui.leftDrawer ? "translate-x-0" : "pointer-events-none -translate-x-full"
        }`}
        data-drawer="navigation"
      >
        {left(false, "drawer")}
      </aside>


      <ConflictOverlay />
      <ChangelogOverlay open={ui.changelogOpen} onClose={() => ui.setChangelogOpen(false)} />
    </div>
  );
}
