import { usePanelText } from "../lib/panel-locale.js";
import { schedulePanelRefresh } from "../lib/panel-refresh.js";
import type { TaskAttention } from "@contextkeep/shared";
import { useEffect, useRef, useState } from "react";

export interface TaskDossier {
  projectId: string;
  taskId: string;
  title: string;
  objective: string;
  taskRevision: number;
  state: string;
  stateSource: string;
  summary: string | null;
  nextAction: string | null;
  followUp?: {
    nextAction: string | null;
    summary: string | null;
    checkpointRecordId: string;
    recordedAt: string;
    provenance: string;
  } | null;
  ownerAction: string | null;
  progress: {
    recordId: string;
    revision: number;
    status: string;
    recordedAt: string;
    reviewStatus: string;
  } | null;
  lastReported: {
    recordId: string;
    recordedAt: string;
    reviewStatus: string;
    evidenceBasis: string;
  } | null;
  execution: {
    id: string;
    status: string;
    verification: string;
    evidenceValidity?: {
      status: "pending" | "valid" | "changed" | "retracted" | "legacy_unbound";
    };
    updatedAt: string;
  } | null;
  currentEvidenceValidity?: string | null;
  unresolvedExecutionCount?: number;
  needsAttention?: boolean;
  attentionReasons?: string[];
  attention?: TaskAttention;
  lifecycleSuppressed?: boolean;
  lifecycleSuppressionReason?: string | null;
  blockers: { activeCount: number };
  continuation: {
    policy: { mode: string; objective: string } | null;
    activeSubscriptions: number;
    ready: boolean;
    health?: {
      pendingDeliveries: number;
      failedDeliveries: number;
      oldestPendingAt: string | null;
      reconciliationNeeded: number;
      lastDelivery: {
        status: string;
        attempts: number;
        httpStatus: number | null;
        eventCreatedAt: string;
        nextAttemptAt: string | null;
      } | null;
    };
  };
  warnings: string[];
  stateToken: string;
}
export interface TaskDigest {
  taskId: string;
  title: string;
  state: string;
  summary: string | null;
  nextAction: string | null;
  followUp?: {
    nextAction: string | null;
    summary: string | null;
    checkpointRecordId: string;
    recordedAt: string;
    provenance: string;
  } | null;
  ownerAction: string | null;
  lastActivityAt: string;
  activeBlockers: number;
  executionStatus: string | null;
  verification: string | null;
  currentEvidenceValidity?: string | null;
  unresolvedExecutionCount?: number;
  needsAttention?: boolean;
  attentionReasons?: string[];
  attention?: TaskAttention;
  lifecycleSuppressed?: boolean;
  lifecycleSuppressionReason?: string | null;
  stateToken: string;
  taskRevision: number;
}
export interface ProjectDossier {
  project: { id: string; name: string; lifecycle: string };
  goals: Array<{ recordId: string; text: string }>;
  tasks: TaskDigest[];
  attention?: {
    count: number;
    offset: number;
    limit: number;
    tasks: TaskDigest[];
    nextOffset: number | null;
    truncated: boolean;
    recovery?: {
      tool: string;
      projectId: string;
      offset: number;
      limit: number;
      attentionOffset: number;
      attentionLimit: number;
    } | null;
  };
  pagination: { total: number; nextOffset: number | null };
  historicalUnscopedCheckpoints: number;
  projectNotes?: number;
  legacyUnscopedCheckpoints?: number;
  links: {
    items: Array<{
      recordId: string;
      projectName: string;
      relation: string;
      targetProjectName: string | null;
      deviceId: string | null;
      reviewStatus: string;
    }>;
  };
}
export interface PortfolioPage {
  items: Array<{
    id: string;
    name: string;
    lifecycle: string;
    tasks: TaskDigest[];
    taskCount: number;
    moreTasks: boolean;
    attentionCount?: number;
    attentionTasks?: TaskDigest[];
  }>;
  total: number;
  nextOffset: number | null;
}
export interface ActivityPage {
  items: Array<{
    id: string;
    title: string;
    summary: string;
    kind: string;
    recordedAt: string;
    reviewStatus: string;
    evidenceBasis: string;
  }>;
  total: number;
  nextOffset: number | null;
}
export function stateLabel(state: string): string {
  const labels: Record<string, string> = {
    open: "Deschisă",
    in_progress: "În lucru",
    blocked: "Blocată",
    done: "Închisă",
    cancelled: "Anulată",
    unknown: "Stare neprecizată",
    completed: "Proces terminat",
    failed: "Eșuat",
    running: "Rulează",
    reserved: "Pregătit",
    job_start_uncertain: "Pornire de verificat",
    not_started: "Nu a pornit",
    lost: "Rezultat necunoscut",
    passed: "Verificat",
    pending: "Neverificat",
  };
  return labels[state] ?? state;
}
const evidenceLabel = (status: string) =>
  ({
    valid: "Dovadă actuală, legată de execuție",
    changed: "Dovadă modificată — reverificare necesară",
    retracted: "Dovadă retrasă — verdict doar istoric",
    legacy_unbound: "Verificare istorică fără legătură explicită",
    pending: "Dovadă încă neverificată",
  })[status] ?? "Validitate necunoscută";
