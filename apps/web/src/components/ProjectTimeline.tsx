import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimelineDto } from "@contextkeep/shared";
import { apiFetch } from "../lib/api.js";
import { describeReadError } from "../lib/presentation.js";
import { RecordCard } from "./RecordCard.js";
import { VirtualList } from "./VirtualList.js";

const PAGE_SIZE = 50;

/** Bounded project timeline with project-scoped navigation state. */
export function ProjectTimeline({
  projectId,
}: {
  projectId: string;
}): ReactNode {
  return <TimelinePages key={projectId} projectId={projectId} />;
}

function TimelinePages({ projectId }: { projectId: string }): ReactNode {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);
  const timelineQuery = useQuery({
    queryKey: ["timeline", projectId, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      return apiFetch<TimelineDto>(
        `/api/projects/${encodeURIComponent(projectId)}/timeline?${params.toString()}`,
      );
    },
    enabled: Boolean(projectId),
  });

  if (timelineQuery.isLoading) {
    return (
      <p className="rounded-2xl border border-ck-line bg-ck-surface p-4 text-sm text-ck-muted">
        Loading timeline…
      </p>
    );
  }
  if (timelineQuery.isError) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-ck-red/30 bg-ck-red/5 p-4 text-sm text-ck-red"
      >
        <p>{describeReadError(timelineQuery.error, "Timeline")}</p>
        <button
          type="button"
          className="mt-3 min-h-9 rounded-lg border border-ck-line px-3 text-sm"
          onClick={() => {
            // An expired page cursor must not trap the owner in an error state.
            queryClient.removeQueries({
              queryKey: ["timeline", projectId],
              type: "inactive",
            });
            setHistory([]);
            setCursor(null);
            if (cursor === null) void timelineQuery.refetch();
          }}
        >
          Restart timeline
        </button>
      </div>
    );
  }

  const timeline = timelineQuery.data!;
  const pagination = timeline.pagination;
  const previousCursor = history.at(-1) ?? null;
  const canGoPrevious = history.length > 0;
  const canGoNext =
    pagination?.hasNext === true && pagination.nextCursor !== null;

  return (
    <section className="overflow-hidden rounded-3xl border border-ck-line bg-ck-surface shadow-sm">
      <div className="border-b border-ck-line px-4 py-3">
        <h1 className="text-sm font-semibold">Project timeline</h1>
        <p className="mt-0.5 text-xs text-ck-muted">
          Accepted and superseded knowledge in chronological context.
        </p>
        {pagination ? (
          <p className="mt-2 text-[11px] text-ck-muted">
            Showing {pagination.returned} of {pagination.total} records · page
            size {pagination.limit}
          </p>
        ) : null}
      </div>
      <VirtualList
        items={timeline.entries}
        estimateRowHeight={150}
        emptyText="No accepted or superseded records yet."
        renderRow={(entry) => (
          <div className="border-b border-ck-line last:border-b-0">
            <RecordCard
              record={entry.record}
              footer={
                entry.supersededBy ? (
                  <p className="text-[11px] text-ck-amber">
                    Superseded
                    {entry.supersededBy.confirmedAt
                      ? ` ${entry.supersededBy.confirmedAt.slice(0, 10)}`
                      : ""}
                    : {entry.supersededBy.reason}
                  </p>
                ) : entry.supersedes.length > 0 ? (
                  <p className="text-[11px] text-ck-green">
                    Supersedes {entry.supersedes.length} earlier record(s).
                  </p>
                ) : null
              }
            />
          </div>
        )}
      />
      {pagination ? (
        <div className="flex items-center justify-between gap-2 border-t border-ck-line px-4 py-3">
          <button
            type="button"
            className="min-h-9 rounded-lg border border-ck-line px-3 text-xs font-semibold text-ck-muted disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoPrevious || timelineQuery.isFetching}
            onClick={() => {
              setCursor(previousCursor);
              setHistory(history.slice(0, -1));
            }}
          >
            Previous
          </button>
          <span className="text-[11px] text-ck-muted">
            {timelineQuery.isFetching ? "Loading…" : "Chronological order"}
          </span>
          <button
            type="button"
            className="min-h-9 rounded-lg bg-ck-teal px-3 text-xs font-semibold text-on-brand disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canGoNext || timelineQuery.isFetching}
            onClick={() => {
              if (!pagination?.nextCursor) return;
              setHistory([...history, cursor]);
              setCursor(pagination.nextCursor);
            }}
          >
            More
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default ProjectTimeline;
