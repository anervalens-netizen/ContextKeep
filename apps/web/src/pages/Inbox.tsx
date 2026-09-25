import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InboxPageDto, ProjectDto, ReviewResultDto } from "@contextkeep/shared";
import { ApiError, apiFetch, isNetworkUnavailableError } from "../lib/api.js";
import { inboxKey, readCache, saveToCache } from "../lib/offline/mirror.js";
import { cacheScopes, queryKeys, queryRoots } from "../lib/query-contracts.js";
import { RecordCard } from "../components/RecordCard.js";
import { VirtualList } from "../components/VirtualList.js";
import { isQueued, notifyError, reportQueued } from "../lib/hooks.js";

const PAGE_SIZE = 50;

function inboxUrl(projectId: string | undefined, page: number): string {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String((page - 1) * PAGE_SIZE));
  return `/api/inbox?${params.toString()}`;
}

export default function Inbox(): ReactNode {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: "/inbox" });
  const projectId = search.projectId;
  const page = search.page;
  const [selection, setSelection] = useState<Map<string, number>>(new Map());
  const [ownerAction, setOwnerAction] = useState(false);
  const [result, setResult] = useState<ReviewResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const scope = cacheScopes.inbox(projectId ?? null, page, PAGE_SIZE);
  const mirrorKey = inboxKey({ projectId: projectId ?? null, page, limit: PAGE_SIZE });
  const inboxQuery = useQuery({
    queryKey: queryKeys.inbox(projectId ?? null, page, PAGE_SIZE),
    queryFn: async () => {
      try {
        let fetchedAt: string | undefined;
        const data = await apiFetch<InboxPageDto>(inboxUrl(projectId, page), {
          onDataProvenance: (meta) => { fetchedAt = meta.fetchedAt; },
        });
        void saveToCache(mirrorKey, data, { fetchedAt, scope, cursor: null });
        return { data, cachedAt: null as string | null, cached: false };
      } catch (e) {
        if (!isNetworkUnavailableError(e)) throw e;
        const cached = await readCache<InboxPageDto>(mirrorKey, scope);
        if (cached) return { data: cached.value, cachedAt: cached.provenance.fetchedAt, cached: true };
        throw e;
      }
    },
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => apiFetch<ProjectDto[]>("/api/projects"),
  });

  const candidates = inboxQuery.data?.data.candidates ?? [];
  const total = inboxQuery.data?.data.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    setSelection(new Map());
    setEditingId(null);
    setResult(null);
  }, [projectId, page]);

  useEffect(() => {
    if (!inboxQuery.data || page <= pageCount) return;
    void navigate({
      to: "/inbox",
      search: { projectId, page: pageCount },
      replace: true,
    });
  }, [inboxQuery.data, navigate, page, pageCount, projectId]);

  const retiredIds = useMemo(
    () => new Set((projectsQuery.data ?? []).filter((p) => p.lifecycle === "retired").map((p) => p.id)),
    [projectsQuery.data],
  );
  const touchesRetired = candidates.some((c) => c.projectId !== null && retiredIds.has(c.projectId));

  const decide = async (
    items: Array<{ recordId: string; revision: number }>,
    action: "accept" | "reject",
    edits?: Record<string, { revision: number; text: string }>,
  ): Promise<void> => {
    if (items.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = { items, action };
      if (edits) body.edits = edits;
      if (ownerAction) body.ownerAction = true;
      const res = await apiFetch<ReviewResultDto>("/api/inbox/decide", {
        method: "POST",
        body,
        label: `${action} ${items.length} record(s)`,
      });
      setResult(res);
      setSelection(new Map());
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: queryRoots.inbox });
      void queryClient.invalidateQueries({ queryKey: queryRoots.brief });
      void queryClient.invalidateQueries({ queryKey: queryRoots.projects });
    } catch (e) {
      if (isQueued(e)) {
        await reportQueued(e, `Bulk ${action}`);
      } else {
        if (
          e instanceof ApiError &&
          ["stale_revision", "record_not_found", "review_revision_required", "review_revision_conflict", "review_edit_revision_mismatch"].includes(e.code)
        ) {
          // The displayed revision is no longer authoritative. Force a fresh
          // read and discard the old selection; never substitute the new
          // server revision into the owner's prior decision.
          setSelection(new Map());
          setEditingId(null);
          await queryClient.invalidateQueries({ queryKey: queryRoots.inbox });
        }
        notifyError(e, `Bulk ${action} failed.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, revision: number, checked: boolean): void => {
    setSelection((prev) => {
      const next = new Map(prev);
      if (checked) next.set(id, revision);
      else next.delete(id);
      return next;
    });
  };

  const selectedItems = [...selection].map(([recordId, revision]) => ({ recordId, revision }));

  const selectPage = (): void => {
    setSelection(new Map(candidates.map((candidate) => [candidate.id, candidate.revision])));
  };

  const changeProject = (nextProjectId: string): void => {
    setSelection(new Map());
    setEditingId(null);
    void navigate({
      to: "/inbox",
      search: { projectId: nextProjectId || undefined, page: 1 },
      replace: false,
    });
  };

  const goToPage = (nextPage: number): void => {
    setSelection(new Map());
    setEditingId(null);
    void navigate({
      to: "/inbox",
      search: { projectId, page: Math.min(pageCount, Math.max(1, nextPage)) },
      replace: false,
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">Review inbox</h1>
        <span className="text-xs text-ck-muted">{total} proposed</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-ck-line bg-ck-surface p-2">
        <label className="flex items-center gap-2 text-xs text-ck-muted">
          <span>Project</span>
          <select
            aria-label="Project filter"
            value={projectId ?? ""}
            onChange={(event) => changeProject(event.target.value)}
            className="rounded-lg border border-ck-line bg-ck-bg px-2 py-1.5 text-xs text-ck-ink"
          >
            <option value="">All projects</option>
            {(projectsQuery.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Select page"
          disabled={candidates.length === 0 || selectedItems.length === candidates.length}
          onClick={selectPage}
          className="rounded-lg border border-ck-line px-2.5 py-1.5 text-xs font-medium text-ck-ink disabled:opacity-40"
        >
          Select page
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => goToPage(page - 1)}
            className="rounded-lg border border-ck-line px-2.5 py-1.5 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="min-w-24 text-center text-ck-muted">Page {page} of {pageCount}</span>
          <button
            type="button"
            disabled={page >= pageCount}
            onClick={() => goToPage(page + 1)}
            className="rounded-lg border border-ck-line px-2.5 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
      {inboxQuery.data?.cached ? (
        <p className="mt-1 text-xs text-ck-amber">
          Offline/cache — showing the last verified inbox page
          {inboxQuery.data.cachedAt ? ` fetched at ${new Date(inboxQuery.data.cachedAt).toLocaleString()}` : " (original fetch time unavailable for legacy cache)"}.
        </p>
      ) : null}

      {touchesRetired ? (
        <label className="mt-2 flex items-start gap-2 rounded-xl border border-ck-amber/40 bg-ck-amber/10 p-2 text-xs text-ck-amber">
          <input
            type="checkbox"
            checked={ownerAction}
            onChange={(e) => setOwnerAction(e.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            Some candidates target <strong>retired</strong> projects. Accepting them requires an explicit owner action
            (A19). Lifecycle reactivation is never possible here — use Corrections (A3).
          </span>
        </label>
      ) : null}

      {result ? (
        <div className="mt-3 rounded-xl border border-ck-line bg-ck-surface p-3 text-xs">
          <p className="font-semibold text-ck-green">
            Applied: {result.accepted.length} accepted · {result.rejected.length} rejected · {result.edited.length}{" "}
            edited
          </p>
          {result.blocked.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {result.blocked.map((b) => (
                <li key={b.recordId} className="rounded-lg border border-ck-red/30 bg-ck-red/5 p-2 text-ck-red">
                  <span className="font-mono">{b.code}</span>: {b.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {selectedItems.length > 0 ? (
        <div className="sticky top-14 z-20 mt-3 flex items-center gap-2 rounded-xl border border-ck-teal/40 bg-ck-teal-soft p-2">
          <span className="text-xs font-semibold text-ck-teal-dark">{selectedItems.length} selected</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(selectedItems, "accept")}
            className="ml-auto rounded-lg bg-ck-teal px-3 py-1.5 text-xs font-semibold text-on-brand disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(selectedItems, "reject")}
            className="rounded-lg border border-ck-red/50 px-3 py-1.5 text-xs font-semibold text-ck-red disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : null}

      <div className="mt-3">
        {inboxQuery.isLoading ? <p className="text-sm text-ck-muted">Loading inbox…</p> : null}
        {inboxQuery.isError ? (
          <p className="text-sm text-ck-red">Inbox unavailable offline and not cached yet.</p>
        ) : null}
        <VirtualList
          items={candidates}
          estimateRowHeight={170}
          emptyText="Inbox zero — no proposed records. Import material to review it here."
          renderRow={(record) => (
            <div className="border-b border-ck-line last:border-b-0">
              <RecordCard
                record={record}
                selected={selection.has(record.id)}
                onSelect={(checked) => toggle(record.id, record.revision, checked)}
                footer={
                  editingId === record.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={3}
                        className="w-full rounded-xl border border-ck-line bg-ck-bg px-3 py-2 text-xs"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void decide([{ recordId: record.id, revision: record.revision }], "accept", {
                              [record.id]: { revision: record.revision, text: editText },
                            })
                          }
                          className="rounded-lg bg-ck-teal px-3 py-1.5 text-xs font-semibold text-on-brand disabled:opacity-50"
                        >
                          Save &amp; accept
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="rounded-lg border border-ck-line px-3 py-1.5 text-xs text-ck-muted"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide([{ recordId: record.id, revision: record.revision }], "accept")}
                        className="rounded-lg bg-ck-teal px-3 py-1.5 text-xs font-semibold text-on-brand disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(record.id);
                          setEditText(record.text);
                        }}
                        className="rounded-lg border border-ck-line px-3 py-1.5 text-xs font-medium text-ck-ink"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void decide([{ recordId: record.id, revision: record.revision }], "reject")}
                        className="rounded-lg border border-ck-red/50 px-3 py-1.5 text-xs font-semibold text-ck-red disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  )
                }
              />
            </div>
          )}
        />
      </div>
    </div>
  );
}