const deliveryLabel = (status: string) =>
  ({
    delivered: "livrat",
    pending: "în așteptare",
    sending: "în curs",
    failed: "eșuat",
    revoked: "anulat",
  })[status] ?? "necunoscut";
const time = (value: string) => new Date(value).toLocaleString();
export function TaskNow({ dossier }: { dossier: TaskDossier }) {
  const tr = usePanelText();
  return (
    <article className="ck-now" aria-label={tr("Current task state")}>
      <div className="ck-now-heading">
        <h3>{tr("Ce contează acum")}</h3>
        <span className={`ck-state-tag ck-state-${dossier.state}`}>
          {tr(stateLabel(dossier.state))}
        </span>
      </div>
      <p className="ck-now-summary">
        {dossier.summary ??
          tr("Nu există încă un raport pentru această lucrare.")}
      </p>
      {dossier.needsAttention && (
        <p role="status" className="ck-owner-action">
          {tr(" Necesită atenție ")}
          {typeof dossier.unresolvedExecutionCount === "number" &&
          dossier.unresolvedExecutionCount > 0
            ? `: ${dossier.unresolvedExecutionCount} ${tr("execuții sau dovezi necesită verificare")}`
            : "."}
        </p>
      )}
      {dossier.attention && dossier.attention.items.length > 0 && (
        <p aria-label={tr("Attention categories")}>
          {[...new Set(dossier.attention.items.map((item) => item.category))]
            .map(
              (category) =>
                ({
                  actionable_now: tr("Acțiune necesară"),
                  verification_needed: tr("Verificare necesară"),
                  owner_optional: tr("Opțional pentru proprietar"),
                  deferred: tr("Amânat"),
                  historical_integrity: tr("Istoric de reconciliat"),
                })[category],
            )
            .join(" · ")}
        </p>
      )}
      <dl className="ck-now-facts">
        <div>
          <dt>{tr("Pasul următor")}</dt>
          <dd>
            {dossier.lifecycleSuppressed
              ? tr(
                  "Continuarea este suspendată de starea proiectului. Execuțiile și dovezile rămân vizibile.",
                )
              : (dossier.nextAction ??
                tr(
                  "Nu este precizat. Citește dovezile înainte de a continua.",
                ))}
          </dd>
        </div>
        {dossier.followUp && (
          <div>
            <dt>{tr("Urmărire după închidere")}</dt>
            <dd>
              {dossier.followUp.nextAction ??
                dossier.followUp.summary ??
                tr("Verifică checkpointul asociat.")}
            </dd>
          </div>
        )}
        {dossier.ownerAction && (
          <div className="ck-owner-action">
            <dt>{tr("De la tine")}</dt>
            <dd>{dossier.ownerAction}</dd>
          </div>
        )}
        {dossier.execution && (
          <div>
            <dt>{tr("Ultima execuție")}</dt>
            <dd>
              {tr(stateLabel(dossier.execution.status))} ·{" "}
              {tr(stateLabel(dossier.execution.verification))}
            </dd>
          </div>
        )}
        {dossier.execution?.evidenceValidity && (
          <div>
            <dt>{tr("Validitatea dovezii")}</dt>
            <dd>
              {tr(evidenceLabel(dossier.execution.evidenceValidity.status))}
            </dd>
          </div>
        )}
        <div>
          <dt>{tr("Continuare pe evenimente")}</dt>
          <dd>
            {dossier.continuation.ready
              ? tr("Configurată și abonată")
              : dossier.continuation.policy?.mode &&
                  dossier.continuation.policy.mode !== "off"
                ? tr("Politică pregătită; abonarea ChatGPT lipsește")
                : tr("Oprită pentru această lucrare")}
          </dd>
        </div>
        {dossier.continuation.health && (
          <div>
            <dt>{tr("Livrarea evenimentelor")}</dt>
            <dd>
              {dossier.continuation.health.lastDelivery
                ? `${tr("Ultimul eveniment:")} ${tr(deliveryLabel(dossier.continuation.health.lastDelivery.status))} · ${dossier.continuation.health.lastDelivery.attempts} ${tr("încercări")}`
                : tr(
                    "Nicio livrare înregistrată; funcționarea nu este încă demonstrată.",
                  )}
            </dd>
            {dossier.continuation.health.pendingDeliveries > 0 && (
              <dd>
                {dossier.continuation.health.pendingDeliveries}{" "}
                {tr(" livrări în așteptare ")}
              </dd>
            )}
            {dossier.continuation.health.failedDeliveries > 0 && (
              <dd role="status">
                {dossier.continuation.health.failedDeliveries}{" "}
                {tr(" livrări eșuate în istoric ")}
              </dd>
            )}
            {dossier.continuation.health.reconciliationNeeded > 0 && (
              <dd role="status">
                {dossier.continuation.health.reconciliationNeeded}{" "}
                {tr(" continuări necesită reconciliere ")}
              </dd>
            )}
          </div>
        )}
      </dl>
      {dossier.lastReported && (
        <small>
          {tr(" Raport: ")}
          {time(dossier.lastReported.recordedAt)} ·{" "}
          {dossier.lastReported.reviewStatus} ·{" "}
          {dossier.lastReported.evidenceBasis}
        </small>
      )}
      <small>
        {tr(
          " Starea raportată nu modifică automat progresul acceptat sau deciziile proiectului. ",
        )}
      </small>
      {dossier.warnings.length > 0 && (
        <details>
          <summary>
            {dossier.warnings.length} {tr(" precizări despre stare")}
          </summary>
          {dossier.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
    </article>
  );
}
export function ProjectNow({
  projectId,
  load,
  onTask,
  refreshIntervalMs = 15000,
  serverFiltered = false,
}: {
  projectId: string;
  load: (
    id: string,
    offset?: number,
    attentionOffset?: number,
  ) => Promise<ProjectDossier>;
  onTask: (id: string) => void;
  refreshIntervalMs?: number | null;
  serverFiltered?: boolean;
}) {
  const tr = usePanelText();
  const [data, setData] = useState<ProjectDossier | null>(null),
    [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false),
    [filter, setFilter] = useState("active");
  const generation = useRef(0),
    loadedPages = useRef(1),
    loadedAttentionPages = useRef(1),
    pending = useRef(false),
    reload = useRef<
      ((pages?: number, attentionPages?: number) => Promise<void>) | null
    >(null);
  useEffect(() => {
    const g = ++generation.current;
    let stopped = false;
    loadedPages.current = 1;
    loadedAttentionPages.current = 1;
    pending.current = false;
    setMoreBusy(false);
    setData(null);
    setError("");
    setFilter("active");
    setObservedAt(null);
    let pageCache: ProjectDossier[] = [];
    function publish(fresh: ProjectDossier[], partial: boolean) {
      if (stopped || generation.current !== g || fresh.length === 0) return;
      // A failed later page must not discard a successfully refreshed prefix.
      const pages = partial
        ? [...fresh, ...pageCache.slice(fresh.length)]
        : fresh;
      pageCache = pages;
      loadedPages.current = pages.length;
      const tasks = new Map<string, ProjectDossier["tasks"][number]>();
      for (const page of pages)
        for (const task of page.tasks) {
          // New prefix wins over potentially stale duplicate cards in retained pages.
          if (!tasks.has(task.taskId)) tasks.set(task.taskId, task);
        }
      const first = pages[0]!,
        last = pages[pages.length - 1]!;
      setData({
        ...first,
        tasks: [...tasks.values()],
        pagination: { ...last.pagination, total: first.pagination.total },
      });
    }
    async function refresh(
      targetPages = loadedPages.current,
      targetAttentionPages = loadedAttentionPages.current,
    ) {
      if (pending.current || stopped) return;
      pending.current = true;
      setMoreBusy(true);
      const fresh: ProjectDossier[] = [];
      try {
        // Re-read the visible prefix rather than append to obsolete page boundaries.
        let first = await load(projectId, 0);
        if (
          first.attention &&
          targetAttentionPages > 1 &&
          first.attention.nextOffset !== null
        ) {
          const attentionById = new Map(
            first.attention.tasks.map((task) => [task.taskId, task]),
          );
          let attentionPage = first.attention;
          let attentionPages = 1;
          while (
            attentionPages < targetAttentionPages &&
            attentionPage.nextOffset !== null
          ) {
            const next = await load(projectId, 0, attentionPage.nextOffset);
            if (!next.attention) break;
            for (const task of next.attention.tasks)
              attentionById.set(task.taskId, task);
            attentionPage = next.attention;
            attentionPages += 1;
          }
          loadedAttentionPages.current = attentionPages;
          first = {
            ...first,
            attention: {
              ...first.attention,
              tasks: [...attentionById.values()],
              nextOffset: attentionPage.nextOffset,
              truncated: attentionPage.nextOffset !== null,
              recovery: attentionPage.recovery,
            },
          };
        }
        fresh.push(first);
        let last = first,
          previousOffset = 0;
        while (
          fresh.length < targetPages &&
          last.pagination.nextOffset !== null
        ) {
          if (stopped || generation.current !== g) return;
          const offset = last.pagination.nextOffset;
          if (offset <= previousOffset)
            throw new Error("Non-advancing task page");
          last = await load(projectId, offset);
          fresh.push(last);
          previousOffset = offset;
        }
        publish(fresh, false);
        if (!stopped && generation.current === g) {
          setError("");
          setObservedAt(new Date().toISOString());
        }
      } catch {
        if (!stopped && generation.current === g) {
          publish(fresh, true);
          setError(
            fresh.length > 0
              ? tr(
                  "O parte din dosar a fost actualizată. Paginile rămase pot conține date vechi. Actualizează dosarul pentru a reîncerca.",
                )
              : tr(
                  "Dosarul nu poate fi actualizat. Datele afișate pot fi vechi.",
                ),
          );
        }
      } finally {
        if (!stopped && generation.current === g) {
          pending.current = false;
          setMoreBusy(false);
        }
      }
    }
    reload.current = refresh;
    void refresh();
    const stop = schedulePanelRefresh(() => void refresh(), refreshIntervalMs);
    return () => {
      stopped = true;
      reload.current = null;
      stop();
    };
  }, [projectId, load, refreshIntervalMs]);
  async function more() {
    if (!data || data.pagination.nextOffset === null || pending.current) return;
    await reload.current?.(
      loadedPages.current + 1,
      loadedAttentionPages.current,
    );
  }
  async function moreAttention() {
    if (
      !data?.attention ||
      data.attention.nextOffset === null ||
      pending.current
    )
      return;
    await reload.current?.(
      loadedPages.current,
      loadedAttentionPages.current + 1,
    );
  }
  const tasks =
    data?.tasks.filter(
      (t) =>
        serverFiltered ||
        filter !== "active" ||
        !["done", "cancelled"].includes(t.state),
    ) ?? [];
  return (
    <section
      className="ck-project-now"
      aria-label={tr("Current project dossier")}
    >
      <div className="ck-now-heading">
        <h3>{tr("Ce contează acum")}</h3>
        <button disabled={moreBusy} onClick={() => void reload.current?.()}>
          {tr("Actualizează dosarul")}
        </button>
        {observedAt && (
          <small>
            {tr("Citit integral la ")}
            <time dateTime={observedAt}>
              {new Date(observedAt).toLocaleTimeString()}
            </time>
          </small>
        )}
        {data && (
          <small>
            {data.pagination.total} {tr(" lucrări")}
          </small>
        )}
      </div>
      {error && <p role="alert">{tr(error)}</p>}
      {!data && !error && (
        <p role="status">{tr("Se încarcă starea proiectului…")}</p>
      )}
      {data && (
        <>
          {data.attention && data.attention.count > 0 && (
            <section
              aria-label={tr("Needs attention")}
              className="ck-attention-list"
            >
              <h4>
                {tr("Necesită atenție (")}
                {data.attention.count})
              </h4>
              <div className="ck-dossier-cards">
                {data.attention.tasks.map((t) => (
                  <button
                    className="ck-dossier-card"
                    key={`attention-${t.taskId}`}
                    onClick={() => onTask(t.taskId)}
                  >
                    <span className={`ck-state-tag ck-state-${t.state}`}>
                      {tr(stateLabel(t.state))}
                    </span>
                    <strong>{t.title}</strong>
                    <span>
                      {t.unresolvedExecutionCount
                        ? `${t.unresolvedExecutionCount} execuții/dovezi necesită verificare`
                        : t.activeBlockers
                          ? `${t.activeBlockers} blocaje active`
                          : tr("Este necesară o verificare sau o acțiune.")}
                    </span>
                  </button>
                ))}
              </div>
              {data.attention.nextOffset !== null && (
                <button
                  disabled={moreBusy}
                  onClick={() => void moreAttention()}
                >
                  {tr(" Mai multe de verificat ")}
                </button>
              )}
            </section>
          )}
          {!serverFiltered && (
            <div className="ck-filter-controls">
              <button
                aria-pressed={filter === "active"}
                onClick={() => setFilter("active")}
              >
                {tr(" Active ")}
              </button>
              <button
                aria-pressed={filter === "all"}
                onClick={() => setFilter("all")}
              >
                {tr(" Toate ")}
              </button>
            </div>
          )}
          {tasks.length ? (
            <div className="ck-dossier-cards">
              {tasks.map((t) => (
                <button
                  className="ck-dossier-card"
                  key={t.taskId}
                  onClick={() => onTask(t.taskId)}
                >
                  <span className={`ck-state-tag ck-state-${t.state}`}>
                    {tr(stateLabel(t.state))}
                  </span>
                  <strong>{t.title}</strong>
                  <span>{t.summary ?? tr("Nu există un raport recent.")}</span>
                  {t.ownerAction && (
                    <span className="ck-owner-action">
                      {tr(" De la tine: ")}
                      {t.ownerAction}
                    </span>
                  )}
                  {t.nextAction && (
                    <span className="ck-task-muted">
                      {tr(" Urmează: ")}
                      {t.nextAction}
                    </span>
                  )}
                  <small>{time(t.lastActivityAt)}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>
              {data.pagination.total === 0
                ? serverFiltered
                  ? tr("Nicio lucrare nu corespunde filtrelor selectate.")
                  : tr("Nu există lucrări în acest proiect.")
                : tr(
                    "Nicio lucrare activă în pagina încărcată. Verifică și istoricul sau paginile următoare.",
                  )}
            </p>
          )}
          {data.pagination.nextOffset !== null && (
            <button disabled={moreBusy} onClick={() => void more()}>
              {tr(" Mai multe lucrări ")}
            </button>
          )}
          {data.goals.length > 0 && (
            <details>
              <summary>{tr("Decizii și reguli păstrate")}</summary>
              {data.goals.map((g) => (
                <p key={g.recordId}>{g.text}</p>
              ))}
            </details>
          )}
          {data.links.items.length > 0 && (
            <details>
              <summary>{tr("Legături între proiecte și dispozitive")}</summary>
              {data.links.items.map((l) => (
                <p key={l.recordId}>
                  {l.projectName} · {l.relation} ·{" "}
                  {l.targetProjectName ?? l.deviceId}{" "}
                  <small>({l.reviewStatus})</small>
                </p>
              ))}
            </details>
          )}
          {(data.projectNotes ?? 0) > 0 && (
            <small>
              {data.projectNotes} {tr(" note explicite de proiect.")}
            </small>
          )}
          {(data.legacyUnscopedCheckpoints ??
            data.historicalUnscopedCheckpoints) > 0 && (
            <small>
              {data.legacyUnscopedCheckpoints ??
                data.historicalUnscopedCheckpoints}{" "}
              {tr(
                " checkpoint-uri vechi nu au lucrare asociată. Sunt istoric, nu următorul pas al tuturor lucrărilor. ",
              )}
            </small>
          )}
        </>
      )}
    </section>
  );
}
export function PortfolioNow({
  load,
  onProject,
  refreshIntervalMs = 15000,
}: {
  load: (offset?: number) => Promise<PortfolioPage>;
  onProject: (id: string) => void;
  refreshIntervalMs?: number | null;
}) {
  const tr = usePanelText();
  const [data, setData] = useState<PortfolioPage | null>(null),
    [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [previous, setPrevious] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const reload = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    let active = true,
      pending = false;
    setData(null);
    setObservedAt(null);
    setError("");
    async function refresh() {
      if (!active || pending) return;
      pending = true;
      setBusy(true);
      try {
        const next = await load(offset);
        if (!active) return;
        setData(next);
        setObservedAt(new Date().toISOString());
        setError("");
      } catch {
        if (active)
          setError(
            tr(
              "Portofoliul nu poate fi actualizat. Datele afișate pot fi vechi.",
            ),
          );
      } finally {
        pending = false;
        if (active) setBusy(false);
      }
    }
    reload.current = refresh;
    void refresh();
    const stop = schedulePanelRefresh(() => void refresh(), refreshIntervalMs);
    return () => {
      active = false;
      reload.current = null;
      stop();
    };
  }, [load, offset, refreshIntervalMs]);
  return (
    <section aria-label={tr("Project portfolio")}>
      <h3>{tr("Proiectele tale")}</h3>
      <button disabled={busy} onClick={() => void reload.current?.()}>
        {tr("Actualizează portofoliul")}
      </button>
      {observedAt && (
        <small>
          {tr("Citit la ")}
          <time dateTime={observedAt}>
            {new Date(observedAt).toLocaleTimeString()}
          </time>
        </small>
      )}
      {!data && !error && <p role="status">{tr("Se încarcă proiectele…")}</p>}
      {error && <p role="alert">{tr(error)}</p>}
      {data && (
        <>
          <div className="ck-dossier-cards">
            {data.items.map((p) => (
              <button
                className="ck-dossier-card"
                key={p.id}
                onClick={() => onProject(p.id)}
              >
                <strong>{p.name}</strong>
                <small>
                  {p.lifecycle} · {p.taskCount} {tr(" lucrări ")}
                </small>
                {typeof p.attentionCount === "number" &&
                  p.attentionCount > 0 && (
                    <span className="ck-owner-action">
                      {tr(" Necesită atenție: ")}
                      {p.attentionCount}
                    </span>
                  )}
                {(p.attentionTasks?.length ? p.attentionTasks : p.tasks)
                  .slice(0, 1)
                  .map((t) => (
                    <span key={t.taskId}>
                      {tr(stateLabel(t.state))} · {t.summary ?? t.title}
                    </span>
                  ))}
              </button>
            ))}
          </div>
          {data.items.length === 0 && (
            <p>
              {offset === 0
                ? tr("Nu există proiecte de afișat.")
                : tr("Pagina este goală. Revino la pagina anterioară.")}
            </p>
          )}
          <p className="ck-task-muted">
            {data.items.length} {tr(" proiecte afișate · ")}
            {data.total} {tr(" în total")}
          </p>
        </>
      )}
      <nav aria-label={tr("Portfolio pages")} className="ck-filter-controls">
        {previous.length > 0 && (
          <button
            disabled={busy}
            onClick={() => {
              setOffset(previous[previous.length - 1]!);
              setPrevious((p) => p.slice(0, -1));
            }}
          >
            {tr("Proiectele anterioare")}
          </button>
        )}
        {data?.nextOffset !== null && data?.nextOffset !== undefined && (
          <button
            disabled={busy}
            onClick={() => {
              setPrevious((p) => [...p, offset]);
              setOffset(data.nextOffset!);
            }}
          >
            {tr("Proiectele următoare")}
          </button>
        )}
      </nav>
    </section>
  );
}
export function OperationalHistory({
  projectId,
  taskId,
  load,
}: {
  projectId: string;
  taskId?: string;
  load: (
    projectId: string,
    taskId?: string,
    offset?: number,
    scope?: string,
  ) => Promise<ActivityPage>;
}) {
  const tr = usePanelText();
  const [data, setData] = useState<ActivityPage | null>(null),
    [error, setError] = useState("");
  const [offset, setOffset] = useState(0),
    [scope, setScope] = useState("all");
  useEffect(() => {
    setOffset(0);
  }, [projectId, taskId, scope]);
  useEffect(() => {
    let active = true;
    setError("");
    setData(null);
    void load(projectId, taskId, offset, scope)
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {
        if (active) setError(tr("Istoricul nu poate fi încărcat."));
      });
    return () => {
      active = false;
    };
  }, [projectId, taskId, offset, scope, load]);
  return (
    <article aria-label={tr("Operational timeline")}>
      <h3>{tr("Istoric operațional")}</h3>
      <select
        aria-label={tr("Activity scope")}
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      >
        <option value="all">{tr("Toate sursele")}</option>
        <option value="canonical">{tr("Cunoștințe acceptate")}</option>
        <option value="working">{tr("Rapoarte de lucru")}</option>
        <option value="executions">{tr("Execuții")}</option>
      </select>
      {error && <p role="alert">{tr(error)}</p>}
      {data?.items.map((item) => (
        <details key={item.id}>
          <summary>
            {time(item.recordedAt)} · {item.title}
          </summary>
          <small>
            {item.kind} · {item.reviewStatus} · {item.evidenceBasis}
          </small>
          <p className="ck-task-evidence">{item.summary}</p>
        </details>
      ))}
      {data?.total === 0 && (
        <p>{tr("Nu există înregistrări pentru filtrul ales.")}</p>
      )}
      <nav>
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          {tr(" Anterior ")}
        </button>{" "}
        <button
          disabled={!data || data.nextOffset === null}
          onClick={() => setOffset(data?.nextOffset ?? offset)}
        >
          {tr(" Mai vechi ")}
        </button>
      </nav>
    </article>
  );
}
