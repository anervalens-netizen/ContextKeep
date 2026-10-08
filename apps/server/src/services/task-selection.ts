export type TaskSelection = "all_actions" | "actual_tasks";

/** Only the task end of a workflow relationship establishes task identity.
 * A record_id evidence end is protected by retention, but is not a task. */
export function taskSelectionPredicate(selection: TaskSelection): string {
  if (selection === "all_actions") return "1=1";
  const tables = [
    "workflow_task_records",
    "workflow_runs",
    "workflow_subscriptions",
    "workflow_events",
    "workflow_continuations",
  ];
  return (
    "(r.task_status IS NOT NULL OR " +
    tables
      .map(
        (table) =>
          `EXISTS(SELECT 1 FROM ${table} task_ref WHERE task_ref.task_id=r.id)`,
      )
      .join(" OR ") +
    ")"
  );
}
