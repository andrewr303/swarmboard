// The lease sweep (M2_DESIGN 2.7.11) and the root edit and delete hooks (2.7.12, ported from the
// original's server/writes.ts:786-808). The sweep selects lapsed claims outside the write lock, then
// expires them in chunks, one transaction a chunk, re-reading each row: it never expires a claim
// before `until <= now`, and skips one renewed, taken over or settled since it was selected.
import type { DatabaseSync } from 'node:sqlite'
import type { StoredMessage } from '../board-service.ts'
import { BoardError, normalizeError } from '../errors.ts'
import { EDITED_HOLD } from '../schemas.ts'
import type { StoredEvent } from '../storage.ts'
import { about, ownedBy } from './common.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf, type TaskOp } from './hooks.ts'
import { cloneRow, isTerminal, loadRow } from './row.ts'
import { commitTaskEventsInTx, markRootDeletedInTx } from './tx.ts'

export interface ExpireRun {
  expired: number[]
  /** Tasks a lapse hook turned into a hold or a failure. */
  held: number[]
  failed: { task: number; error: BoardError }[]
  nextDueMs: number | null
}

/** The earliest claim_until_ms of any claimed row, or null: lets a tick sleep exactly. */
export function nextLeaseDueMs(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MIN(claim_until_ms) AS due FROM board_tasks WHERE state = 'claimed'").get() as
    | { due: number | null }
    | undefined
  return row?.due === null || row?.due === undefined ? null : Number(row.due)
}

/**
 * Expire lapsed claims in chunks (2.7.11). A chunk that fails is run again one claim per transaction,
 * so only the claims that fail on their own are reported: one claim the sweep can never expire (a
 * lapse hook that throws or answers a bad hold) would otherwise sit at the head of the first chunk on
 * every run and keep the others in it from ever expiring.
 */
export function expireDueClaims(host: TaskHost, nowMs: number | undefined, opts: { limit?: number; chunk?: number } = {}): ExpireRun {
  const db = host.store.db
  const limit = opts.limit ?? 200
  const chunk = Math.max(1, opts.chunk ?? 25)
  const due = db
    .prepare(
      `SELECT task_id, epoch FROM board_tasks WHERE state = 'claimed' AND claim_until_ms <= ?
       ORDER BY claim_until_ms, task_id LIMIT ?`,
    )
    .all(nowMs ?? host.now(), limit) as Array<{ task_id: number; epoch: number }>
  const run: ExpireRun = { expired: [], held: [], failed: [], nextDueMs: null }
  for (let start = 0; start < due.length; start += chunk) {
    const part = due.slice(start, start + chunk)
    // A chunk that failed committed nothing: each of its claims gets its own transaction.
    if (!expireChunk(host, part, run)) for (const one of part) expireChunk(host, [one], run)
  }
  run.nextDueMs = nextLeaseDueMs(db)
  return run
}

/**
 * Expires `part` in one transaction (2.7.11), re-reading each row. True when it committed; a chunk of
 * one that throws is reported in `run.failed`, a larger one is left for the caller to split.
 */
