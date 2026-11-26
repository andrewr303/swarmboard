// Shared setup for the task verb tests (slices A2..A4): callers with narrowed grants, the error a
// call answers, and the board events a write appended.
import { expect } from 'vitest'
import {
  BoardError,
  createLocalCaller,
  normalizeError,
  type CallerContext,
  type MessageView,
  type TaskClaim,
} from '../../../src/core/index.ts'
import { alice, type Board } from './helpers.ts'

export const ALICE = alice.principal.id
export const BOB = 'local:user:bob'
export const bob = createLocalCaller({ userId: 'bob', handle: 'bob' })

/** Everything but manage, the way a sandbox's policy narrows a token. */
export const NO_MANAGE = '*=read,post,react,label'

/** One of alice's profiles; `can` narrows it (a profile shares alice's grants). */
export const aliceAs = (profile: string | null, can?: string): CallerContext =>
  createLocalCaller({ userId: 'alice', handle: 'alice', owner: true, profile, ...(can !== undefined ? { canHeader: can } : {}) })

export const userWith = (userId: string, can?: string): CallerContext =>
  createLocalCaller({ userId, handle: userId, ...(can !== undefined ? { canHeader: can } : {}) })

/** What a call answers when it is refused: [status, code, message]. Fails when it is not refused. */
export function refusal(fn: () => unknown): [number, string, string] {
  try {
    fn()
  } catch (error) {
    const e = normalizeError(error)
    return [e.status, e.code, e.message]
  }
  throw new Error('expected the call to be refused')
}

/** [status, code] of a refusal, or [200] when the call went through. */
export function outcome(fn: () => unknown): [number] | [number, string] {
  try {
    fn()
    return [200]
  } catch (error) {
    if (!(error instanceof BoardError)) throw error
    return [error.status, error.code]
  }
}

export const head = (b: Board): number =>
  Number((b.store.db.prepare('SELECT COALESCE(MAX(log_index), 0) AS h FROM board_events').get() as { h: number }).h)

export type LoggedEvent = { index: number; type: string; payload: Record<string, unknown> }

/** The board events after `after`, in log order. */
export function eventsAfter(b: Board, after: number): LoggedEvent[] {
  const rows = b.store.db
    .prepare('SELECT log_index, type, payload_json FROM board_events WHERE log_index > ? ORDER BY log_index ASC')
    .all(after) as Array<{ log_index: number; type: string; payload_json: string }>
  return rows.map((r) => ({ index: Number(r.log_index), type: r.type, payload: JSON.parse(r.payload_json) as Record<string, unknown> }))
}

/** The board events after `after` without the actor records a first write adds. */
export const taskEventsAfter = (b: Board, after: number): LoggedEvent[] =>
  eventsAfter(b, after).filter((e) => e.type !== 'actor.seen')

export const messageCount = (b: Board): number =>
  Number((b.store.db.prepare('SELECT COUNT(*) AS c FROM board_messages').get() as { c: number }).c)

/** A task in a new thread, by `caller`. */
export function makeTask(b: Board, caller: CallerContext, text: string, body: Record<string, unknown> = {}): MessageView {
  return b.board.tasks.createTask(caller, { channel: 'dev', text, ...body }).task
}

export function claimOf(b: Board, caller: CallerContext, id: string, body: Record<string, unknown> = {}): TaskClaim {
  return b.board.tasks.claimTask(caller, id, body).claim
}

/** Claims and completes task `id` as `caller`. */
export function finish(b: Board, caller: CallerContext, id: string, result?: string): MessageView {
  const claim = claimOf(b, caller, id)
  return b.board.tasks.completeTask(caller, id, { epoch: claim.epoch, token: claim.token, ...(result !== undefined ? { result } : {}) })
    .task
}

export const stateOf = (b: Board, id: string): string | undefined =>
  b.board.getMessageThread(alice, id).message.task?.state

export const taskOf = (b: Board, id: string): NonNullable<MessageView['task']> => {
  const task = b.board.getMessageThread(alice, id).message.task
  expect(task).toBeDefined()
  return task!
}

export const iso = (ms: number): string => new Date(ms).toISOString()
