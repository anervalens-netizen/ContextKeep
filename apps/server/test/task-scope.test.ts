import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireTaskScope } from '../src/services/task-scope.js';

let sqlite: Database.Database;
let projectId: string;
let taskId: string;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE records (
    id TEXT PRIMARY KEY, project_id TEXT, type TEXT, subject TEXT,
    text TEXT, revision INTEGER, task_status TEXT, review_status TEXT
  )`);
  projectId = randomUUID();
  taskId = randomUUID();
  sqlite.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    taskId, projectId, 'action', 'Synthetic task', 'Inspect synthetic result',
    3, 'in_progress', 'accepted',
  );
});
afterEach(() => sqlite.close());

describe('task identity scope', () => {
  it('reuses an existing action ID without mutating its state', () => {
    const task = requireTaskScope({ sqlite }, projectId, taskId);
    expect(task).toEqual({
      id: taskId, projectId, subject: 'Synthetic task', text: 'Inspect synthetic result',
      revision: 3, taskStatus: 'in_progress', reviewStatus: 'accepted',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 });
  });

  it('keeps proposed action provenance proposed', () => {
    sqlite.prepare("UPDATE records SET review_status = 'proposed' WHERE id = ?").run(taskId);
    expect(requireTaskScope({ sqlite }, projectId, taskId).reviewStatus).toBe('proposed');
  });

  it('rejects action IDs from another project', () => {
    expect(() => requireTaskScope({ sqlite }, randomUUID(), taskId))
      .toThrow(expect.objectContaining({ code: 'task_project_mismatch' }));
  });

  it('rejects a fact used as a task', () => {
    sqlite.prepare("UPDATE records SET type = 'fact' WHERE id = ?").run(taskId);
    expect(() => requireTaskScope({ sqlite }, projectId, taskId))
      .toThrow(expect.objectContaining({ code: 'task_requires_action' }));
  });

  it.each(['rejected', 'superseded', 'deleted'])('rejects %s records', (status) => {
    sqlite.prepare('UPDATE records SET review_status = ? WHERE id = ?').run(status, taskId);
    expect(() => requireTaskScope({ sqlite }, projectId, taskId))
      .toThrow(expect.objectContaining({ code: 'task_not_current' }));
  });

  it('does not silently fall back to another task', () => {
    expect(() => requireTaskScope({ sqlite }, projectId, randomUUID()))
      .toThrow(expect.objectContaining({ code: 'task_not_found' }));
  });
});
