import type { ServiceDeps } from './import.js';
import { ApiError } from '../lib/errors.js';

export interface TaskScope {
  id: string;
  projectId: string;
  subject: string;
  text: string;
  revision: number;
  taskStatus: string | null;
  reviewStatus: 'accepted' | 'proposed';
}

/** Tasks reuse action record identities; sessions are not task identifiers. */
export function requireTaskScope(
  deps: Pick<ServiceDeps, 'sqlite'>,
  projectId: string,
  taskId: string,
): TaskScope {
  const row = deps.sqlite.prepare(`
    SELECT id, project_id AS projectId, type, subject, text, revision,
           task_status AS taskStatus, review_status AS reviewStatus
    FROM records WHERE id = ?
  `).get(taskId) as (TaskScope & { type: string }) | undefined;
  if (!row) throw new ApiError(404, 'task_not_found', 'Task action record was not found.');
  if (row.projectId !== projectId)
    throw new ApiError(409, 'task_project_mismatch', 'Task belongs to a different project.');
  if (row.type !== 'action')
    throw new ApiError(400, 'task_requires_action', 'Task identity must refer to an action record.');
  if (!['accepted', 'proposed'].includes(row.reviewStatus))
    throw new ApiError(409, 'task_not_current', 'Task action record is not current.');
  const { type: _type, ...task } = row;
  return task;
}
