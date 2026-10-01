import { lazy, Suspense, type ReactNode } from "react";

/** Start loading public route code while Layout checks the session. Importing
 * a page must not fetch private data; its queries run only after it is mounted
 * inside the authenticated (or previously authenticated offline) shell.
 */
export function lazyPage(loader: () => Promise<{ default: () => ReactNode }>) {
  let pending: ReturnType<typeof loader> | undefined;
  const load = () => {
    pending ??= loader().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  const Page = lazy(load);
  return {
    // Do not return/await this promise: auth bootstrap can run in parallel.
    beforeLoad: () => { void load().catch(() => {}); },
    component: function LazyWrapper(): ReactNode {
      return <Suspense fallback={<p className="mt-4 text-sm text-ck-muted">Loading…</p>}><Page /></Suspense>;
    },
  };
}
