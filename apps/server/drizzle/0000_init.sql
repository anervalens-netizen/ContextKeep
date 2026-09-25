CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`timestamp` text NOT NULL,
	`before_ref` text,
	`after_ref` text,
	`detail_json` text,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `ix_audit_action` ON `audit_events` (`action`);--> statement-breakpoint
CREATE INDEX `ix_audit_timestamp` ON `audit_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `ix_audit_target` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`record_ids_json` text NOT NULL,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`resolution_record_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolution_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_conflicts_project` ON `conflicts` (`project_id`);--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	`source_revision` integer NOT NULL,
	`objective` text,
	`rendered_markdown` text NOT NULL,
	`included_record_ids_json` text NOT NULL,
	`truncation_notes_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`stage` text NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_version` text NOT NULL,
	`provider_model` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`usage_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_import_jobs_source` ON `import_jobs` (`source_id`);--> statement-breakpoint
CREATE TABLE `owner_credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`parent_project_id` text,
	`description` text,
	`lifecycle` text DEFAULT 'unknown' NOT NULL,
	`lifecycle_record_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lifecycle_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_projects_name` ON `projects` (`name`);--> statement-breakpoint
CREATE INDEX `ix_projects_parent` ON `projects` (`parent_project_id`);--> statement-breakpoint
CREATE TABLE `record_evidence` (
	`record_id` text NOT NULL,
	`excerpt_id` text NOT NULL,
	`relation` text DEFAULT 'supports' NOT NULL,
	`observed_at` text,
	`environment` text,
	`artifact_ref` text,
	PRIMARY KEY(`record_id`, `excerpt_id`),
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`excerpt_id`) REFERENCES `source_excerpts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`subject` text NOT NULL,
	`predicate` text,
	`value_json` text,
	`text` text NOT NULL,
	`review_status` text DEFAULT 'proposed' NOT NULL,
	`evidence_basis` text NOT NULL,
	`task_status` text,
	`record_dedup_hash` text NOT NULL,
	`recorded_at` text NOT NULL,
	`source_event_at` text,
	`effective_from` text,
	`effective_to` text,
	`reviewed_at` text,
	`review_due_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_records_project_status` ON `records` (`project_id`,`review_status`);--> statement-breakpoint
CREATE INDEX `ix_records_status` ON `records` (`review_status`);--> statement-breakpoint
CREATE INDEX `ix_records_recorded` ON `records` (`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accepted_lifecycle_per_project` ON `records` (`project_id`) WHERE type = 'fact' AND predicate = 'lifecycle' AND review_status = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX `uq_accepted_structured_claim` ON `records` (`project_id`,`subject`,`predicate`) WHERE review_status = 'accepted' AND predicate IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_record_dedupe` ON `records` (`project_id`,`record_dedup_hash`) WHERE review_status IN ('proposed', 'accepted');--> statement-breakpoint
CREATE TABLE `schema_version` (
	`version` integer PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL,
	`app_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `source_excerpts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`exact_text` text NOT NULL,
	`exact_text_hash` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_excerpts_source` ON `source_excerpts` (`source_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`original_filename` text,
	`content_hash` text NOT NULL,
	`normalized_hash` text NOT NULL,
	`imported_at` text NOT NULL,
	`event_at` text,
	`author_label` text,
	`provenance_basis` text NOT NULL,
	`project_id` text,
	`original_text` text NOT NULL,
	`normalized_text` text NOT NULL,
	`redaction_state` text DEFAULT 'none' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sources_content_hash` ON `sources` (`content_hash`);--> statement-breakpoint
CREATE INDEX `ix_sources_project` ON `sources` (`project_id`);--> statement-breakpoint
CREATE TABLE `supersessions` (
	`id` text PRIMARY KEY NOT NULL,
	`prior_record_id` text NOT NULL,
	`replacement_record_id` text NOT NULL,
	`job_id` text,
	`reason` text NOT NULL,
	`confirmed_at` text,
	`confirmed_by` text,
	`proposed_at` text NOT NULL,
	FOREIGN KEY (`prior_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replacement_record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_supersession_pair` ON `supersessions` (`prior_record_id`,`replacement_record_id`);--> statement-breakpoint
CREATE INDEX `ix_supersessions_job` ON `supersessions` (`job_id`);--> statement-breakpoint
-- A18 (handoff §7/§13): the DATABASE rejects supersession cycles.
-- A cycle exists when the replacement record already transitively supersedes
-- the prior record (forward reachability prior_record_id -> replacement_record_id),
-- including direct self-supersession (prior == replacement).
CREATE TRIGGER no_supersession_cycle_insert
BEFORE INSERT ON supersessions
BEGIN
  SELECT RAISE(ABORT, 'supersession cycle detected (A18)')
  WHERE EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.replacement_record_id
      UNION ALL
      SELECT s.replacement_record_id FROM supersessions s JOIN reach r ON s.prior_record_id = r.id
    )
    SELECT 1 FROM reach WHERE id = NEW.prior_record_id
  );
END;
--> statement-breakpoint
CREATE TRIGGER no_supersession_cycle_update
BEFORE UPDATE OF prior_record_id, replacement_record_id ON supersessions
BEGIN
  SELECT RAISE(ABORT, 'supersession cycle detected (A18)')
  WHERE EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.replacement_record_id
      UNION ALL
      SELECT s.replacement_record_id FROM supersessions s JOIN reach r ON s.prior_record_id = r.id
      WHERE s.id != NEW.id
    )
    SELECT 1 FROM reach WHERE id = NEW.prior_record_id
  );
END;
