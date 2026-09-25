import { useEffect, useState, type ReactNode } from "react";
import { projectResumeContext, renderResumeText, type RecordDto } from "@contextkeep/shared";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api.js";
import { readMeta, readWorkContext, type MetaStatus } from "../lib/provenance-query.js";
import { Icon } from "./Icon.js";
import { describeReadError, formatLocalDateTime } from "../lib/presentation.js";
import { queryKeys } from "../lib/query-contracts.js";

type BackupStatus = NonNullable<MetaStatus["backup"]>;

function verificationLabel(backup: BackupStatus | undefined): { label: string; className: string } {
  if (!backup) return { label: "unknown", className: "text-ck-muted" };
  if (backup.verificationStatus === "changed_or_invalid") return { label: "invalid", className: "text-ck-red" };
  if (backup.verificationStatus === "verified") return { label: "verified", className: "text-ck-green" };
  return { label: "not verified", className: "text-ck-amber" };
}

export function ProjectMemoryDashboard({ projectId }: { projectId: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [copyFallbackText, setCopyFallbackText] = useState("");
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null);
  useEffect(() => {
    setCopyError(false);
    setCopyFallbackText("");
    setCopied(false);
    setCopiedArtifact(null);
  }, [projectId]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);

  const work = useQuery({
    queryKey: queryKeys.workContext(projectId),
    queryFn: () => readWorkContext(projectId),
    staleTime: 5_000,
    retry: false,
  });

  const meta = useQuery({
    queryKey: queryKeys.meta,
    queryFn: readMeta,
    staleTime: 60_000,
    retry: false,
  });

  // Keep this hook unconditional: the dashboard has loading/error returns,
  // but artifact access must not change hook order between those renders.
  const loadedContext = work.data?.data;
  const artifactQuery = useQuery({
    queryKey: ["checkpoint-artifacts", loadedContext?.latestCheckpoint?.recordId],
    queryFn: () => apiFetch<RecordDto>(`/api/records/${loadedContext!.latestCheckpoint!.recordId}`, { noQueue: true }),
    enabled: artifactsOpen && Boolean(loadedContext?.latestCheckpoint?.recordId),
    retry: false,
  });
  const cachedAt = work.data?.provenance.source === "cache" ? work.data.provenance.fetchedAt ?? "legacy" : null;
  const resume = projectResumeContext({
    ...(loadedContext ?? { project: { id: projectId, name: "ContextKeep" } }),
    cached: Boolean(cachedAt),
    cachedAt: cachedAt === "legacy" ? null : cachedAt,
  });
  const resumeText = renderResumeText(resume);

  if (work.isLoading) {
    return <section className="h-40 animate-pulse rounded-3xl border border-ck-line bg-ck-surface" aria-label="Loading memory status" />;
  }
  if (work.isError || !work.data) {
    return (
      <section className="rounded-3xl border border-ck-amber/30 bg-ck-surface p-4">
        <h2 className="text-sm font-semibold text-ck-ink">Memory status unavailable</h2>
        <p className="mt-1 text-xs text-ck-muted">{describeReadError(work.error, "Project memory")}</p>
      </section>
    );
  }

  const context = work.data.data;
  const checkpoint = context.latestCheckpoint?.checkpoint;
  const artifactRefCount = checkpoint && typeof checkpoint.artifactRefCount === "number"
    ? checkpoint.artifactRefCount
    : checkpoint?.artifactRefs?.length ?? null;
  const pending = context.workingMemory.total;
  const backup = meta.data?.data.backup;
  const backupVerification = verificationLabel(backup);
  const backupHealthy = backup?.status === "fresh" && backup.verificationStatus === "verified";
  const decisions = context.goals?.items ?? [];
  const constraints = context.constraints?.items ?? [];
  const blockerState = context.blockerState ?? { activeCount: 0, resolvedCount: 0, active: [] };
  const attention = [
    blockerState.activeCount > 0 ? `${blockerState.activeCount} active blocker(s)` : null,
    context.indicators.stale ? "canonical memory needs freshness review" : null,
    context.indicators.truncated ? "context response was budget-truncated" : null,
    context.indicators.unknown.length > 0 ? `${context.indicators.unknown.length} unknown indicator(s)` : null,
  ].filter((item): item is string => item !== null);

  const copyText = async (text: string): Promise<void> => {
    const isResume = text === resumeText;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(text);
      setCopyError(false);
      setCopied(isResume);
      setCopiedArtifact(isResume ? null : text);
      window.setTimeout(() => { setCopied(false); setCopiedArtifact(null); }, 1600);
    } catch {
      setCopied(false);
      setCopiedArtifact(null);
      setCopyFallbackText(text);
      setCopyError(true);
    }
  };

  const inlineArtifactRefs = Array.isArray(checkpoint?.artifactRefs)
    ? checkpoint.artifactRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : null;
  const artifactRefs = (() => {
    if (inlineArtifactRefs) return inlineArtifactRefs;
    const value = artifactQuery.data?.valueJson;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as { kind?: unknown; artifactRefs?: unknown };
    if (candidate.kind !== "working_checkpoint" || !Array.isArray(candidate.artifactRefs)) return null;
    const refs = candidate.artifactRefs.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return artifactRefCount === null || refs.length === artifactRefCount ? refs : null;
  })();
  const artifactsReady = inlineArtifactRefs !== null || artifactsOpen;

  return (
    <section className="rounded-3xl border border-ck-line bg-ck-surface p-4 shadow-sm sm:p-5" data-testid="memory-dashboard">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon name="database" className="h-4 w-4 text-ck-teal" />
            <h2 className="text-sm font-semibold text-ck-ink">Memory status</h2>
          </div>
          <p className="mt-1 text-xs text-ck-muted">Canonical truth and proposal-only agent working memory stay separate.</p>
        </div>
        <button type="button" onClick={() => void copyText(resumeText)} className="min-h-9 rounded-lg border border-ck-line px-3 py-2 text-xs font-semibold text-ck-teal">
          {copied ? "Copied" : "Copy context"}
        </button>
      </div>
      {copyError ? <div className="mt-2" role="status">
        <p className="text-xs text-ck-amber">Clipboard unavailable. Select the text below and copy it manually.</p>
        <textarea readOnly aria-label={copyFallbackText === resumeText ? "Selectable resume text" : "Selectable artifact reference"} value={copyFallbackText} className="mt-2 h-32 w-full rounded-xl border border-ck-amber/40 bg-ck-bg p-2 text-xs text-ck-ink" />
      </div> : null}

      {cachedAt ? (
        <p className="mt-3 rounded-xl border border-ck-amber/30 bg-ck-amber/10 px-3 py-2 text-[11px] text-ck-amber">
          Offline/cached snapshot{cachedAt === "legacy" ? " (original fetch time unavailable for legacy cache)" : ` fetched at ${formatLocalDateTime(cachedAt)}`}. This is not live freshness.
        </p>
      ) : null}

      <div className="mt-4 rounded-2xl border border-ck-teal/30 bg-ck-teal-soft/40 p-3" data-testid="resume-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-ck-ink">Resume from checkpoint</h3>
          {context.latestCheckpoint?.recordedAt ? (
            <span className="text-[10px] text-ck-muted">{formatLocalDateTime(context.latestCheckpoint.recordedAt)}</span>
          ) : null}
        </div>
        {context.latestCheckpoint ? (checkpoint ? (
          <>
            <p className="mt-2 text-sm font-semibold text-ck-ink">{checkpoint.summary ?? checkpoint.outcome ?? "Checkpoint"}</p>
            {checkpoint.outcome && checkpoint.outcome !== checkpoint.summary ? (
              <p className="mt-1 text-[11px] text-ck-muted">{checkpoint.outcome}</p>
            ) : null}
            {checkpoint.nextAction ? (
              <p className="mt-2 rounded-xl border border-ck-teal/20 bg-ck-bg px-3 py-2 text-xs text-ck-ink">
                <span className="font-semibold">Next action:</span> {checkpoint.nextAction}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-ck-muted">No next action recorded.</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
              <span className="rounded border border-ck-line px-1.5 py-0.5 font-semibold uppercase text-ck-muted">
                {context.latestCheckpoint.status ?? "proposed"}
              </span>
              <span className="rounded border border-ck-line px-1.5 py-0.5 font-semibold uppercase text-ck-muted">
                {context.latestCheckpoint.provenance ?? "unknown provenance"}
              </span>
              <Link
                to="/projects/$projectId"
                params={{ projectId }}
                search={{ recordId: context.latestCheckpoint.recordId }}
                className="font-semibold text-ck-teal"
              >
                Open checkpoint record &amp; evidence
              </Link>
            </div>
            {artifactRefCount === null || artifactRefCount > 0 ? (
              <div className="mt-2">
                <button type="button" aria-expanded={artifactsOpen} onClick={() => setArtifactsOpen((open) => !open)} className="min-h-9 rounded border border-ck-line px-3 py-2 text-xs font-semibold text-ck-teal">
                  {artifactsOpen ? "Hide" : "Load"} {artifactRefCount === null ? "checkpoint details" : `${artifactRefCount} checkpoint artifact${artifactRefCount === 1 ? "" : "s"}`}
                </button>
                {artifactsOpen && artifactQuery.isLoading ? <p className="mt-1 text-[10px] text-ck-muted">Loading checkpoint record…</p> : null}
                {artifactsOpen && artifactQuery.isError ? <p className="mt-1 text-[10px] text-ck-red">Checkpoint artifacts unavailable: {describeReadError(artifactQuery.error, "Checkpoint record")}</p> : null}
                {artifactsOpen && artifactQuery.data && !artifactRefs ? <p className="mt-1 text-[10px] text-ck-amber">The checkpoint shape was invalid or changed; no artifact list was shown.</p> : null}
                {artifactsReady && artifactRefs ? <ul className="mt-1 space-y-1">
                  {artifactRefs.map((ref) => (
                  <li key={ref} className="flex min-w-0 items-center gap-2 text-[10px] text-ck-muted">
                    <code className="min-w-0 flex-1 truncate rounded bg-ck-bg px-2 py-1">{ref}</code>
                    <button
                      type="button"
                      aria-label={`Copy artifact reference ${ref}`}
                      onClick={() => void copyText(ref)}
                      className="min-h-9 rounded border border-ck-line px-3 py-2 text-xs font-semibold text-ck-teal"
                    >
                      {copiedArtifact === ref ? "Copied" : "Copy"}
                    </button>
                  </li>
                ))}
                </ul> : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-xs text-ck-amber">Checkpoint details were omitted for this budget. The pointer and recovery link remain available; load the record to continue.</p>
        )) : (
          <p className="mt-2 text-xs text-ck-muted">No working checkpoint captured yet.</p>
        )}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-ck-line bg-ck-bg p-3">
          <h3 className="text-xs font-semibold text-ck-ink">Canonical decisions</h3>
          {decisions.length ? (
            <ul className="mt-2 space-y-2">
              {decisions.slice(0, 3).map((item) => (
                <li key={item.recordId} className="text-[11px] text-ck-ink">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId }}
                    search={{ recordId: item.recordId }}
                    className="font-medium hover:text-ck-teal"
                  >
                    {item.text || item.subject || `Open record ${item.recordId}`}
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[11px] text-ck-muted">No accepted decisions in the current context.</p>}
        </div>
        <div className="rounded-2xl border border-ck-line bg-ck-bg p-3">
          <h3 className="text-xs font-semibold text-ck-ink">Canonical constraints</h3>
          {constraints.length ? (
            <ul className="mt-2 space-y-2">
              {constraints.slice(0, 3).map((item) => (
                <li key={item.recordId} className="text-[11px] text-ck-ink">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId }}
                    search={{ recordId: item.recordId }}
                    className="font-medium hover:text-ck-teal"
                  >
                    {item.text || item.subject || `Open record ${item.recordId}`}
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-[11px] text-ck-muted">No accepted constraints in the current context.</p>}
        </div>
      </div>

      {attention.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-ck-amber/30 bg-ck-amber/5 p-3">
          <h3 className="text-xs font-semibold text-ck-ink">Needs attention</h3>
          <ul className="mt-1.5 space-y-1 text-[11px] text-ck-muted">
            {attention.map((item) => <li key={item}>• {item}</li>)}
            {blockerState.active.slice(0, 3).map((item) => <li key={item.blockerId}><Link to="/projects/$projectId" params={{ projectId }} search={{ recordId: typeof item.checkpointRecordId === "string" ? item.checkpointRecordId : context.latestCheckpoint?.recordId }} className="text-ck-teal underline">Blocker: {item.text}</Link></li>)}
            {[...(context.facts?.items ?? []), ...(context.currentState?.items ?? [])].filter((item, index, all) => item.stale && all.findIndex((other) => other.recordId === item.recordId) === index).slice(0, 5).map((item) => <li key={item.recordId}><Link to="/projects/$projectId" params={{ projectId }} search={{ recordId: item.recordId }} className="text-ck-teal underline">Review stale record: {item.text || item.subject || item.recordId}</Link></li>)}
            <li><Link to="/search" search={{ projectId, q: undefined, scope: "all", includeHistorical: undefined }} className="text-ck-teal underline">Inspect supporting evidence</Link></li>
          </ul>
        </div>
      ) : null}

      <details className="mt-3 rounded-2xl border border-ck-line bg-ck-bg p-3 text-[11px]">
        <summary className="cursor-pointer font-semibold text-ck-muted">Technical details</summary>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
          <dt className="text-ck-muted">Canonical cursor</dt><dd className="text-ck-ink">Canonical cursor {context.freshness.canonicalCursor}</dd>
          <dt className="text-ck-muted">Working cursor</dt><dd className="text-ck-ink">Working cursor {context.freshness.workingCursor}</dd>
          <dt className="text-ck-muted">Schema</dt><dd className="text-ck-ink">Schema {meta.data?.data.schemaVersion ?? "unknown"}</dd>
          <dt className="text-ck-muted">Build</dt><dd className="font-mono text-ck-ink">{meta.data?.data.buildSha ? meta.data.data.buildSha.slice(0, 8) : "unknown"}</dd>
          <dt className="text-ck-muted">Unreviewed</dt><dd className="text-ck-ink">{pending}</dd>
          <dt className="text-ck-muted">Blockers</dt><dd className="text-ck-ink">{blockerState.activeCount}</dd>
          <dt className="text-ck-muted">Metadata source</dt><dd>{meta.data?.provenance.source ?? "unavailable"}{meta.data?.provenance.source === "cache" ? ` (${meta.data.provenance.fetchedAt ?? "fetch time unknown"})` : ""}</dd>
          <dt className="text-ck-muted">Backup status</dt><dd className="text-ck-ink">{backup?.status ?? "unavailable"}</dd>
          <dt className="text-ck-muted">Integrity</dt><dd className={backupVerification.className}>{backupVerification.label}</dd>
          <dt className="text-ck-muted">Restore test</dt><dd className={backup?.latestBackupRestoreTestedAt ? "text-ck-green" : "text-ck-amber"}>{backup?.latestBackupRestoreTestedAt ? "tested" : "not tested on latest"}</dd>
        </dl>
        {!backupHealthy && backup ? <p className="mt-2 text-[10px] text-ck-amber">Backup freshness alone is not treated as healthy unless integrity is verified.</p> : null}
      </details>

      {context.workingMemory.items.length > 0 ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-ck-ink">Recent unreviewed captures</h3>
            <Link to="/inbox" search={{ projectId, page: 1 }} className="text-[11px] font-semibold text-ck-teal">Review inbox</Link>
          </div>
          <ul className="mt-2 space-y-2">
            {context.workingMemory.items.slice(0, 3).map((item) => (
              <li key={item.recordId} className="rounded-xl border border-ck-line bg-ck-bg px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="rounded border border-ck-line px-1.5 py-0.5 font-semibold uppercase text-ck-muted">proposed</span>
                  <span className="rounded border border-ck-line px-1.5 py-0.5 font-semibold uppercase text-ck-muted">agent report</span>
                  <span className="ml-auto text-ck-muted">{formatLocalDateTime(item.recordedAt)}</span>
                </div>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId }}
                  search={{ recordId: item.recordId }}
                  className="mt-1 block line-clamp-2 text-xs text-ck-ink hover:text-ck-teal"
                >
                  {item.text || item.subject || `Open record ${item.recordId}`}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-ck-line pt-3 text-[11px]">
        <Link to="/inbox" search={{ projectId, page: 1 }} className="font-semibold text-ck-teal">Review proposals</Link>
        <Link to="/search" search={{ q: undefined, includeHistorical: undefined, projectId, scope: undefined }} className="font-semibold text-ck-teal">Search evidence</Link>
        {context.indicators.stale
          ? <span className="ml-auto text-ck-amber">Attention: stale memory state</span>
          : context.indicators.blocked
            ? <span className="ml-auto text-ck-muted">Canonical freshness current · blocker tracked separately</span>
            : <span className="ml-auto text-ck-muted">No stale indicator</span>}
      </div>
    </section>
  );
}
