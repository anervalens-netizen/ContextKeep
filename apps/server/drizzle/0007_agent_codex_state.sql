CREATE TABLE `agent_codex_threads` (
  `agent_thread_id` text NOT NULL,
  `workspace_binding_id` text NOT NULL,
  `codex_thread_id` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  PRIMARY KEY (`agent_thread_id`, `workspace_binding_id`),
  FOREIGN KEY (`agent_thread_id`) REFERENCES `agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workspace_binding_id`) REFERENCES `workspace_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_codex_thread_id` ON `agent_codex_threads` (`codex_thread_id`);
--> statement-breakpoint
CREATE INDEX `ix_agent_codex_threads_workspace` ON `agent_codex_threads` (`workspace_binding_id`);
