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
  ownerAction: string | null;
  lastActivityAt: string;
  activeBlockers: number;
  executionStatus: string | null;
  verification: string | null;
  stateToken: string;
  taskRevision: number;
}
export interface ProjectDossier {
  project: { id: string; name: string; lifecycle: string };
  goals: Array<{ recordId: string; text: string }>;
  tasks: TaskDigest[];
  pagination: { total: number; nextOffset: number | null };
  historicalUnscopedCheckpoints: number;
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
  return (
    <article className="ck-now" aria-label="Current task state">
      <div className="ck-now-heading">
        <h3>Ce contează acum</h3>
        <span className={`ck-state-tag ck-state-${dossier.state}`}>
          {stateLabel(dossier.state)}
        </span>
      </div>
      <p className="ck-now-summary">
        {dossier.summary ?? "Nu există încă un raport pentru această lucrare."}
      </p>
      <dl className="ck-now-facts">
        <div>
          <dt>Pasul următor</dt>
          <dd>
            {dossier.nextAction ??
              "Nu este precizat. Citește dovezile înainte de a continua."}
          </dd>
        </div>
        {dossier.ownerAction && (
          <div className="ck-owner-action">
            <dt>De la tine</dt>
            <dd>{dossier.ownerAction}</dd>
          </div>
        )}
        {dossier.execution && (
          <div>
            <dt>Ultima execuție</dt>
            <dd>
              {stateLabel(dossier.execution.status)} ·{" "}
              {stateLabel(dossier.execution.verification)}
            </dd>
          </div>
        )}
        {dossier.execution?.evidenceValidity && (
          <div>
            <dt>Validitatea dovezii</dt>
            <dd>{evidenceLabel(dossier.execution.evidenceValidity.status)}</dd>
          </div>
        )}
        <div>
          <dt>Continuare pe evenimente</dt>
          <dd>
            {dossier.continuation.ready
              ? "Configurată și abonată"
              : dossier.continuation.policy?.mode &&
                  dossier.continuation.policy.mode !== "off"
                ? "Politică pregătită; abonarea ChatGPT lipsește"
                : "Oprită pentru această lucrare"}
          </dd>
        </div>
        {dossier.continuation.health && (
          <div>
            <dt>Livrarea evenimentelor</dt>
            <dd>
              {dossier.continuation.health.lastDelivery
                ? `Ultimul eveniment: ${deliveryLabel(dossier.continuation.health.lastDelivery.status)} · ${dossier.continuation.health.lastDelivery.attempts} încercări`
                : "Nicio livrare înregistrată; funcționarea nu este încă demonstrată."}
            </dd>
            {dossier.continuation.health.pendingDeliveries > 0 && (
              <dd>
                {dossier.continuation.health.pendingDeliveries} livrări în
                așteptare
              </dd>
            )}
            {dossier.continuation.health.failedDeliveries > 0 && (
              <dd role="status">
                {dossier.continuation.health.failedDeliveries} livrări eșuate în
                istoric
              </dd>
            )}
            {dossier.continuation.health.reconciliationNeeded > 0 && (
              <dd role="status">
                {dossier.continuation.health.reconciliationNeeded} continuări
                necesită reconciliere
              </dd>
            )}
          </div>
        )}
      </dl>
      {dossier.lastReported && (
        <small>
          Raport: {time(dossier.lastReported.recordedAt)} ·{" "}
          {dossier.lastReported.reviewStatus} ·{" "}
          {dossier.lastReported.evidenceBasis}
        </small>
      )}
      <small>
        Starea raportată nu modifică automat progresul acceptat sau deciziile
        proiectului.
      </small>
      {dossier.warnings.length > 0 && (
        <details>
          <summary>{dossier.warnings.length} precizări despre stare</summary>
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
}: {
  projectId: string;
  load: (id: string, offset?: number) => Promise<ProjectDossier>;
  onTask: (id: string) => void;
}) {
  const [data, setData] = useState<ProjectDossier | null>(null),
    [error, setError] = useState("");
  const [moreBusy, setMoreBusy] = useState(false),
    [filter, setFilter] = useState("active");
  const generation = useRef(0),
    loadedPages = useRef(1),
    pending = useRef(false),
    reload = useRef<((pages?: number) => Promise<void>) | null>(null);
  useEffect(() => {
    const g = ++generation.current;
    let stopped = false;
    loadedPages.current = 1;
    pending.current = false;
    setMoreBusy(false);
    setData(null);
    setError("");
    setFilter("active");
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
    async function refresh(targetPages = loadedPages.current) {
      if (pending.current || stopped) return;
      pending.current = true;
      setMoreBusy(true);
      const fresh: ProjectDossier[] = [];
      try {
        // Re-read the visible prefix rather than append to obsolete page boundaries.
        const first = await load(projectId, 0);
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
        if (!stopped && generation.current === g) setError("");
      } catch {
        if (!stopped && generation.current === g) {
          publish(fresh, true);
          setError(
            fresh.length > 0
              ? "O parte din dosar a fost actualizată. Paginile rămase pot conține date vechi; reîncercarea este automată."
              : "Dosarul nu poate fi actualizat. Datele afișate pot fi vechi.",
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
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 15_000);
    return () => {
      stopped = true;
      reload.current = null;
      clearInterval(timer);
    };
  }, [projectId, load]);
  async function more() {
    if (!data || data.pagination.nextOffset === null || pending.current) return;
    await reload.current?.(loadedPages.current + 1);
  }
  const tasks =
    data?.tasks.filter(
      (t) => filter !== "active" || !["done", "cancelled"].includes(t.state),
    ) ?? [];
  return (
    <section className="ck-project-now" aria-label="Current project dossier">
      <div className="ck-now-heading">
        <h3>Ce contează acum</h3>
        {data && <small>{data.pagination.total} lucrări</small>}
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Se încarcă starea proiectului…</p>}
      {data && (
        <>
          <div className="ck-filter-controls">
            <button
              aria-pressed={filter === "active"}
              onClick={() => setFilter("active")}
            >
              Active
            </button>
            <button
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Toate
            </button>
          </div>
          {tasks.length ? (
            <div className="ck-dossier-cards">
              {tasks.map((t) => (
                <button
                  className="ck-dossier-card"
                  key={t.taskId}
                  onClick={() => onTask(t.taskId)}
                >
                  <span className={`ck-state-tag ck-state-${t.state}`}>
                    {stateLabel(t.state)}
                  </span>
                  <strong>{t.title}</strong>
                  <span>{t.summary ?? "Nu există un raport recent."}</span>
                  {t.ownerAction && (
                    <span className="ck-owner-action">
                      De la tine: {t.ownerAction}
                    </span>
                  )}
                  {t.nextAction && (
                    <span className="ck-task-muted">
                      Urmează: {t.nextAction}
                    </span>
                  )}
                  <small>{time(t.lastActivityAt)}</small>
                </button>
              ))}
            </div>
          ) : (
            <p>
              {data.pagination.total === 0
                ? "Nu există lucrări în acest proiect."
                : "Nicio lucrare activă în pagina încărcată. Verifică și istoricul sau paginile următoare."}
            </p>
          )}
          {data.pagination.nextOffset !== null && (
            <button disabled={moreBusy} onClick={() => void more()}>
              Mai multe lucrări
            </button>
          )}
          {data.goals.length > 0 && (
            <details>
              <summary>Decizii și reguli păstrate</summary>
              {data.goals.map((g) => (
                <p key={g.recordId}>{g.text}</p>
              ))}
            </details>
          )}
          {data.links.items.length > 0 && (
            <details>
              <summary>Legături între proiecte și dispozitive</summary>
              {data.links.items.map((l) => (
                <p key={l.recordId}>
                  {l.projectName} · {l.relation} ·{" "}
                  {l.targetProjectName ?? l.deviceId}{" "}
                  <small>({l.reviewStatus})</small>
                </p>
              ))}
            </details>
          )}
          {data.historicalUnscopedCheckpoints > 0 && (
            <small>
              {data.historicalUnscopedCheckpoints} checkpoint-uri vechi nu au
              lucrare asociată. Sunt istoric, nu următorul pas al tuturor
              lucrărilor.
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
}: {
  load: (offset?: number) => Promise<PortfolioPage>;
  onProject: (id: string) => void;
}) {
  const [data, setData] = useState<PortfolioPage | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void load()
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {
        if (active) setError("Portofoliul nu este disponibil.");
      });
    return () => {
      active = false;
    };
  }, [load]);
  return (
    <section aria-label="Project portfolio">
      <h3>Proiectele tale</h3>
      {error && <p role="alert">{error}</p>}
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
                  {p.lifecycle} · {p.taskCount} lucrări
                </small>
                {p.tasks.slice(0, 1).map((t) => (
                  <span key={t.taskId}>
                    {stateLabel(t.state)} · {t.summary ?? t.title}
                  </span>
                ))}
              </button>
            ))}
          </div>
          {data.nextOffset !== null && (
            <p className="ck-task-muted">
              Sunt afișate {data.items.length} din {data.total} proiecte. Lista
              de selecție include toate proiectele.
            </p>
          )}
        </>
      )}
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
        if (active) setError("Istoricul nu poate fi încărcat.");
      });
    return () => {
      active = false;
    };
  }, [projectId, taskId, offset, scope, load]);
  return (
    <article aria-label="Operational timeline">
      <h3>Istoric operațional</h3>
      <select
        aria-label="Activity scope"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      >
        <option value="all">Toate sursele</option>
        <option value="canonical">Cunoștințe acceptate</option>
        <option value="working">Rapoarte de lucru</option>
        <option value="executions">Execuții</option>
      </select>
      {error && <p role="alert">{error}</p>}
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
      {data?.total === 0 && <p>Nu există înregistrări pentru filtrul ales.</p>}
      <nav>
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Anterior
        </button>{" "}
        <button
          disabled={!data || data.nextOffset === null}
          onClick={() => setOffset(data?.nextOffset ?? offset)}
        >
          Mai vechi
        </button>
      </nav>
    </article>
  );
}
