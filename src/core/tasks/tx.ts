// The single writer (M2_DESIGN 2.7.1). Only this module mutates board_tasks, board_task_needs or
// StoredMessage.task, so the three projections of a task (the index row, the root's `task`, and its
// `board.task` label) move together, one event at a time, each at its own log index.
import { BoardError } from '../errors.ts'
import { TASK_LABEL } from '../schemas.ts'
import type { StoredMessage } from '../board-service.ts'
import type { StoredEvent } from '../storage.ts'
import { foldTask } from './fold.ts'
import type { PlannedTaskEvent, TaskHost } from './host.ts'
import { isoOf, loadRow, replaceEdges, toTaskView, upsertRow, type TaskRow } from './row.ts'

export type WriterHost = Pick<
  TaskHost,
  'store' | 'now' | 'loadMessage' | 'saveMessageInTx' | 'dispatchWatchersInTx' | 'notifyTaskAssignedInTx'
>

const FTS_STATES: ReadonlySet<string> = new Set(['task.created', 'task.completed', 'task.failed', 'task.canceled'])

/** A planned event the fold refuses: the whole transaction rolls back (FEI). */
export const foldRefused = (type: string, taskId: number, state: string | undefined): BoardError =>
  new BoardError(500, 'internal', `fold refused ${type} on #${taskId} at ${state ?? 'no task'}`)

const sameNeeds = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i])

/**
 * fts_tasks is written on create, on terminal transitions and on delete only (2.6, decision 15): a
 * task search reads live state by joining board_tasks. Its rowid is the task ID: task_id is an
 * UNINDEXED FTS5 column, so a delete by it would scan every row (AT-40 found one that made a
 * complete's cost grow with the board), while a delete by rowid is a lookup.
 */
export function syncFtsTaskInTx(host: Pick<TaskHost, 'store'>, row: TaskRow, msg: StoredMessage): void {
  const db = host.store.db
  db.prepare('DELETE FROM fts_tasks WHERE rowid = ?').run(row.task_id)
  if (msg.deleted || row.root_deleted === 1) return
  db.prepare('INSERT INTO fts_tasks (rowid, task_id, channel, state, body, result) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.task_id,
    String(row.task_id),
    row.channel,
    row.state,
    msg.text,
    row.result ?? '',
  )
}

/**
 * Marks a task's root deleted, after its `message.deleted` (the delete hook, slice A7). Leaves
 * `updated_index` as it is, as rebuildTaskIndexInTx does, and purges the task's search row.
 */
export function markRootDeletedInTx(host: Pick<TaskHost, 'store'>, taskId: number): void {
  const db = host.store.db
  db.prepare('UPDATE board_tasks SET root_deleted = 1 WHERE task_id = ?').run(taskId)
  db.prepare('DELETE FROM fts_tasks WHERE rowid = ?').run(taskId)
}

/**
 * Folds, appends and projects `planned`, in order, inside the caller's transaction. `root` and `row`
 * seed the task the call is about (either may be null, and are loaded when needed); an event about
 * another task (promotion, cascades) loads that one. Every event must fold: one that the ported fold
 * refuses throws 500 `internal` before anything of it is appended, and the throw rolls the caller's
 * whole transaction back (the fold-equivalence invariant). `root` is updated in place, so the caller's
 * view of it is the one the writes left.
 */
export function commitTaskEventsInTx(
  host: WriterHost,
  root: StoredMessage | null,
  row: TaskRow | null,
  planned: readonly PlannedTaskEvent[],
): StoredEvent[] {
  const db = host.store.db
  if (!db.isTransaction) throw new BoardError(500, 'internal', 'task events are written inside a transaction only')
  const cache = new Map<number, { msg: StoredMessage | null; row: TaskRow | null }>()
  if (root) cache.set(root.id, { msg: root, row: row ?? loadRow(db, root.id) })
  const at = (taskId: number): { msg: StoredMessage | null; row: TaskRow | null } => {
    let hit = cache.get(taskId)
    if (!hit) {
      hit = { msg: host.loadMessage(taskId), row: loadRow(db, taskId) }
      cache.set(taskId, hit)
    }
    return hit
  }
  const out: StoredEvent[] = []
  for (const p of planned) {
    const cur = at(p.taskId)
    const msg = cur.msg
    if (!msg) throw foldRefused(p.type, p.taskId, undefined)
    const next = foldTask(
      cur.row,
      { id: msg.id, channel: msg.channel, thread: msg.thread, re: msg.re, deleted: msg.deleted },
      { type: p.type, payload: p.payload },
    )
    // The root's own `task` counts too: a root that carries one is a task, whatever the index says.
    if (next === false || (p.type === 'task.created' && msg.task !== undefined)) {
      throw foldRefused(p.type, p.taskId, cur.row?.state)
    }
    const ev = host.store.appendEvent({
      ...(p.eventId !== undefined ? { id: p.eventId } : {}),
      type: p.type,
      channel: msg.channel,
      thread: msg.thread,
      payload: p.payload,
      createdAt: isoOf(host.now()),
    })
    if (p.type === 'task.created') next.created_index = ev.index
    next.updated_index = ev.index
    upsertRow(db, next)
    if (cur.row === null || !sameNeeds(cur.row.needs, next.needs)) replaceEdges(db, next.task_id, next.needs)
    msg.task = toTaskView(next)
    // A tombstone wears no labels, this one included (original folds.ts:236-240).
    if (!msg.deleted) msg.labels[TASK_LABEL] = next.state
    // Task events bump version, never revision (original folds.ts:96-101).
    msg.version = ev.index
    host.saveMessageInTx(msg, ev.index, false)
    if (FTS_STATES.has(p.type)) syncFtsTaskInTx(host, next, msg)
    host.dispatchWatchersInTx(ev, msg)
    if ((p.type === 'task.created' || p.type === 'task.assigned') && host.notifyTaskAssignedInTx) {
      host.notifyTaskAssignedInTx(ev, msg, next.for_actor)
    }
    cur.row = next
    out.push(ev)
  }
  return out
}
