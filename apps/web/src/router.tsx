import { lazy, Suspense, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout.js";
function lazyPage(loader: () => Promise<{
    default: () => ReactNode;
}>): () => ReactNode {
    const Page = lazy(loader);
    return function LazyWrapper(): ReactNode {
        return <Suspense fallback={<p className="mt-4 text-sm text-ck-muted">Loading…</p>}><Page /></Suspense>;
    };
}
const rootRoute = createRootRoute({ component: Layout });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: lazyPage(() => import("./pages/Login.js")) });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: lazyPage(() => import("./pages/Projects.js")) });
const projectDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    validateSearch: (search: Record<string, unknown>) => ({
        recordId: typeof search.recordId === "string" && search.recordId.length > 0 ? search.recordId : undefined,
    }),
    component: lazyPage(() => import("./pages/ProjectDetail.js")),
});
const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    validateSearch: (search: Record<string, unknown>) => ({
        projectId: typeof search.projectId === "string" && search.projectId.length > 0 ? search.projectId : undefined,
        page: typeof search.page === "number" && Number.isInteger(search.page) && search.page > 0
            ? search.page
            : typeof search.page === "string" && /^\d+$/.test(search.page) && Number(search.page) > 0
                ? Number(search.page)
                : 1,
    }),
    component: lazyPage(() => import("./pages/Inbox.js")),
});
const importRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/import",
    validateSearch: (search: Record<string, unknown>) => ({
        projectId: typeof search.projectId === "string" && search.projectId.length > 0 ? search.projectId : undefined,
    }),
    component: lazyPage(() => import("./pages/Import.js")),
});
const correctionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/corrections", component: lazyPage(() => import("./pages/Corrections.js")) });
const searchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    validateSearch: (search: Record<string, unknown>) => ({
        q: typeof search.q === "string" ? search.q : undefined,
        includeHistorical: search.includeHistorical === true || search.includeHistorical === "true" ? true : undefined,
        projectId: typeof search.projectId === "string" && search.projectId.length > 0 ? search.projectId : undefined,
        scope: search.scope === "working" || search.scope === "all" ? search.scope : undefined,
    }),
    component: lazyPage(() => import("./pages/Search.js")),
});
const routeTree = rootRoute.addChildren([loginRoute, projectsRoute, projectDetailRoute, inboxRoute, importRoute, correctionsRoute, searchRoute]);
export const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
