// rebuildIndex by log replay (M2_DESIGN 2.7.14): board_tasks and board_task_needs are projections of
// the event log, so truncating them and folding every `task.*` event again reproduces them. It is the
// repair tool, the migration gate's backfill, and the oracle of AT-03.
import type { DatabaseSync } from 'node:sqlite'
import { foldTask, isTaskEventType, type FoldRoot } from './fold.ts'
import { replaceEdges, upsertRow, type TaskRow } from './row.ts'

export type RebuildResult = {
  tasks: number
  edges: number
  /** Events whose fold was a no-op: corruption in the log, skipped as the original's fold skips them. */
  skipped: { index: number; type: string; id: number | null }[]
}

type RootRow = { channel: string; thread: string; re: number | null }

/**
 * Truncates board_tasks and board_task_needs and replays the log into them. Runs inside the caller's
 * transaction (the store gate at open, TaskService.rebuildIndex); appends nothing. A row's
 * `root_deleted` is set by its root's `message.deleted`, which leaves `updated_index` (the index of
 * the task's last event) as it was.
 */
export function rebuildTaskIndexInTx(db: DatabaseSync): RebuildResult {
  db.exec('DELETE FROM board_tasks; DELETE FROM board_task_needs;')
  const rows = new Map<number, TaskRow>()
  const deleted = new Set<number>()
  const roots = new Map<number, RootRow | null>()
  const rootOf = (id: number): RootRow | null => {
    if (!roots.has(id)) {
      const r = db.prepare('SELECT channel, thread, re FROM board_messages WHERE id = ?').get(id) as
        | { channel: string; thread: string; re: number | null }
        | undefined
      roots.set(id, r ? { channel: r.channel, thread: r.thread, re: r.re === null ? null : Number(r.re) } : null)
    }
    return roots.get(id) ?? null
  }
  const skipped: RebuildResult['skipped'] = []
  const stmt = db.prepare(
    `SELECT log_index, type, payload_json FROM board_events
     WHERE session_id = 'board' AND (substr(type, 1, 5) = 'task.' OR type = 'message.deleted')
     ORDER BY log_index ASC`,
  )
  for (const ev of stmt.iterate() as Iterable<{ log_index: number; type: string; payload_json: string }>) {
    const index = Number(ev.log_index)
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>
    const id = typeof payload.id === 'number' ? payload.id : null
    if (ev.type === 'message.deleted') {
      if (id === null) continue
      deleted.add(id)
      const row = rows.get(id)
      if (row) row.root_deleted = 1
      continue
    }
    if (!isTaskEventType(ev.type) || id === null) {
      skipped.push({ index, type: ev.type, id })
      continue
    }
    const r = rootOf(id)
    if (!r) {
      skipped.push({ index, type: ev.type, id })
      continue
    }
    const root: FoldRoot = { id, channel: r.channel, thread: r.thread, re: r.re, deleted: deleted.has(id) }
    const next = foldTask(rows.get(id) ?? null, root, { type: ev.type, payload })
    if (next === false) {
      skipped.push({ index, type: ev.type, id })
      continue
    }
    if (ev.type === 'task.created') next.created_index = index
    next.updated_index = index
    rows.set(id, next)
  }
  let edges = 0
  for (const row of [...rows.values()].sort((a, b) => a.task_id - b.task_id)) {
    upsertRow(db, row)
    replaceEdges(db, row.task_id, row.needs)
    edges += row.needs.length
  }
  return { tasks: rows.size, edges, skipped }
}
