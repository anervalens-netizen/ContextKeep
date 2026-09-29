CREATE TABLE workflow_task_records (
 task_id TEXT NOT NULL REFERENCES records(id),
 record_id TEXT NOT NULL REFERENCES records(id),
 PRIMARY KEY(task_id,record_id)
);
--> statement-breakpoint
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL REFERENCES records(id),
 operation_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 device TEXT NOT NULL,
 identity TEXT NOT NULL,
 external_job_id TEXT,
 status TEXT NOT NULL DEFAULT 'reserved',
 revision INTEGER NOT NULL DEFAULT 1,
 lease_token TEXT,
 lease_until TEXT,
 criteria_json TEXT NOT NULL,
 verification TEXT NOT NULL DEFAULT 'pending',
 verification_record_id TEXT REFERENCES records(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,task_id,operation_key)
);
--> statement-breakpoint
CREATE TABLE workflow_observations (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES workflow_runs(id),
 event_key TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 status TEXT NOT NULL,
 exit_code INTEGER,
 observed_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 UNIQUE(run_id,event_key)
);
--> statement-breakpoint
CREATE INDEX workflow_runs_task ON workflow_runs(task_id,created_at DESC);

--> statement-breakpoint
CREATE TABLE workflow_subscriptions (
 id TEXT PRIMARY KEY, principal TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL REFERENCES records(id), url TEXT NOT NULL, secret TEXT NOT NULL,
 old_secret TEXT, rotation_until TEXT, expires_at TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 1, verified_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE workflow_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES records(id),
 run_id TEXT NOT NULL REFERENCES workflow_runs(id), payload TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE workflow_deliveries (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES workflow_events(id),
 subscription_id TEXT NOT NULL REFERENCES workflow_subscriptions(id), status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, lease_token TEXT, lease_until TEXT,
 http_status INTEGER, UNIQUE(event_id,subscription_id)
);
--> statement-breakpoint
CREATE INDEX workflow_deliveries_due ON workflow_deliveries(status,next_at);
