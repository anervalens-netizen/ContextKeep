import { registerSW } from "virtual:pwa-register";
import { purgeLegacyContextKeepApiCaches } from "./offline/sw-data-cache.js";

/**
 * PWA registration (handoff §9): vite-plugin-pwa registerType autoUpdate.
 * On top of silent auto-updates, a controllerchange listener surfaces the
 * owner-facing "new version installed — reload" prompt with the changelog
 * (prompt-for-update flow), and the in-app menu always offers a manual Reload.
 */
export interface PwaHooks {
  onUpdateReady: () => void;
  onOfflineReady: () => void;
}

export function initPwa(hooks: PwaHooks): (reloadPage?: boolean) => Promise<void> {
  // The new data model uses IndexedDB as the only offline mirror. Deleting
  // these exact legacy cache names is safe even before controllerchange:
  // unsynchronized mutations/conflicts live in a different IndexedDB store.
  void purgeLegacyContextKeepApiCaches().catch(() => {
    /* best effort; missing CacheStorage must never block app startup */
  });

  let controllerListenerAttached = false;
  const updateSW = registerSW({
    immediate: true,
    onOfflineReady() {
      hooks.onOfflineReady();
    },
    onRegisteredSW(_swUrl, registration) {
      if (controllerListenerAttached || !registration) return;
      controllerListenerAttached = true;
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          hooks.onUpdateReady();
        },
        { once: true },
      );
    },
  });
  return updateSW;
}
