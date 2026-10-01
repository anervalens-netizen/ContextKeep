import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { SearchResultDto } from "@contextkeep/shared";
import { apiFetch, isNetworkUnavailableError } from "../lib/api.js";
import { projectsQueryOptions } from "../lib/provenance-query.js";
import { CallerAbortedError } from "../lib/transport.js";
import { legacyCanonicalSearchKey, readCache, saveToCacheBestEffort, searchKey, SEARCH_LAST_KEY } from "../lib/offline/mirror.js";
import { RecordCard } from "../components/RecordCard.js";
import { VirtualList } from "../components/VirtualList.js";
import { LifecycleBadge } from "../components/Badge.js";
import { debounce } from "../lib/debounce.js";
import { describeCacheAge, describeReadError } from "../lib/presentation.js";
import { isDefaultSearchWindow, isRecordedDate, recordTypes, searchCacheScope, searchFilterError, type SearchFilters } from "../lib/search-filters.js";

type SearchScope = "canonical" | "working" | "all";
type SearchRead = {
  data: SearchResultDto;
  provenance: { source: "network" | "cache" | "legacy-cache"; fetchedAt: string | null };
};

function validScope(value: unknown): SearchScope {
  return value === "working" || value === "all" ? value : "canonical";
}

export default function Search(): ReactNode {
  const routeSearch = useSearch({ from: "/search" });
  const navigate = useNavigate({ from: "/search" });
  const router = useRouter();
  const [q, setQ] = useState(routeSearch.q ?? "");
  const debouncedQ = routeSearch.q ?? "";
  const [observedQ, setObservedQ] = useState(routeSearch.q ?? "");
  const includeHistorical = routeSearch.includeHistorical ?? false;
  const projectId = routeSearch.projectId ?? "";
  const scope = validScope(routeSearch.scope);
  const recordType = routeSearch.recordType ?? "";
  const recordedFrom = routeSearch.recordedFrom ?? "";
  const recordedTo = routeSearch.recordedTo ?? "";
  const filterError = searchFilterError(routeSearch);
  const limit = typeof routeSearch.limit === "number" ? routeSearch.limit : 50;
  const ownCommit = useRef<string | null>(null);
  const ownNavigations = useRef(new Set<string>());
  const navigateSearch = useCallback((search: (previous: SearchFilters) => SearchFilters, replace = false) => {
    const navigationId = crypto.randomUUID();
    const pending = ownNavigations.current;
    pending.add(navigationId);
    void navigate({
      search,
      replace,
      state: (previous) => ({ ...previous, searchNavigationId: navigationId }),
    }).finally(() => pending.delete(navigationId));
  }, [navigate]);

  const urlQ = routeSearch.q ?? "";
  if (observedQ !== urlQ) {
    // Synchronize before committing a render: an effect would briefly start
    // a request combining the previous query with the new URL's filters.
    setObservedQ(urlQ);
    // A delayed acknowledgement of our own URL update must not replace a
    // newer draft. Our filter controls preserve drafts via tagged navigation.
    if (ownCommit.current !== urlQ) {
      setQ(urlQ);
    }
    ownCommit.current = null;
  }

  useEffect(() => {
    const restoreQuery = (query: unknown) => {
      const value = typeof query === "string" ? query : "";
      ownCommit.current = null;
      setQ(value);
    };
    const unsubscribeHistory = router.history.subscribe(({ location, action }) => {
      const restore = action.type === "BACK" || action.type === "FORWARD" || action.type === "GO";
      if (!restore || location.pathname !== "/search") return;
      // History can restore the same committed q while an unsaved draft is
      // pending. Explicit same-URL resets must discard that draft as well.
      const search = router.options.parseSearch!(location.search);
      restoreQuery(search.q);
    });
    const unsubscribeNavigation = router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      if (toLocation.pathname !== "/search") return;
      // Only this mounted page's pending controls/debounce preserve the draft.
      // History entries with old tags and external same-q links still restore it.
      const navigationId = (toLocation.state as { searchNavigationId?: string }).searchNavigationId;
      if (navigationId && ownNavigations.current.delete(navigationId)) return;
      restoreQuery(router.options.parseSearch!(toLocation.searchStr).q);
    });
    return () => { unsubscribeHistory(); unsubscribeNavigation(); };
  }, [router]);

  // Handoff §9: search debounce ≤200ms.
  useEffect(() => {
    if (q.trim() === (routeSearch.q ?? "")) return;
    const d = debounce((value: string) => {
      const query = value.trim();
      ownCommit.current = query;
      navigateSearch((previous) => ({ ...previous, q: query || undefined, limit: undefined }), true);
    }, 200);
    d(q);
    return () => d.cancel();
  }, [q, routeSearch.q, navigateSearch]);

  const projectsQuery = useQuery(projectsQueryOptions());
  const projects = projectsQuery.data?.data ?? [];

  const draftPending = q.trim() !== debouncedQ;
  const searchReady = debouncedQ.length >= 2 && !filterError && !draftPending;
  const searchQuery = useQuery<SearchRead>({
    queryKey: ["search", debouncedQ, includeHistorical, projectId, scope, recordType, recordedFrom, recordedTo, routeSearch.limit ?? 50],
    queryFn: async ({ signal }) => {
      if (filterError) throw new Error(filterError);
      const params = new URLSearchParams({ q: debouncedQ, mode: "discovery", includeHistorical: String(includeHistorical), scope, limit: String(limit) });
      if (projectId) params.set("projectId", projectId);
      if (recordType) params.set("recordType", recordType);
      if (recordedFrom) params.set("recordedFrom", recordedFrom);
      if (recordedTo) params.set("recordedTo", recordedTo);
      const identity = { query: debouncedQ, includeHistorical, projectId: projectId || null, scope, recordType, recordedFrom, recordedTo, limit };
      const cacheScope = searchCacheScope(identity);
      const key = searchKey(identity);
      try {
        let fetchedAt: string | undefined;
        const data = await apiFetch<SearchResultDto>(`/api/search?${params.toString()}`, {
          signal,
          onDataProvenance: (meta) => { fetchedAt = meta.fetchedAt; },
        });
        if (signal.aborted) throw new CallerAbortedError(signal.reason);
        void saveToCacheBestEffort(key, data, { fetchedAt, scope: cacheScope, cursor: null });
        return { data, provenance: { source: "network", fetchedAt: fetchedAt ?? null } };
      } catch (e) {
        if (signal.aborted) throw new CallerAbortedError(signal.reason);
        if (!isNetworkUnavailableError(e)) throw e;
        const cached = await readCache<SearchResultDto>(key, cacheScope);
        if (signal.aborted) throw new CallerAbortedError(signal.reason);
        if (cached) {
          return { data: cached.value, provenance: { source: "cache", fetchedAt: cached.provenance.fetchedAt } };
        }
        if (!isDefaultSearchWindow(identity) || scope !== "canonical") throw e;
        // One release of legacy compatibility: use the pre-A04 single search
        // row only when its embedded query/scope matches exactly. It remains
        // provenance=legacy-cache with unknown original freshness.
        const legacy = await readCache<{ query: string; includeHistorical: boolean; projectId: string | null; data: SearchResultDto }>(SEARCH_LAST_KEY);
        if (signal.aborted) throw new CallerAbortedError(signal.reason);
        if (scope === "canonical") {
          const oldKey = legacyCanonicalSearchKey({ query: debouncedQ, includeHistorical, projectId: projectId || null });
          const oldScope = `search:q=${debouncedQ}:historical=${includeHistorical}:project=${projectId || "*"}`;
          const old = await readCache<SearchResultDto>(oldKey, oldScope);
          if (signal.aborted) throw new CallerAbortedError(signal.reason);
          if (old) return { data: old.value, provenance: { source: "cache", fetchedAt: old.provenance.fetchedAt } };
        }
        if (scope === "canonical" && legacy && legacy.value.query === debouncedQ && legacy.value.includeHistorical === includeHistorical && legacy.value.projectId === (projectId || null)) {
          return { data: legacy.value.data, provenance: { source: "legacy-cache", fetchedAt: null } };
        }
        throw e;
      }
    },
    enabled: searchReady,
    // Only mirror-backed reads run offline; global/auth query policy is unchanged.
    networkMode: "always",
    retry: false,
  });

  // A filter change must not expose an old query's cached or in-flight result
  // while the visible draft is still waiting for its URL commit.
  const read = searchReady ? searchQuery.data : undefined;
  const result = read?.data;
  const fromCache = read ? read.provenance.source !== "network" : false;
  const cachedAt = read?.provenance.fetchedAt ?? null;
  const moreRecords = Boolean(result?.completeness && (
    (scope !== "working" && result.completeness.records.mayHaveMore) ||
    (scope !== "canonical" && result.completeness.workingRecords.mayHaveMore)
  ));

  return (
    <div>
      <h1 className="text-base font-semibold">Search</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder='e.g. "release verification"'
        className="mt-2 w-full rounded-xl border border-ck-line bg-ck-surface px-3 py-2 text-sm outline-none focus:border-ck-teal"
        type="search"
        aria-label="Search memory"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-ck-muted">
          <input
            type="checkbox"
            checked={includeHistorical}
            onChange={(e) => navigateSearch((previous) => ({ ...previous, includeHistorical: e.target.checked || undefined, limit: undefined }))}
            className="h-4 w-4 accent-ck-teal"
          />
          Include historical (superseded)
        </label>
        <select
          aria-label="Filter by project"
          value={projectId}
          onChange={(e) => navigateSearch((previous) => ({ ...previous, projectId: e.target.value || undefined, limit: undefined }))}
          className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1"
        >
          <option value="">All projects</option>
          {projectId && !projects.some((p) => p.id === projectId) ? <option value={projectId}>Unavailable project ({projectId})</option> : null}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-ck-muted">
          <span>Memory scope</span>
          <select value={routeSearch.scope ?? "canonical"} onChange={(e) => navigateSearch((previous) => ({ ...previous, scope: e.target.value === "canonical" ? undefined : e.target.value, limit: undefined }))} className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1" aria-label="Memory scope">
            {routeSearch.scope !== undefined && !["canonical", "working", "all"].includes(routeSearch.scope) ? <option value={routeSearch.scope}>Invalid scope ({routeSearch.scope})</option> : null}
            <option value="canonical">Canonical</option>
            <option value="working">Working proposals</option>
            <option value="all">All (split)</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-ck-muted">
          Record type
          <select value={recordType} onChange={(e) => navigateSearch((previous) => ({ ...previous, recordType: e.target.value || undefined, limit: undefined }))} className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1">
            <option value="">All record types</option>
            {recordType && !recordTypes.some(type => type === recordType) ? <option value={recordType}>Invalid type ({recordType})</option> : null}
            {recordTypes.map(type => <option key={type} value={type}>{type[0]!.toUpperCase() + type.slice(1)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-ck-muted">
          Recorded from (UTC)
          <input type="date" value={isRecordedDate(recordedFrom) ? recordedFrom : ""} aria-describedby="recorded-date-help" onChange={(e) => navigateSearch((previous) => ({ ...previous, recordedFrom: e.target.value || undefined, limit: undefined }))} className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1" />
        </label>
        <label className="flex items-center gap-1.5 text-ck-muted">
          Recorded to (UTC)
          <input type="date" value={isRecordedDate(recordedTo) ? recordedTo : ""} aria-describedby="recorded-date-help" onChange={(e) => navigateSearch((previous) => ({ ...previous, recordedTo: e.target.value || undefined, limit: undefined }))} className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1" />
        </label>
        {result ? <span className="ml-auto text-ck-muted">{result.tookMs} ms</span> : null}
      </div>
      <p id="recorded-date-help" className="mt-2 text-xs text-ck-muted">Inclusive UTC dates when records were recorded, not their effective dates. Type/date filters search records only.</p>
      {filterError ? <div role="alert" className="mt-2 text-xs text-ck-red">
        <p>{filterError}</p>
        <button type="button" className="mt-1 underline" onClick={() => navigateSearch((previous) => ({ ...previous, scope: undefined, recordType: undefined, recordedFrom: undefined, recordedTo: undefined, limit: undefined }))}>Reset invalid filters</button>
      </div> : null}

      {projectsQuery.data?.provenance.source === "cache" ? <p className="mt-2 text-xs text-ck-amber">Cached project list. {describeCacheAge(projectsQuery.data.provenance.fetchedAt)}</p> : null}
      {projectsQuery.isError ? <p className="mt-2 text-xs text-ck-amber">{describeReadError(projectsQuery.error, "Project list")}</p> : null}
      {fromCache ? (
        <p className="mt-2 text-xs text-ck-amber">
          Offline — showing the last cached search{result ? ` for “${result.query}”` : ""}. {describeCacheAge(cachedAt)}
        </p>
      ) : null}
      {searchReady && searchQuery.isError && !(searchQuery.error instanceof CallerAbortedError) ? (
        <p className="mt-2 text-xs text-ck-red">{describeReadError(searchQuery.error, "Search")}</p>
      ) : null}

      {!filterError && (searchQuery.isFetching || (draftPending && q.trim().length >= 2)) ? <p role="status" className="mt-2 text-xs text-ck-muted">Searching…</p> : null}
      <p className="mt-2 text-xs text-ck-muted">Try a distinctive subject, phrase, or artifact identifier.</p>
      {result ? (
        <div className="mt-3 space-y-4">
          {result.completeness ? <p className="text-xs text-ck-muted">Returned {result.records.length} canonical and {result.workingRecords.length} working records. {Object.values(result.completeness).some((part) => part.mayHaveMore) ? "More matches may exist; narrow the query or project." : "No additional matches indicated."} {Object.values(result.completeness).some((part) => part.candidateLimitReached) ? "Candidate limit reached; additional matches may exist" : ""}</p> : <p className="text-xs text-ck-muted">Legacy snapshot: completeness unknown.</p>}
          {moreRecords && limit < 200 ? <button type="button" disabled={searchQuery.isFetching || q.trim() !== debouncedQ} className="rounded-lg border border-ck-line px-3 py-2 text-sm disabled:opacity-50" onClick={() => navigateSearch((previous) => ({ ...previous, limit: Math.min(limit + 50, 200) }))}>Show more results</button> : null}
          {moreRecords && limit >= 200 ? <p role="status" className="text-xs text-ck-amber">Showing up to 200 per record group; refine search to find other matches.</p> : null}
          {result.completeness && !recordType && !recordedFrom && !recordedTo ? <p className="text-xs text-ck-muted">Discovery projects: up to {result.completeness.projects.limit}; sources: up to {result.completeness.sources.limit}. {result.completeness.projects.mayHaveMore || result.completeness.sources.mayHaveMore ? "More discovery matches may exist; refine search." : ""} These are bounded search windows, not exhaustive pagination.</p> : null}
          {result.projects.length > 0 ? (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ck-muted">
                Projects ({result.projects.length})
              </h2>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {result.projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      search={{ recordId: undefined, tab: undefined }}
                      className="flex items-center gap-1.5 rounded-full border border-ck-line bg-ck-surface px-2.5 py-1 text-xs"
                    >
                      {p.name} <LifecycleBadge state={p.lifecycle} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {scope !== "working" ? <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ck-muted">
              Records ({result.records.length})
              {!includeHistorical ? " — accepted only" : " — accepted + superseded"}
            </h2>
            <div className="mt-1">
              <VirtualList
                items={result.records}
                estimateRowHeight={150}
                emptyText="No matching records."
                renderRow={(record) => (
                  <div className="border-b border-ck-line last:border-b-0">
                    <RecordCard record={record} />
                  </div>
                )}
              />
            </div>
          </section> : null}

          {scope !== "canonical" ? <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ck-muted">
              Working proposals ({result.workingRecords.length}) — proposed, not canonical truth
            </h2>
            <div className="mt-1">
              <VirtualList
                items={result.workingRecords}
                estimateRowHeight={150}
                emptyText="No matching working proposals."
                renderRow={(record) => <div className="border-b border-ck-line last:border-b-0"><RecordCard record={record} /></div>}
              />
            </div>
          </section> : null}

          {result.sources.length > 0 ? (
            <section>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ck-muted">
                Sources ({result.sources.length})
              </h2>
              <ul className="mt-1 space-y-1">
                {result.sources.map((s) => (
                  <li key={s.source.id} className="rounded-xl border border-ck-line bg-ck-surface p-2 text-xs">
                    <p className="font-medium">{s.source.title ?? s.source.id}</p>
                    <p className="text-[11px] text-ck-muted">
                      {s.source.kind} · imported {s.source.importedAt.slice(0, 10)}
                      {s.source.authorLabel ? ` · author label: ${s.source.authorLabel}` : ""}
                    </p>
                    {s.matchedExcerpts.length > 0 ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-ck-teal">{s.matchedExcerpts.length} matched excerpt(s)</summary>
                        <ul className="mt-1 space-y-1">
                          {s.matchedExcerpts.map((ex) => (
                            <li key={ex.id} className="rounded-lg bg-ck-bg p-2">
                              “{ex.text}”
                              <span className="block text-[10px] text-ck-muted">
                                offsets {ex.startOffset}–{ex.endOffset}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
