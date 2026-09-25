import { z } from "zod";
import { LifecycleState, ProjectDto, RecordDto, RecordType, RelationKind, ReviewResultDto, SupersessionDto, TaskStatus } from "@contextkeep/shared";
import { editRecord } from "../services/review.js";
import { getCorrectionState, confirmCorrection } from "../services/corrections.js";
import { createProject, updateProject, setProjectLifecycle, createRecord, reviewRecords,
  deleteRecord, restoreRecord, requireProject, requireRecord, deletionReceipt } from "../services/memory-management.js";
import { listRecords, listSources, readSource, pageResult } from "./reads.js";
import { ApiError } from "../lib/errors.js";
import type { ServiceDeps, ActorCtx } from "../services/import.js";
import { createRelation, searchRelations } from "../services/relations.js";

export type DefineTool = <S extends z.ZodType>(name: string, description: string, schema: S,
  readOnly: boolean, run: (input: z.output<S>) => unknown | Promise<unknown>, contract: z.ZodType) => void;
const Id = z.string().uuid();
const Key = z.string().uuid().describe("One UUID per intended write. Reuse the same UUID and arguments on retry.");
const Revision = z.number().int().min(1).describe("Current revision returned by the corresponding read tool.");
const Identity = { clientId:z.string().trim().min(1).max(80).optional(), sessionId:z.string().trim().min(1).max(160).optional() };
const Page = {offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(50).default(20)};
const ProjectFields = {name:z.string().trim().min(1).max(200),aliases:z.array(z.string().max(200)).max(50),
  description:z.string().max(4000).nullable(),parentId:Id.nullable()};

const PagedResult = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  nextOffset: z.number().int().min(0).nullable(),
}).passthrough();

const ListRecordsResult = PagedResult.extend({ projectId: Id }).passthrough();

const SourceReadResult = z.object({
  id: Id,
  projectId: Id.nullable(),
  projectIds: z.array(Id),
  title: z.string().nullable(),
  kind: z.string(),
  eventAt: z.string().nullable(),
  authorLabel: z.string().nullable(),
  provenanceBasis: z.string(),
  text: z.string(),
  totalChars: z.number().int().min(0),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
  excerpts: z.array(z.object({
    id: Id,
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    text: z.string(),
    textTruncated: z.union([z.boolean(), z.number().int()]),
  }).passthrough()),
  excerptTotal: z.number().int().min(0),
  excerptNextOffset: z.number().int().min(0).nullable(),
  canonicalTruth: z.literal(false),
}).passthrough();

const CreateRecordResult = z.object({
  record: RecordDto,
  duplicate: z.boolean(),
}).passthrough();

const CorrectionConfirmResult = z.object({
  jobId: Id,
  acceptedRecordIds: z.array(Id),
  supersededRecordIds: z.array(Id),
  confirmedSupersessionIds: z.array(Id),
}).passthrough();

const CorrectionStateResult = z.object({
  jobId: Id,
  stage: z.string(),
  supersessions: z.array(SupersessionDto),
  proposedRecords: z.array(RecordDto),
}).passthrough();

const DeleteRecordResult = z.object({
  recordId: Id,
  revision: z.number().int().min(1),
  deleted: z.literal(true),
  recoverable: z.literal(true),
  deletionId: Id,
}).passthrough();

const RestoreRecordResult = z.object({
  record: RecordDto,
  restored: z.literal(true),
}).passthrough();

const HandoffReadResult = z.object({
  id: Id,
  projectId: Id,
  createdAt: z.string(),
  objective: z.string().nullable(),
  sourceRevision: z.number().int().min(1),
  sourceContentVersion: z.number().int().min(0),
  markdown: z.string(),
  totalChars: z.number().int().min(0),
  offset: z.number().int().min(0),
  nextOffset: z.number().int().min(0).nullable(),
}).passthrough();

