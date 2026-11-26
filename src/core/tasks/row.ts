// The task index row (board_tasks + board_task_needs) and its public view (M2_DESIGN 2.3).
// Everything in a TaskRow is derivable from the event log: rebuildIndex replays it through foldTask.
import type { DatabaseSync } from 'node:sqlite'
import type { TaskState, TaskView } from '../schemas.ts'

export const TASK_STATES: readonly TaskState[] = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']

/** One board_tasks row. Everything here is derivable from the event log (rebuildIndex). */
export interface TaskRow {
  /** The root message ID = log index of its message.posted. */
  task_id: number
  channel: string
  thread: string
  state: TaskState
  /** The principal that made the thread a task. */
  owner: string
  /** The actor it did so as (the principal itself or one of its profiles). */
  by_actor: string
  /** The assignee (<owner>+<profile>), or null. */
  for_actor: string | null
  /** First-appearance order, deduplicated (mirrored to board_task_needs). */
  needs: number[]
  /** Number of claims; 0 at birth. */
  epoch: number
  claim_actor: string | null
  claim_until_ms: number | null
  /** sha256 hex of the claim's secret; never in StoredMessage.task, board_versions or any view. */
  claim_token_hash: string | null
  blocked_kind: string | null
  blocked_reason: string | null
  result: string | null
  reason: string | null
  /** Reserved; always 0 in slice A. */
  priority: number
  /** Reserved for defer (slice B); always null in slice A. */
  claim_after_ms: number | null
  /** Count of task.expired events for this task. */
  expirations: number
  root_deleted: 0 | 1
  created_index: number
  updated_index: number
}

/** finished = completed, failed or canceled (original tasks.ts:84). */
export const isFinished = (state: TaskState): boolean =>
  state === 'completed' || state === 'failed' || state === 'canceled'

/** terminal = completed or canceled: what cancel and reopen refuse (original tasks.ts:766, :816). */
export const isTerminal = (state: TaskState): boolean => state === 'completed' || state === 'canceled'

/** A claim whose lease has run out. Never stored (original tasks.ts:78). */
export const isLapsed = (row: Pick<TaskRow, 'state' | 'claim_until_ms'>, nowMs: number): boolean =>
  row.state === 'claimed' && row.claim_until_ms !== null && row.claim_until_ms <= nowMs

/** The state as claims, lists and fences take it: a lapsed claim reads `ready` (original tasks.ts:81). */
export const stateNow = (row: Pick<TaskRow, 'state' | 'claim_until_ms'>, nowMs: number): TaskState =>
  isLapsed(row, nowMs) ? 'ready' : row.state

export const isoOf = (ms: number): string => new Date(ms).toISOString()

/**
 * The public view of a task, as StoredMessage.task carries it and the original's taskView renders it
 * (original server/feed.ts:118-126): needs as decimal refs, the claim without its token.
 */
export function toTaskView(row: TaskRow): TaskView {
  return {
    state: row.state,
    owner: row.owner,
    by: row.by_actor,
    for: row.for_actor,
    needs: row.needs.map((n) => String(n)),
    epoch: row.epoch,
    claim:
      row.claim_actor !== null && row.claim_until_ms !== null
        ? { actor: row.claim_actor, until: isoOf(row.claim_until_ms) }
        : null,
    blocked: row.blocked_reason !== null ? { kind: row.blocked_kind, reason: row.blocked_reason } : null,
    result: row.result,
    reason: row.reason,
  }
}

export const cloneRow = (row: TaskRow): TaskRow => ({ ...row, needs: [...row.needs] })

type DbTaskRow = Omit<TaskRow, 'needs'>

const ROW_COLUMNS = [
  'task_id',
  'channel',
  'thread',
  'state',
  'owner',
  'by_actor',
  'for_actor',
  'epoch',
  'claim_actor',
  'claim_until_ms',
  'claim_token_hash',
  'blocked_kind',
  'blocked_reason',
  'result',
  'reason',
  'priority',
  'claim_after_ms',
  'expirations',
  'root_deleted',
  'created_index',
  'updated_index',
] as const satisfies readonly (keyof DbTaskRow)[]

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function fromDb(r: Record<string, unknown>, needs: number[]): TaskRow {
  return {
    task_id: Number(r.task_id),
    channel: String(r.channel),
    thread: String(r.thread),
    state: r.state as TaskState,
    owner: String(r.owner),
    by_actor: String(r.by_actor),
    for_actor: (r.for_actor as string | null) ?? null,
    needs,
    epoch: Number(r.epoch),
    claim_actor: (r.claim_actor as string | null) ?? null,
    claim_until_ms: numOrNull(r.claim_until_ms),
    claim_token_hash: (r.claim_token_hash as string | null) ?? null,
    blocked_kind: (r.blocked_kind as string | null) ?? null,
    blocked_reason: (r.blocked_reason as string | null) ?? null,
    result: (r.result as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    priority: Number(r.priority),
    claim_after_ms: numOrNull(r.claim_after_ms),
    expirations: Number(r.expirations),
    root_deleted: Number(r.root_deleted) === 1 ? 1 : 0,
    created_index: Number(r.created_index),
    updated_index: Number(r.updated_index),
  }
}

/** The needs of a task, in their stored order. */
export function loadNeeds(db: DatabaseSync, taskId: number): number[] {
  const rows = db
    .prepare('SELECT need_id FROM board_task_needs WHERE task_id = ? ORDER BY pos ASC')
    .all(taskId) as Array<{ need_id: number }>
  return rows.map((r) => Number(r.need_id))
}

/** One board_tasks row with its needs, or null when the ID is not a task. */
export function loadRow(db: DatabaseSync, taskId: number): TaskRow | null {
  const r = db.prepare(`SELECT ${ROW_COLUMNS.join(', ')} FROM board_tasks WHERE task_id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined
  return r ? fromDb(r, loadNeeds(db, taskId)) : null
}

/** Every board_tasks row, ordered by task_id, with needs. For rebuild checks and tests. */
export function loadAllRows(db: DatabaseSync): TaskRow[] {
  const rows = db.prepare(`SELECT ${ROW_COLUMNS.join(', ')} FROM board_tasks ORDER BY task_id ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => fromDb(r, loadNeeds(db, Number(r.task_id))))
}

/** Writes one row (insert or full replace). Needs go through replaceEdges. */
export function upsertRow(db: DatabaseSync, row: TaskRow): void {
  const cols = ROW_COLUMNS.join(', ')
  const marks = ROW_COLUMNS.map(() => '?').join(', ')
  const updates = ROW_COLUMNS.filter((c) => c !== 'task_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  db.prepare(`INSERT INTO board_tasks (${cols}) VALUES (${marks}) ON CONFLICT(task_id) DO UPDATE SET ${updates}`).run(
    ...ROW_COLUMNS.map((c) => row[c]),
  )
}

/** Replaces a task's needs edges with `needs`, in order, first appearance kept. Slice A writes cond 'completed' only. */
export function replaceEdges(db: DatabaseSync, taskId: number, needs: readonly number[]): void {
  db.prepare('DELETE FROM board_task_needs WHERE task_id = ?').run(taskId)
  if (needs.length === 0) return
  const stmt = db.prepare("INSERT OR IGNORE INTO board_task_needs (task_id, need_id, pos, cond) VALUES (?, ?, ?, 'completed')")
  needs.forEach((need, pos) => {
    stmt.run(taskId, need, pos)
  })
}
