import "fake-indexeddb/auto";
import { afterEach } from "vitest";

// jsdom has no matchMedia/layout engine. Model the width query contract used
// by the shell; geometry and native Tab behavior are certified in Chromium.
const queries = new Set<{ update(): void }>();
const originalWidth = window.innerWidth;
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value(media: string): MediaQueryList {
    const minimum = /min-width:\s*(\d+)px/.exec(media);
    const maximum = /max-width:\s*(\d+)px/.exec(media);
    const matches = () =>
      (minimum || maximum) !== null &&
      Boolean(minimum || maximum) &&
      (!minimum || window.innerWidth >= Number(minimum[1])) &&
      (!maximum || window.innerWidth <= Number(maximum[1]));
    let current = matches();
    const target = new EventTarget();
    const query = Object.assign(target, {
      media,
      get matches() {
        return current;
      },
      onchange: null as MediaQueryList["onchange"],
      addListener(listener: EventListener) {
        target.addEventListener("change", listener);
      },
      removeListener(listener: EventListener) {
        target.removeEventListener("change", listener);
      },
    });
    Object.defineProperty(query, "matches", { get: () => current });
    queries.add({
      update() {
        const next = matches();
        if (next === current) return;
        current = next;
        const event = Object.assign(new Event("change"), {
          matches: current,
          media,
        });
        target.dispatchEvent(event);
        query.onchange?.call(
          query as unknown as MediaQueryList,
          event as MediaQueryListEvent,
        );
      },
    });
    return query as unknown as MediaQueryList;
  },
});
window.addEventListener("resize", () => {
  for (const query of queries) query.update();
});
afterEach(() => {
  queries.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: originalWidth,
  });
});
