// Promotion (M2_DESIGN 2.7.7): the dependents a completion readies, found through the reverse needs
// index instead of the original's scan of every waiting root (server/tasks.ts:382-408). Same set, same
// order: oldest first.
import type { DatabaseSync } from 'node:sqlite'
import type { PlannedTaskEvent } from './host.ts'

/**
 * `task.ready` for each waiting task that waits for `completedId` and for nothing else that hasn't
 * completed. Runs before the completion is written, while `completedId` is still claimed in
 * board_tasks, so it names that one satisfied explicitly (the original's `but`). A prerequisite with
 * no index row is no completed task, as the original reads a missing one.
 */
export function promote(db: DatabaseSync, completedId: number): PlannedTaskEvent[] {
  const rows = db
    .prepare(
      `SELECT t.task_id, t.thread FROM board_task_needs n JOIN board_tasks t ON t.task_id = n.task_id
       WHERE n.need_id = ? AND n.cond = 'completed' AND t.state = 'waiting'
         AND NOT EXISTS (
           SELECT 1 FROM board_task_needs n2 LEFT JOIN board_tasks t2 ON t2.task_id = n2.need_id
           WHERE n2.task_id = t.task_id AND n2.cond = 'completed' AND n2.need_id <> ?
             AND (t2.state IS NULL OR t2.state <> 'completed'))
       ORDER BY t.task_id ASC`,
    )
    .all(completedId, completedId) as Array<{ task_id: number; thread: string }>
  return rows.map((r) => ({
    type: 'task.ready',
    taskId: Number(r.task_id),
    payload: { id: Number(r.task_id), thread: r.thread },
  }))
}
