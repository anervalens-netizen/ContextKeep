import type { ReactNode } from "react";
import type { EvidenceDto, RecordDto } from "@contextkeep/shared";
import { BasisBadge, StatusBadge, TaskBadge, TypeBadge } from "./Badge.js";

export function EvidenceList({ evidence }: { evidence: EvidenceDto[] }): ReactNode {
  if (evidence.length === 0) {
    return <p className="text-xs text-ck-muted">No evidence excerpt linked.</p>;
  }
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-ck-teal">
        {evidence.length} evidence excerpt{evidence.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1">
        {evidence.map((ev) => (
          <li key={ev.excerptId} className="rounded-lg border border-ck-line bg-ck-bg p-2">
            <blockquote className="whitespace-pre-wrap break-words text-ck-ink">“{ev.text}”</blockquote>
            <p className="mt-1 text-ck-muted">
              {ev.sourceTitle ?? "untitled source"} · offsets {ev.startOffset}–{ev.endOffset} · {ev.relation}
              {ev.observedAt ? ` · observed ${ev.observedAt.slice(0, 10)}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function RecordCard({
  record,
  footer,
  selected,
  onSelect,
}: {
  record: RecordDto;
  footer?: ReactNode;
  selected?: boolean;
  onSelect?: (checked: boolean) => void;
}): ReactNode {
  const freshnessCurrentness = record.freshness?.currentness;
  const freshnessLabel =
    freshnessCurrentness === "conflicted" ? "Conflict · review"
    : freshnessCurrentness === "needs_verification" ? "Needs verification"
    : freshnessCurrentness === "future_effective" ? "Future effective"
    : freshnessCurrentness === "expired" ? "Expired"
    : freshnessCurrentness === "unknown" && record.freshness?.reasons.includes("observation_time_unknown")
      ? "Freshness unknown"
      : null;

  return (
    <div className={`p-3 ${selected === undefined ? "" : selected ? "bg-ck-teal-soft/60" : "bg-ck-surface"}`}>
      <div className="flex items-start gap-2">
        {onSelect && (
          <input
            type="checkbox"
            checked={selected ?? false}
            onChange={(e) => onSelect(e.target.checked)}
            className="mt-1 h-4 w-4 accent-ck-teal"
            aria-label={`Select record ${record.id}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <TypeBadge type={record.type} />
            <StatusBadge status={record.reviewStatus} />
            <BasisBadge basis={record.evidenceBasis} />
            {record.taskStatus ? <TaskBadge status={record.taskStatus} /> : null}
            {record.volatile ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  record.isOverdue
                    ? "border-ck-amber/40 bg-ck-amber/15 text-ck-amber"
                    : "border-ck-line bg-ck-bg text-ck-muted"
                }`}
                title={
                  record.isOverdue
                    ? `Volatile fact — review overdue (was due ${record.reviewDueAt?.slice(0, 10) ?? "unknown"})`
                    : `Volatile fact — next review on ${record.reviewDueAt?.slice(0, 10) ?? "unknown"}`
                }
                data-testid="volatile-review-badge"
              >
                {record.isOverdue ? "Review overdue" : "Volatile · review due"}
              </span>
            ) : null}
            {freshnessLabel ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  freshnessCurrentness === "conflicted"
                    ? "border-ck-red/40 bg-ck-red/5 text-ck-red"
                    : freshnessCurrentness === "needs_verification"
                      ? "border-ck-amber/40 bg-ck-amber/10 text-ck-amber"
                      : "border-ck-line bg-ck-bg text-ck-muted"
                }`}
                title={record.freshness?.reasons.join(", ") || freshnessLabel}
                data-testid="record-freshness-badge"
              >
                {freshnessLabel}
              </span>
            ) : null}
            {record.projectName ? (
              <span className="text-[11px] text-ck-muted">@ {record.projectName}</span>
            ) : null}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-ck-ink">{record.text}</p>
          <p className="mt-1 text-[11px] text-ck-muted">
            {record.subject}
            {record.predicate ? ` / ${record.predicate}` : ""} · recorded {record.recordedAt.slice(0, 10)}
            {record.sourceEventAt ? ` · event ${record.sourceEventAt.slice(0, 10)}` : ""}
            {record.reviewedAt ? ` · reviewed ${record.reviewedAt.slice(0, 10)}` : ""}
          </p>
          {record.projectId && (record.freshness?.requiresReview || record.freshness?.supportRecordIds.length) ? <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {record.freshness.requiresReview ? <a className="text-ck-teal underline" href={`/projects/${encodeURIComponent(record.projectId)}?recordId=${encodeURIComponent(record.id)}`}>Review record</a> : null}
            {record.freshness.supportRecordIds.map((id, index) => <a key={id} className="text-ck-teal underline" href={`/projects/${encodeURIComponent(record.projectId!)}?recordId=${encodeURIComponent(id)}`}>Inspect supporting record {index + 1}</a>)}
          </div> : null}
          <div className="mt-1.5">
            <EvidenceList evidence={record.evidence} />
          </div>
          {footer ? <div className="mt-2">{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}
