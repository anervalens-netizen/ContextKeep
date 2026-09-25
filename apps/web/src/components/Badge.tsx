import type { ReactNode } from "react";

const lifecycleStyles: Record<string, string> = {
  active: "border-ck-green/40 bg-ck-green/10 text-ck-green",
  retired: "border-ck-red/40 bg-ck-red/10 text-ck-red",
  paused: "border-ck-amber/40 bg-ck-amber/10 text-ck-amber",
  planned: "border-ck-blue/40 bg-ck-blue/10 text-ck-blue",
  unknown: "border-ck-muted/40 bg-ck-muted/10 text-ck-muted",
};

const statusStyles: Record<string, string> = {
  accepted: "border-ck-green/40 bg-ck-green/10 text-ck-green",
  proposed: "border-ck-blue/40 bg-ck-blue/10 text-ck-blue",
  rejected: "border-ck-red/40 bg-ck-red/10 text-ck-red",
  superseded: "border-ck-muted/40 bg-ck-muted/10 text-ck-muted",
};

const basisLabels: Record<string, string> = {
  owner_declaration: "owner declaration",
  agent_report: "agent report",
  document: "document",
  observed_technical: "observed (technical)",
};

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {children}
    </span>
  );
}

export function LifecycleBadge({ state }: { state: string }): ReactNode {
  return <Pill className={lifecycleStyles[state] ?? lifecycleStyles.unknown!}>{state}</Pill>;
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Pill className={statusStyles[status] ?? statusStyles.proposed!}>{status}</Pill>;
}

export function BasisBadge({ basis }: { basis: string }): ReactNode {
  return <Pill className="border-ck-line bg-ck-bg text-ck-muted">{basisLabels[basis] ?? basis}</Pill>;
}

export function TypeBadge({ type }: { type: string }): ReactNode {
  return <Pill className="border-ck-teal/40 bg-ck-teal/10 text-ck-teal">{type}</Pill>;
}

export function TaskBadge({ status }: { status: string }): ReactNode {
  const cls =
    status === "done"
      ? "border-ck-green/40 bg-ck-green/10 text-ck-green"
      : status === "blocked"
        ? "border-ck-red/40 bg-ck-red/10 text-ck-red"
        : "border-ck-amber/40 bg-ck-amber/10 text-ck-amber";
  return <Pill className={cls}>{status.replace("_", " ")}</Pill>;
}