function expireChunk(host: TaskHost, part: ReadonlyArray<{ task_id: number; epoch: number }>, run: ExpireRun): boolean {
  const db = host.store.db
  const hooks = hooksOf(host)
  const done: { id: number; held: boolean }[] = []
  try {
    // A system write: no caller, so no grants to re-check.
    hooks.around(host, () =>
      host.store.transaction(() => {
        done.length = 0
        for (const selected of part) {
          const id = Number(selected.task_id)
          const row = loadRow(db, id)
          const now = host.now()
          // Renewed, taken over, or settled since the select: not this sweep's.
          if (!row || row.state !== 'claimed' || row.epoch !== Number(selected.epoch) || row.claim_until_ms === null || row.claim_until_ms > now) {
            continue
          }
          const answer = hooks.lapse(host, row)
          const at = about(row)
          const events: PlannedTaskEvent[] = []
          if (answer.action === 'fail') {
            events.push({ type: 'task.failed', taskId: id, payload: { ...at, epoch: row.epoch, reason: answer.reason, by: host.systemAuthor() } })
          } else {
            events.push({ type: 'task.expired', taskId: id, payload: { ...at, epoch: row.epoch } })
            if (answer.action === 'hold') {
              if (!answer.kind.startsWith('org.')) {
                throw new BoardError(500, 'internal', `a lapse hold is the org layer's, org.*: got ${answer.kind}`)
              }
              events.push({
                type: 'task.blocked',
                taskId: id,
                payload: { ...at, kind: answer.kind, reason: answer.reason, by: host.systemAuthor() },
              })
            }
          }
          const planned = hooks.plan(host, { op: 'expire', caller: 'system', taskId: id, before: cloneRow(row), events })
          if (planned.length === 0) continue
          const appended = commitTaskEventsInTx(host, host.loadMessage(id), row, planned)
          hooks.applied(host, 'expire', 'system', appended)
          done.push({ id, held: answer.action !== 'expire' })
        }
      }),
    )
  } catch (error) {
    if (part.length > 1) return false
    run.failed.push({ task: Number(part[0]!.task_id), error: normalizeError(error) })
    return true
  }
  for (const d of done) (d.held ? run.held : run.expired).push(d.id)
  return true
}

/** Why a task is held once its root was edited by someone who doesn't own it (original writes.ts:786). */
const EDITED = 'its text was edited by someone who does not own the task'

/** Runs a root hook's events through the plan hooks and the single writer, inside the caller's write. */
function commitRootHook(host: TaskHost, op: TaskOp, caller: Identity, root: StoredMessage, events: PlannedTaskEvent[]): StoredEvent[] {
  const hooks = hooksOf(host)
  const row = loadRow(host.store.db, root.id)
  const planned = hooks.plan(host, { op, caller, taskId: root.id, before: row ? cloneRow(row) : null, events })
  if (planned.length === 0) return []
  const appended = commitTaskEventsInTx(host, root, row, planned)
  hooks.applied(host, op, caller, appended, { deferred: true })
  return appended
}

/**
 * After message.edited (original writes.ts:788-801 heldByEdit): a root edited by anyone but the task's
 * owner, or by a platform user even one its owner's own sync speaks for, holds a waiting, ready or
 * claimed task, which ends any claim. One that's held or finished stays as it is.
 */
export function onRootEditedInTx(host: TaskHost, root: StoredMessage, editor: Identity): void {
  const row = loadRow(host.store.db, root.id)
  if (!row || root.deleted || !root.task) return
  const external = editor.principal.kind === 'external' || editor.actor.kind === 'external'
  if (ownedBy(row, editor) && !external) return
  if (row.state !== 'waiting' && row.state !== 'ready' && row.state !== 'claimed') return
  commitRootHook(host, 'edit', editor, root, [
    { type: 'task.blocked', taskId: root.id, payload: { ...about(row), kind: EDITED_HOLD, reason: EDITED, by: editor.author } },
  ])
}

/**
 * Before message.deleted, while the root still wears its labels (original writes.ts:803-808
 * canceledByDelete): a task that hasn't completed or been canceled is canceled, reason `deleted`.
 */
export function onRootDeletingInTx(host: TaskHost, root: StoredMessage, deleter: Identity): void {
  const row = loadRow(host.store.db, root.id)
  if (!row || !root.task || isTerminal(row.state)) return
  commitRootHook(host, 'delete', deleter, root, [
    { type: 'task.canceled', taskId: root.id, payload: { ...about(row), reason: 'deleted', by: deleter.author } },
  ])
}

/** After message.deleted: the index row remembers its root is gone, and the task leaves search. */
export function onRootDeletedInTx(host: TaskHost, root: StoredMessage): void {
  if (loadRow(host.store.db, root.id)) markRootDeletedInTx(host, root.id)
}
