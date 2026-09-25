import { recordDedupHash, sha256 } from "../lib/hash.js";
import type { ServiceDeps } from "../services/import.js";

export const AI_MEMORY_PROJECT_ID = "eval-project-contextkeep";
export const AI_MEMORY_FIXED_NOW = "2026-09-19T12:00:00.000Z";

export interface AiMemoryFixtureRecord {
  id: string;
  type: "fact" | "decision" | "action" | "constraint" | "question";
  subject: string;
  predicate: string | null;
  text: string;
  reviewStatus: "accepted" | "superseded" | "proposed";
  evidenceBasis: "document" | "observed_technical" | "agent_report";
  taskStatus: "open" | "blocked" | null;
  hasEvidence: boolean;
}

const CORE_RECORDS: readonly AiMemoryFixtureRecord[] = [
  {
    id: "eval-release-current",
    type: "fact",
    subject: "production release",
    predicate: "sha",
    text: "Current production release commit SHA is a5f1c0de1234567890abcdef1234567890abcd01. It is deployed from path /srv/ck-eval/contextkeep on synthetic-host.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-release-old",
    type: "fact",
    subject: "production release",
    predicate: "sha",
    text: "Previous production release commit SHA was b6e2d1af1234567890abcdef1234567890abcd02. It was the old deployment from /srv/ck-eval/contextkeep before 2026-09-19.",
    reviewStatus: "superseded",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-project-id",
    type: "fact",
    subject: "ContextKeep project",
    predicate: "id",
    text: "The ContextKeep project identifier is 22222222-3333-4444-8555-666666666666.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-db-path",
    type: "fact",
    subject: "SQLite database",
    predicate: "path",
    text: "SQLite database path is /srv/ck-eval/contextkeep.sqlite3.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-gateway-current",
    type: "fact",
    subject: "authentication gateway",
    predicate: "port",
    text: "The current ContextKeep authentication gateway listens on port 3082.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-gateway-old",
    type: "fact",
    subject: "authentication gateway",
    predicate: "port",
    text: "The old ContextKeep authentication gateway listened on port 3081.",
    reviewStatus: "superseded",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-lifecycle-current",
    type: "fact",
    subject: "project",
    predicate: "lifecycle",
    text: "The project lifecycle is active.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-lifecycle-old",
    type: "fact",
    subject: "project",
    predicate: "lifecycle",
    text: "The old project lifecycle was paused during the maintenance window.",
    reviewStatus: "superseded",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-backup-ro",
    type: "fact",
    subject: "backup verificat",
    predicate: "stocare",
    text: "Backupul verificat pentru ContextKeep este stocat pe NAS și poate fi restaurat.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-backup-en",
    type: "fact",
    subject: "verified backup",
    predicate: "integrity",
    text: "The verified backup is stored on NAS and passed the SQLite integrity check.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-deploy-path-ro",
    type: "fact",
    subject: "cale deploy",
    predicate: "path",
    text: "Calea de deploy curentă este /srv/ck-eval/contextkeep pe synthetic-host.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-mcp-en",
    type: "decision",
    subject: "agent startup",
    predicate: "flow",
    text: "The agent startup path uses project resolution followed by one bounded work-context call.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-mcp-ro",
    type: "decision",
    subject: "pornire agent",
    predicate: "flux",
    text: "Fluxul de pornire al agentului rezolvă proiectul și apoi cere contextul de lucru limitat.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-blocker-en",
    type: "action",
    subject: "release verification",
    predicate: "blocker",
    text: "Release verification is blocked until the owner confirms the runtime SHA.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: "blocked",
    hasEvidence: true,
  },
  {
    id: "eval-blocker-ro",
    type: "action",
    subject: "verificare release",
    predicate: "blocaj",
    text: "Verificarea release-ului este blocată până când proprietarul confirmă SHA-ul runtime.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: "blocked",
    hasEvidence: true,
  },
  {
    id: "eval-next-en",
    type: "action",
    subject: "runtime verification",
    predicate: "next_action",
    text: "Next action is to compare the runtime SHA with the tested candidate and record the result.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: "open",
    hasEvidence: true,
  },
  {
    id: "eval-next-ro",
    type: "action",
    subject: "verificare runtime",
    predicate: "următoarea_acțiune",
    text: "Următoarea acțiune este să comparăm SHA-ul runtime cu artefactul testat și să notăm rezultatul.",
    reviewStatus: "accepted",
    evidenceBasis: "observed_technical",
    taskStatus: "open",
    hasEvidence: true,
  },
  {
    id: "eval-dep-en",
    type: "fact",
    subject: "deployment",
    predicate: "depends_on",
    text: "Deployment depends on contextkeep.service being healthy and on the SQLite schema migration.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-dep-ro",
    type: "fact",
    subject: "deploy",
    predicate: "depinde_de",
    text: "Deploy-ul depinde de serviciul contextkeep.service sănătos și de migrarea schemei SQLite.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-schema-en",
    type: "decision",
    subject: "MCP context flow",
    predicate: "depends_on",
    text: "The MCP context flow depends on the project resolver and the bounded context endpoint.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-schema-ro",
    type: "decision",
    subject: "flux context MCP",
    predicate: "depinde_de",
    text: "Fluxul MCP depinde de rezolvarea proiectului și de endpointul de context limitat.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-backup-current",
    type: "constraint",
    subject: "backup policy",
    predicate: "current",
    text: "The current backup policy keeps seven verified copies on NAS.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-backup-old",
    type: "constraint",
    subject: "backup policy",
    predicate: "current",
    text: "The old backup policy kept three copies on local disk.",
    reviewStatus: "superseded",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-working-next",
    type: "action",
    subject: "working next action",
    predicate: "next_action",
    text: "Working memory next action: compare the runtime SHA with the tested candidate.",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: "open",
    hasEvidence: true,
  },
  {
    id: "eval-working-blocker",
    type: "action",
    subject: "working blocker",
    predicate: "blocker",
    text: "Working memory blocker: runtime verification waits for owner confirmation of the candidate SHA.",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: "blocked",
    hasEvidence: true,
  },
  {
    id: "eval-working-release",
    type: "fact",
    subject: "working candidate release",
    predicate: "candidate",
    text: "Working memory candidate release: deployment smoke still needs a live runtime check for a5f1c0de1234567890abcdef1234567890abcd01.",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-working-handoff",
    type: "action",
    subject: "working handoff",
    predicate: "blocker",
    text: "Working handoff: blocker is unconfirmed synthetic-host runtime state; next action is a local SSH health check.",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: "blocked",
    hasEvidence: true,
  },
  {
    id: "eval-working-dependency",
    type: "fact",
    subject: "working dependency note",
    predicate: "depends_on",
    text: "Unreviewed working note: the release check depends on the Tailscale gateway being reachable.",
    reviewStatus: "proposed",
    evidenceBasis: "agent_report",
    taskStatus: null,
    hasEvidence: true,
  },
  {
    id: "eval-unbacked",
    type: "fact",
    subject: "synthetic unsupported claim",
    predicate: "unknown",
    text: "Synthetic unbacked claim: zaffre checksum is not known because no supporting excerpt exists.",
    reviewStatus: "accepted",
    evidenceBasis: "document",
    taskStatus: null,
    hasEvidence: false,
  },
];