export function registerManagementTools(define: DefineTool, deps: ServiceDeps, actorFor: (input: { clientId?: string; sessionId?: string; idempotencyKey: string }) => ActorCtx) {
  define("create_project","Create a project with metadata; initial lifecycle is unknown. Use set_project_lifecycle to activate or retire it.",
    z.strictObject({name:ProjectFields.name,aliases:ProjectFields.aliases.default([]),description:ProjectFields.description.default(null),
      parentId:ProjectFields.parentId.default(null),...Identity,idempotencyKey:Key}),false,input=>createProject(deps,input,actorFor(input)),ProjectDto);
  define("update_project","Update project name, aliases, description or parent. Requires current revision; parent cycles are rejected.",
    z.strictObject({projectId:Id,revision:Revision,name:ProjectFields.name.optional(),aliases:ProjectFields.aliases.optional(),
      description:ProjectFields.description.optional(),parentId:ProjectFields.parentId.optional(),...Identity,idempotencyKey:Key}),false,input=>updateProject(deps,input,actorFor(input)),ProjectDto);
  define("set_project_lifecycle","Apply an owner-requested lifecycle transition, including retirement/reactivation, using canonical correction and evidence. Preserves all project data.",
    z.strictObject({projectId:Id,revision:Revision,state:LifecycleState,reason:z.string().trim().min(1).max(4000),...Identity,idempotencyKey:Key}),false,
    input=>setProjectLifecycle(deps,input,actorFor(input)),CorrectionConfirmResult);
  define("list_records","List records by project, review state, type or task status. Default accepted; proposed is the review inbox, rejected includes recoverably deleted records with deletionId. Limit 1–50.",
    z.strictObject({projectId:Id,reviewStatus:z.enum(["accepted","proposed","rejected","superseded","all"]).default("accepted"),
      recordType:RecordType.optional(),taskStatus:TaskStatus.optional(),...Page}),true,input=>listRecords(deps,input),ListRecordsResult);
  define("list_sources","List source metadata in a project, newest first. Sources are evidence, not automatically accepted truth. Limit 1–50.",
    z.strictObject({projectId:Id,...Page}),true,input=>listSources(deps,input),PagedResult);
  define("get_source","Read source text in character pages and its excerpt IDs. Text maxChars 1–20000; excerpts 1–10, each capped at 4000 characters. Use excerpt IDs to create evidence-linked proposals.",
    z.strictObject({sourceId:Id,offset:z.number().int().min(0).default(0),maxChars:z.number().int().min(1).max(20000).default(6000),
      excerptOffset:z.number().int().min(0).default(0),excerptLimit:z.number().int().min(1).max(10).default(5)}),true,input=>readSource(deps,input),SourceReadResult);
  define("search_relations","Search bounded evidence-backed relation records inside one project. Canonical accepted and proposed working relations are returned separately; scope=all never blends them. q is optional and uses generic subject/object/text tokens only. Limit 1–15.",
    z.strictObject({ projectId: Id, q: z.string().trim().min(1).max(500).optional(), relation: RelationKind.optional(),
      direction: z.enum(["outgoing", "incoming", "both"]).default("both"), subject: z.string().trim().min(1).max(400).optional(),
      object: z.string().trim().min(1).max(400).optional(), includeHistorical: z.boolean().default(false),
      scope: z.enum(["canonical", "working", "all"]).default("canonical"), limit: z.number().int().min(1).max(15).default(10) }), true,
    input => searchRelations(deps, input),
    z.object({ projectId: z.string(), scope: z.string(), canonicalRelations: z.array(z.unknown()), workingRelations: z.array(z.unknown()), relations: z.array(z.unknown()) }).passthrough());
  define("create_relation","Create one evidence-linked proposed fact relation. Relation kinds are exactly depends_on, blocks, affects or runs_on. It always remains proposed until review_records accepts it; it never fabricates owner authority.",
    z.strictObject({ projectId: Id, sourceExcerptId: Id, subject: z.string().trim().min(1).max(400), relation: RelationKind,
      object: z.string().trim().min(1).max(400), evidenceBasis: z.enum(["agent_report","document","observed_technical"]).default("agent_report"), eventAt: z.string().datetime().nullable().default(null),
      ...Identity, idempotencyKey: Key }), false,
    input => createRelation(deps, input, actorFor(input)),
    z.object({ relation: z.unknown(), record: z.unknown(), duplicate: z.boolean() }).passthrough());
  define("create_record","Create a proposed fact/decision/action/constraint/question linked to an existing source excerpt from the same project. Preserves agent/document/observed provenance. Use review_records to accept; never labels agent findings as owner declarations.",
    z.strictObject({projectId:Id,sourceExcerptId:Id,recordType:RecordType,subject:z.string().trim().min(1).max(400),
      text:z.string().trim().min(1).max(8000),evidenceBasis:z.enum(["agent_report","document","observed_technical"]).default("agent_report"),
      sourceEventAt:z.string().datetime().nullable().default(null),taskStatus:TaskStatus.nullable().default(null),
      volatile:z.boolean().default(false),...Identity,idempotencyKey:Key}),false,input=>createRecord(deps,input,actorFor(input)),CreateRecordResult);
  define("edit_record","Edit proposed content with current revision, or update taskStatus of an action. Accepted semantic changes use propose_correction + confirm_correction to retain history. Deleted records must be restored before editing.",
    z.strictObject({recordId:Id,revision:Revision,text:z.string().trim().min(1).max(8000).optional(),subject:z.string().trim().min(1).max(400).optional(),
      recordType:RecordType.optional(),taskStatus:TaskStatus.nullable().optional(),...Identity,idempotencyKey:Key}),false,input=>{
      const row=requireRecord(deps,input.recordId,input.revision);
      if(deletionReceipt(deps,row.id,row.revision))throw new ApiError(409,"record_deleted","Restore this record before editing.");
      if(input.taskStatus!==undefined && input.taskStatus!==null && (input.recordType??row.type)!=="action")
        throw new ApiError(400,"task_status_requires_action","Task status applies only to actions.");
      return editRecord(deps,input.recordId,{revision:input.revision,text:input.text,subject:input.subject,type:input.recordType,taskStatus:input.taskStatus},actorFor(input));
    },RecordDto);
  define("review_records","Accept/reject up to 100 proposed records with their current revisions, when authorized by the owner. Returns accepted/rejected/blocked IDs. Canonical evidence, precedence and retired-project checks remain enforced.",
    z.strictObject({items:z.array(z.strictObject({recordId:Id,revision:Revision})).min(1).max(100),action:z.enum(["accept","reject"]),
      ownerAction:z.boolean().default(false),...Identity,idempotencyKey:Key}),false,input=>reviewRecords(deps,input,actorFor(input)),ReviewResultDto);
  define("get_correction","Read canonical correction preview, proposed records and supersession links before confirmation.",
    z.strictObject({jobId:Id}),true,input=>getCorrectionState(deps,input.jobId),CorrectionStateResult);
  define("confirm_correction","Confirm an owner-authorized correction after inspecting get_correction. Canonical cross-project, lifecycle, precedence and stale-state checks apply.",
    z.strictObject({jobId:Id,...Identity,idempotencyKey:Key}),false,input=>confirmCorrection(deps,input.jobId,actorFor(input)),CorrectionConfirmResult);
  define("delete_record","Recoverably delete a record: remove it from current brief/search/timeline by marking it rejected, retain evidence and audited previous state. Returns deletionId for restore_record. Lifecycle records use set_project_lifecycle.",
    z.strictObject({recordId:Id,revision:Revision,reason:z.string().trim().min(1).max(1000),...Identity,idempotencyKey:Key}),false,input=>deleteRecord(deps,input,actorFor(input)),DeleteRecordResult);
  define("restore_record","Restore a recoverably deleted record using its deletionId and current revision. Refuses stale receipts or conflicts with newer accepted knowledge.",
    z.strictObject({recordId:Id,revision:Revision,deletionId:Id,ownerAction:z.boolean().default(false),...Identity,idempotencyKey:Key}),false,input=>restoreRecord(deps,input,actorFor(input)),RestoreRecordResult);
  define("list_handoffs","List saved portable handoffs for a project, newest first. Limit 1–50.",
    z.strictObject({projectId:Id,...Page}),true,input=>{
      requireProject(deps,input.projectId);
      const items=deps.sqlite.prepare("SELECT id,created_at AS createdAt,objective,source_revision AS sourceRevision,source_content_version AS sourceContentVersion FROM handoffs WHERE project_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(input.projectId,input.limit,input.offset);
      const total=(deps.sqlite.prepare("SELECT count(*) n FROM handoffs WHERE project_id=?").get(input.projectId) as {n:number}).n;
      return pageResult(items,total,input);
    },PagedResult);
  define("get_handoff","Read saved handoff text in character pages, maxChars 1–30000. A snapshot may be older than current project state.",
    z.strictObject({handoffId:Id,offset:z.number().int().min(0).default(0),maxChars:z.number().int().min(1).max(30000).default(12000)}),true,input=>{
      const row=deps.sqlite.prepare("SELECT id,project_id AS projectId,created_at AS createdAt,objective,source_revision AS sourceRevision,source_content_version AS sourceContentVersion,substr(rendered_markdown,?,?) AS markdown,length(rendered_markdown) AS totalChars FROM handoffs WHERE id=?").get(input.offset+1,input.maxChars,input.handoffId) as {totalChars:number}|undefined;
      if(!row)throw new ApiError(404,"handoff_not_found","Handoff not found.");
      return {...row,offset:input.offset,nextOffset:input.offset+input.maxChars<row.totalChars?input.offset+input.maxChars:null};
    },HandoffReadResult);
  define("get_audit","Read audit metadata for a project, record, source or import job. No session/credential snapshots are exposed. Limit 1–50.",
    z.strictObject({targetType:z.enum(["project","record","source","import_job"]),targetId:Id,...Page}),true,input=>{
      const items=deps.sqlite.prepare("SELECT id,actor,action,timestamp,target_type AS targetType,target_id AS targetId,substr(detail_json,1,4000) AS detail FROM audit_events WHERE target_type=? AND target_id=? ORDER BY timestamp DESC,id LIMIT ? OFFSET ?").all(input.targetType,input.targetId,input.limit,input.offset);
      const total=(deps.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE target_type=? AND target_id=?").get(input.targetType,input.targetId) as {n:number}).n;
      return pageResult(items,total,input);
    },PagedResult);
}
