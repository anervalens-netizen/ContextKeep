CREATE TABLE workflow_continuations (
 run_id TEXT NOT NULL REFERENCES workflow_runs(id),
 run_revision INTEGER NOT NULL,
 task_id TEXT NOT NULL REFERENCES records(id),
 consumer_id TEXT NOT NULL,
 token TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('claimed','completed')),
 lease_until TEXT NOT NULL,
 result_record_id TEXT REFERENCES records(id),
 result TEXT CHECK(result IN ('reported','needs_owner')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(run_id,run_revision)
);
--> statement-breakpoint
CREATE INDEX workflow_continuations_task ON workflow_continuations(task_id,updated_at DESC);
--> statement-breakpoint
CREATE INDEX workflow_task_records_record ON workflow_task_records(record_id,task_id);