const NOISE_RECORDS: readonly AiMemoryFixtureRecord[] = Array.from({ length: 14 }, (_, index) => ({
  id: `eval-noise-${String(index + 1).padStart(2, "0")}`,
  type: "fact" as const,
  subject: `evaluation noise note ${index + 1}`,
  predicate: "note",
  text: `Synthetic evaluation noise note ${index + 1} mentions ContextKeep project deployment backup and generic operational records without a target identifier.`,
  reviewStatus: "accepted" as const,
  evidenceBasis: "document" as const,
  taskStatus: null,
  hasEvidence: true,
}));

export const AI_MEMORY_FIXTURE_RECORDS: readonly AiMemoryFixtureRecord[] = [...CORE_RECORDS, ...NOISE_RECORDS];

export interface AiMemoryFixtureSummary {
  projectId: string;
  recordCount: number;
  acceptedCount: number;
  supersededCount: number;
  workingMemoryCount: number;
  evidenceLinkedRecordCount: number;
  intentionallyUnbackedRecordIds: string[];
  relationRecordIds: string[];
}

export interface AiMemoryFixtureRelation {
  id: string;
  sourceRecordId: string;
  subject: string;
  relation: "depends_on" | "blocks" | "affects" | "runs_on";
  object: string;
  reviewStatus: "accepted" | "proposed";
  evidenceBasis: "document" | "agent_report";
}

