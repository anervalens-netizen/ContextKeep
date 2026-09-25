import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ProjectDto, SearchResultDto } from "@contextkeep/shared";
import { apiFetch, isNetworkUnavailableError } from "../lib/api.js";
import { legacyCanonicalSearchKey, readCache, saveToCache, searchKey, SEARCH_LAST_KEY } from "../lib/offline/mirror.js";
import { RecordCard } from "../components/RecordCard.js";
import { VirtualList } from "../components/VirtualList.js";
import { LifecycleBadge } from "../components/Badge.js";
import { debounce } from "../lib/debounce.js";
import { describeCacheAge, describeReadError } from "../lib/presentation.js";

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
  const [q, setQ] = useState(routeSearch.q ?? "");
  const [debouncedQ, setDebouncedQ] = useState(routeSearch.q ?? "");
  const includeHistorical = routeSearch.includeHistorical ?? false;
  const projectId = routeSearch.projectId ?? "";
  const scope = validScope(routeSearch.scope);

  useEffect(() => {
    setQ(routeSearch.q ?? "");
  }, [routeSearch.q, routeSearch.includeHistorical, routeSearch.projectId, routeSearch.scope]);

  // Handoff §9: search debounce ≤200ms.
  useEffect(() => {
    const d = debounce((value: string) => {
      setDebouncedQ(value);
      void navigate({
        search: (previous) => ({ ...previous, q: value.trim() || undefined }),
        replace: true,
      });
    }, 200);
    d(q);
    return () => d.cancel();
  }, [q]);

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: () => apiFetch<ProjectDto[]>("/api/projects") });

  const searchQuery = useQuery<SearchRead>({
    queryKey: ["search", debouncedQ, includeHistorical, projectId, scope],
    queryFn: async () => {
      const params = new URLSearchParams({ q: debouncedQ, mode: "discovery", includeHistorical: String(includeHistorical), scope });
      if (projectId) params.set("projectId", projectId);
      const cacheScope = `search:q=${debouncedQ}:historical=${includeHistorical}:project=${projectId || "*"}:scope=${scope}`;
      const key = searchKey({ query: debouncedQ, includeHistorical, projectId: projectId || null, scope });
      try {
        let fetchedAt: string | undefined;
        const data = await apiFetch<SearchResultDto>(`/api/search?${params.toString()}`, {
          onDataProvenance: (meta) => { fetchedAt = meta.fetchedAt; },
        });
        void saveToCache(key, data, { fetchedAt, scope: cacheScope, cursor: null });
        return { data, provenance: { source: "network", fetchedAt: fetchedAt ?? null } };
      } catch (e) {
        if (!isNetworkUnavailableError(e)) throw e;
        const cached = await readCache<SearchResultDto>(key, cacheScope);
        if (cached) {
          return { data: cached.value, provenance: { source: "cache", fetchedAt: cached.provenance.fetchedAt } };
        }
        // One release of legacy compatibility: use the pre-A04 single search
        // row only when its embedded query/scope matches exactly. It remains
        // provenance=legacy-cache with unknown original freshness.
        const legacy = await readCache<{ query: string; includeHistorical: boolean; projectId: string | null; data: SearchResultDto }>(SEARCH_LAST_KEY);
        if (scope === "canonical") {
          const oldKey = legacyCanonicalSearchKey({ query: debouncedQ, includeHistorical, projectId: projectId || null });
          const oldScope = `search:q=${debouncedQ}:historical=${includeHistorical}:project=${projectId || "*"}`;
          const old = await readCache<SearchResultDto>(oldKey, oldScope);
          if (old) return { data: old.value, provenance: { source: "cache", fetchedAt: old.provenance.fetchedAt } };
        }
        if (scope === "canonical" && legacy && legacy.value.query === debouncedQ && legacy.value.includeHistorical === includeHistorical && legacy.value.projectId === (projectId || null)) {
          return { data: legacy.value.data, provenance: { source: "legacy-cache", fetchedAt: null } };
        }
        throw e;
      }
    },
    enabled: debouncedQ.length >= 2,
  });

  const read = searchQuery.data;
  const result = read?.data;
  const fromCache = read ? read.provenance.source !== "network" : false;
  const cachedAt = read?.provenance.fetchedAt ?? null;

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
          onChange={(e) => void navigate({ search: (previous) => ({ ...previous, includeHistorical: e.target.checked || undefined }) })}
            className="h-4 w-4 accent-ck-teal"
          />
          Include historical (superseded)
        </label>
        <select
          aria-label="Filter by project"
          value={projectId}
          onChange={(e) => void navigate({ search: (previous) => ({ ...previous, projectId: e.target.value || undefined }) })}
          className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1"
        >
          <option value="">All projects</option>
          {(projectsQuery.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-ck-muted">
          <span>Memory scope</span>
          <select value={scope} onChange={(e) => void navigate({ search: (previous) => ({ ...previous, scope: e.target.value === "canonical" ? undefined : e.target.value as SearchScope }) })} className="rounded-lg border border-ck-line bg-ck-surface px-2 py-1" aria-label="Memory scope">
            <option value="canonical">Canonical</option>
            <option value="working">Working proposals</option>
            <option value="all">All (split)</option>
          </select>
        </label>
        {result ? <span className="ml-auto text-ck-muted">{result.tookMs} ms</span> : null}
      </div>

      {fromCache ? (
        <p className="mt-2 text-xs text-ck-amber">
          Offline — showing the last cached search{result ? ` for “${result.query}”` : ""}. {describeCacheAge(cachedAt)}
        </p>
      ) : null}
      {searchQuery.isError ? (
        <p className="mt-2 text-xs text-ck-red">{describeReadError(searchQuery.error, "Search")}</p>
      ) : null}

      {searchQuery.isFetching ? <p role="status" className="mt-2 text-xs text-ck-muted">Searching…</p> : null}
      <p className="mt-2 text-xs text-ck-muted">Try a distinctive subject, phrase, or artifact identifier.</p>
      {result ? (
        <div className="mt-3 space-y-4">
          {result.completeness ? <p className="text-xs text-ck-muted">Returned {result.records.length} canonical and {result.workingRecords.length} working records. {Object.values(result.completeness).some((part) => part.mayHaveMore) ? "More matches may exist; narrow the query or project." : "No additional matches indicated."} {Object.values(result.completeness).some((part) => part.candidateLimitReached) ? "Candidate limit reached, including before filtering." : ""}</p> : <p className="text-xs text-ck-muted">Legacy snapshot: completeness unknown.</p>}
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
                      search={{ recordId: undefined }}
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
