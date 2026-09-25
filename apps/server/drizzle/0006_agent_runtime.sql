CREATE TABLE `agent_threads` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text,
  `scope` text NOT NULL,
  `project_id` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `last_message_at` text,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_agent_threads_updated` ON `agent_threads` (`updated_at`);
--> statement-breakpoint
CREATE INDEX `ix_agent_threads_project` ON `agent_threads` (`project_id`);
--> statement-breakpoint
CREATE TABLE `agent_session_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `thread_id` text NOT NULL,
  `ordinal` integer NOT NULL,
  `item_json` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_session_item_ordinal` ON `agent_session_items` (`thread_id`,`ordinal`);
--> statement-breakpoint
CREATE INDEX `ix_agent_session_items_thread` ON `agent_session_items` (`thread_id`,`ordinal`);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `effort` text NOT NULL,
  `status` text NOT NULL,
  `usage_json` text,
  `error_code` text,
  `started_at` text NOT NULL,
  `completed_at` text,
  FOREIGN KEY (`thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_agent_runs_thread_started` ON `agent_runs` (`thread_id`,`started_at`);
--> statement-breakpoint
CREATE TABLE `agent_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `run_id` text NOT NULL,
  `seq` integer NOT NULL,
  `type` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_event_seq` ON `agent_events` (`run_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `ix_agent_events_run` ON `agent_events` (`run_id`,`seq`);
