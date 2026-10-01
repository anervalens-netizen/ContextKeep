import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout.js";
import { lazyPage } from "./lib/lazy-page.js";
import { validateSearchFilters } from "./lib/search-filters.js";

export function validateProjectSearch(search: Record<string, unknown>): { recordId?: string; tab?: "timeline" | "export" } {
    return {
        recordId: typeof search.recordId === "string" && search.recordId.length > 0 ? search.recordId : undefined,
        tab: search.tab === "timeline" ? "timeline" : search.tab === "export" ? "export" : undefined,
    };
}
const rootRoute = createRootRoute({ component: Layout });
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", ...lazyPage(() => import("./pages/Login.js")) });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", ...lazyPage(() => import("./pages/Projects.js")) });
const projectDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    validateSearch: validateProjectSearch,
    ...lazyPage(() => import("./pages/ProjectDetail.js")),
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
    ...lazyPage(() => import("./pages/Inbox.js")),
});
const importRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/import",
    validateSearch: (search: Record<string, unknown>) => ({
        projectId: typeof search.projectId === "string" && search.projectId.length > 0 ? search.projectId : undefined,
    }),
    ...lazyPage(() => import("./pages/Import.js")),
});
const correctionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/corrections", ...lazyPage(() => import("./pages/Corrections.js")) });
const searchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    validateSearch: validateSearchFilters,
    ...lazyPage(() => import("./pages/Search.js")),
});
const routeTree = rootRoute.addChildren([loginRoute, projectsRoute, projectDetailRoute, inboxRoute, importRoute, correctionsRoute, searchRoute]);
export const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