/** Structured relations are derived only from dependency sentences in the fixture. */
export const AI_MEMORY_FIXTURE_RELATIONS: readonly AiMemoryFixtureRelation[] = [
  { id: "eval-relation-dep-en-service", sourceRecordId: "eval-dep-en", subject: "deployment", relation: "depends_on", object: "contextkeep.service", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-dep-en-schema", sourceRecordId: "eval-dep-en", subject: "deployment", relation: "depends_on", object: "SQLite schema migration", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-dep-ro-service", sourceRecordId: "eval-dep-ro", subject: "deploy", relation: "depends_on", object: "serviciul contextkeep.service", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-dep-ro-schema", sourceRecordId: "eval-dep-ro", subject: "deploy", relation: "depends_on", object: "migrarea schemei SQLite", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-schema-en-resolver", sourceRecordId: "eval-schema-en", subject: "MCP context flow", relation: "depends_on", object: "project resolver", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-schema-en-endpoint", sourceRecordId: "eval-schema-en", subject: "MCP context flow", relation: "depends_on", object: "bounded context endpoint", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-schema-ro-resolver", sourceRecordId: "eval-schema-ro", subject: "flux context MCP", relation: "depends_on", object: "rezolvarea proiectului", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-schema-ro-endpoint", sourceRecordId: "eval-schema-ro", subject: "flux context MCP", relation: "depends_on", object: "endpointul de context limitat", reviewStatus: "accepted", evidenceBasis: "document" },
  { id: "eval-relation-working-gateway", sourceRecordId: "eval-working-dependency", subject: "release check", relation: "depends_on", object: "reachable Tailscale gateway", reviewStatus: "proposed", evidenceBasis: "agent_report" },
];

function relationText(relation: AiMemoryFixtureRelation, sourceText: string): string {
  return `${sourceText} Structured relation: ${relation.subject} ${relation.relation.replaceAll("_", " ")} ${relation.object}.`;
}

/** Seed only the synthetic evaluation store. It never reads or writes owner data. */
export function seedAiMemoryFixture(deps: ServiceDeps, options: { includeRelations?: boolean } = {}): AiMemoryFixtureSummary {
  const { sqlite } = deps;
  const insertProject = sqlite.prepare(
    `INSERT INTO projects
      (id, name, aliases_json, parent_project_id, description, lifecycle, lifecycle_record_id,
       revision, content_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'active', NULL, 1, 1, ?, ?)`,
  );
  const insertSource = sqlite.prepare(
    `INSERT INTO sources
      (id, kind, title, original_filename, content_hash, normalized_hash, imported_at, event_at,
       author_label, provenance_basis, project_id, original_text, normalized_text, redaction_state)
     VALUES (?, 'system_seed', ?, NULL, ?, ?, ?, ?, ?, 'system', ?, ?, ?, 'none')`,
  );
  const insertExcerpt = sqlite.prepare(
    `INSERT INTO source_excerpts
      (id, source_id, start_offset, end_offset, exact_text, exact_text_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertRecord = sqlite.prepare(
    `INSERT INTO records
      (id, project_id, type, subject, predicate, value_json, text, review_status, evidence_basis,
       task_status, record_dedup_hash, recorded_at, source_event_at, effective_from, effective_to,
       reviewed_at, review_due_at, volatile, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 1, ?, ?)`,
  );
  const insertEvidence = sqlite.prepare(
    `INSERT INTO record_evidence
      (record_id, excerpt_id, relation, observed_at, environment, artifact_ref)
     VALUES (?, ?, 'supports', ?, 'synthetic-eval', NULL)`,
  );

  const seed = sqlite.transaction(() => {
    insertProject.run(
      AI_MEMORY_PROJECT_ID,
      "ContextKeep AI-memory evaluation",
      JSON.stringify(["CK eval", "AI memory eval"]),
      "Synthetic RO/EN records for the A5.1 baseline; never owner data.",
      AI_MEMORY_FIXED_NOW,
      AI_MEMORY_FIXED_NOW,
    );

    for (const record of AI_MEMORY_FIXTURE_RECORDS) {
      const sourceId = `eval-source-${record.id}`;
      const excerptId = `eval-excerpt-${record.id}`;
      const recordHash = recordDedupHash({
        projectId: AI_MEMORY_PROJECT_ID,
        type: record.type,
        subject: record.subject,
        text: record.text,
      });
      const contentHash = sha256(`${sourceId}\u0000${record.text}`);
      insertSource.run(
        sourceId,
        `Synthetic evidence for ${record.id}`,
        contentHash,
        sha256(record.text),
        AI_MEMORY_FIXED_NOW,
        AI_MEMORY_FIXED_NOW,
        "A5.1 synthetic fixture",
        AI_MEMORY_PROJECT_ID,
        record.text,
        record.text,
      );
      insertExcerpt.run(excerptId, sourceId, 0, record.text.length, record.text, sha256(record.text));
      insertRecord.run(
        record.id,
        AI_MEMORY_PROJECT_ID,
        record.type,
        record.subject,
        record.predicate,
        null,
        record.text,
        record.reviewStatus,
        record.evidenceBasis,
        record.taskStatus,
        recordHash,
        AI_MEMORY_FIXED_NOW,
        AI_MEMORY_FIXED_NOW,
        record.reviewStatus === "proposed" ? null : AI_MEMORY_FIXED_NOW,
        AI_MEMORY_FIXED_NOW,
        AI_MEMORY_FIXED_NOW,
      );
      if (record.hasEvidence) {
        insertEvidence.run(record.id, excerptId, AI_MEMORY_FIXED_NOW);
      }
    }
  });
  seed();

  const relationRecordIds = options.includeRelations ? seedAiMemoryRelations(deps) : [];
  const relationRecords = AI_MEMORY_FIXTURE_RELATIONS.filter((relation) => relationRecordIds.includes(relation.id));

  return {
    projectId: AI_MEMORY_PROJECT_ID,
    recordCount: AI_MEMORY_FIXTURE_RECORDS.length + relationRecords.length,
    acceptedCount: AI_MEMORY_FIXTURE_RECORDS.filter((record) => record.reviewStatus === "accepted").length + relationRecords.filter((record) => record.reviewStatus === "accepted").length,
    supersededCount: AI_MEMORY_FIXTURE_RECORDS.filter((record) => record.reviewStatus === "superseded").length,
    workingMemoryCount: AI_MEMORY_FIXTURE_RECORDS.filter((record) => record.reviewStatus === "proposed").length + relationRecords.filter((record) => record.reviewStatus === "proposed").length,
    evidenceLinkedRecordCount: AI_MEMORY_FIXTURE_RECORDS.filter((record) => record.hasEvidence).length + relationRecords.length,
    intentionallyUnbackedRecordIds: AI_MEMORY_FIXTURE_RECORDS.filter((record) => !record.hasEvidence).map((record) => record.id),
    relationRecordIds,
  };
}

/** Add only the structured relation layer after the lexical baseline is measured. */
export function seedAiMemoryRelations(deps: ServiceDeps): string[] {
  const insert = deps.sqlite.prepare(
    `INSERT INTO records
      (id, project_id, type, subject, predicate, value_json, text, review_status, evidence_basis,
       task_status, record_dedup_hash, recorded_at, source_event_at, effective_from, effective_to,
       reviewed_at, review_due_at, volatile, revision, created_at, updated_at)
     VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, NULL, 0, 1, ?, ?)`,
  );
  const insertEvidence = deps.sqlite.prepare(
    `INSERT INTO record_evidence
      (record_id, excerpt_id, relation, observed_at, environment, artifact_ref)
     VALUES (?, ?, 'supports', ?, 'synthetic-eval', NULL)`,
  );
  deps.sqlite.transaction(() => {
    for (const relation of AI_MEMORY_FIXTURE_RELATIONS) {
      const source = AI_MEMORY_FIXTURE_RECORDS.find((record) => record.id === relation.sourceRecordId);
      if (!source) throw new Error(`Missing relation source fixture: ${relation.sourceRecordId}`);
      const text = relationText(relation, source.text);
      const now = AI_MEMORY_FIXED_NOW;
      insert.run(
        relation.id,
        AI_MEMORY_PROJECT_ID,
        relation.subject,
        relation.relation,
        JSON.stringify({ object: relation.object }),
        text,
        relation.reviewStatus,
        relation.evidenceBasis,
        recordDedupHash({ projectId: AI_MEMORY_PROJECT_ID, type: "fact", subject: relation.subject, text }),
        now,
        now,
        relation.reviewStatus === "proposed" ? null : now,
        now,
        now,
      );
      insertEvidence.run(relation.id, `eval-excerpt-${relation.sourceRecordId}`, now);
    }
  })();
  return AI_MEMORY_FIXTURE_RELATIONS.map((relation) => relation.id);
}
