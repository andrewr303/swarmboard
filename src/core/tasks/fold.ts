// The ported task fold: original contract/folds.ts:206-213 (`task.created`) and :244-325 (`foldTask`),
// transcribed onto TaskRow. It returns `false` exactly where the original's fold changes nothing, which
// is what the single writer's fold-equivalence invariant (FEI) checks every planned event against.
import { cloneRow, type TaskRow } from './row.ts'

/** What `task.created` reads of the root it lands on (original folds.ts:207-209). */
export type FoldRoot = {
  id: number
  channel: string
  thread: string
  re: number | null
  deleted: boolean
}

export type TaskEventLike = { type: string; payload: Record<string, unknown> }

export const TASK_EVENT_TYPES = [
  'task.created',
  'task.assigned',
  'task.needs_changed',
  'task.ready',
  'task.claimed',
  'task.renewed',
  'task.released',
  'task.expired',
  'task.completed',
  'task.failed',
  'task.blocked',
  'task.unblocked',
  'task.canceled',
  'task.reopened',
] as const
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number]

const TASK_EVENT_SET: ReadonlySet<string> = new Set(TASK_EVENT_TYPES)
export const isTaskEventType = (type: string): type is TaskEventType => TASK_EVENT_SET.has(type)

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

function authorOf(v: unknown): { actor: string; principal: string } | null {
  if (typeof v !== 'object' || v === null) return null
  const a = v as { actor?: unknown; principal?: unknown }
  return isStr(a.actor) && isStr(a.principal) ? { actor: a.actor, principal: a.principal } : null
}

/** needs as the payload carries them, first appearance kept; null when malformed. */
function needsOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || !v.every((n) => isInt(n) && n > 0)) return null
  return [...new Set(v as number[])]
}

/** A claim's write lands only while that claim holds it: claimed, at the same epoch (original folds.ts:245). */
const holds = (row: TaskRow, epoch: unknown): boolean => row.state === 'claimed' && isInt(epoch) && row.epoch === epoch

const clearClaim = (row: TaskRow): void => {
  row.claim_actor = null
  row.claim_until_ms = null
  row.claim_token_hash = null
}

/**
 * Applies one task event. `row` is the task before it (null when the root is no task yet), `root` the
 * message it lands on. Returns the task after it, a fresh row (the input is never changed), or `false`
 * where the original's fold would change nothing. `created_index` and `updated_index` are the
 * writer's to set once the event has its index; `expirations` counts every `task.expired` here, so a
 * replay of the log derives it.
 */
export function foldTask(row: TaskRow | null, root: FoldRoot, event: TaskEventLike): TaskRow | false {
  const p = event.payload
  if (event.type === 'task.created') {
    // A thread becomes a task once, at its root, while the root is there (original folds.ts:207-209).
    if (row !== null || root.deleted || root.re !== null) return false
    const needs = needsOf(p.needs)
    const by = authorOf(p.by)
    if (needs === null || by === null || !isStrOrNull(p.for)) return false
    return {
      task_id: root.id,
      channel: root.channel,
      thread: root.thread,
      state: needs.length > 0 ? 'waiting' : 'ready',
      owner: by.principal,
      by_actor: by.actor,
      for_actor: p.for,
      needs,
      epoch: 0,
      claim_actor: null,
      claim_until_ms: null,
      claim_token_hash: null,
      blocked_kind: null,
      blocked_reason: null,
      result: null,
      reason: null,
      priority: 0,
      claim_after_ms: null,
      expirations: 0,
      root_deleted: 0,
      created_index: 0,
      updated_index: 0,
    }
  }
  if (row === null) return false
  const t = cloneRow(row)
  switch (event.type) {
    case 'task.assigned':
      if (!isStrOrNull(p.for) || t.for_actor === p.for) return false
      t.for_actor = p.for
      return t
    case 'task.needs_changed': {
      // What it waits for changes while no one holds it and it isn't finished; one held for a person stays held.
      if (t.state !== 'waiting' && t.state !== 'ready' && t.state !== 'blocked') return false
      const needs = needsOf(p.needs)
      if (needs === null) return false
      t.needs = needs
      if (t.state !== 'blocked') t.state = t.needs.length > 0 ? 'waiting' : 'ready'
      return t
    }
    case 'task.ready':
      if (t.state !== 'waiting') return false
      t.state = 'ready'
      return t
    case 'task.claimed': {
      const by = authorOf(p.by)
      const until = isStr(p.until) ? Date.parse(p.until) : Number.NaN
      if (t.state !== 'ready' || !isInt(p.epoch) || p.epoch !== t.epoch + 1) return false
      if (by === null || !Number.isFinite(until) || !isStr(p.token)) return false
      t.state = 'claimed'
      t.epoch = p.epoch
      t.claim_actor = by.actor
      t.claim_until_ms = until
      t.claim_token_hash = p.token
      return t
    }
    case 'task.renewed': {
      const until = isStr(p.until) ? Date.parse(p.until) : Number.NaN
      if (!holds(t, p.epoch) || !Number.isFinite(until)) return false
      t.claim_until_ms = until
      return t
    }
    case 'task.released':
    case 'task.expired':
      if (!holds(t, p.epoch)) return false
      t.state = 'ready'
      clearClaim(t)
      if (event.type === 'task.expired') t.expirations += 1
      return t
    case 'task.completed':
      if (!holds(t, p.epoch) || !isStrOrNull(p.result ?? null)) return false
      t.state = 'completed'
      clearClaim(t)
      t.result = (p.result as string | null | undefined) ?? null
      return t
    case 'task.failed':
      if (!holds(t, p.epoch) || !isStr(p.reason)) return false
      t.state = 'failed'
      clearClaim(t)
      t.reason = p.reason
      return t
    case 'task.blocked':
      if (t.state !== 'waiting' && t.state !== 'ready' && t.state !== 'claimed') return false
      if (!isStr(p.reason) || !isStrOrNull(p.kind ?? null)) return false
      t.state = 'blocked'
      clearClaim(t)
      t.blocked_kind = (p.kind as string | null | undefined) ?? null
      t.blocked_reason = p.reason
      return t
    case 'task.unblocked':
      if (t.state !== 'blocked') return false
      // Back to waiting when it waits for any task: `task.ready` follows at once when they've all completed.
      t.state = t.needs.length > 0 ? 'waiting' : 'ready'
      t.blocked_kind = null
      t.blocked_reason = null
      return t
    case 'task.canceled':
      if (t.state === 'completed' || t.state === 'canceled') return false
      if (!isStr(p.reason)) return false
      t.state = 'canceled'
      clearClaim(t)
      t.blocked_kind = null
      t.blocked_reason = null
      t.reason = p.reason
      return t
    case 'task.reopened':
      // A failed task was claimed, so every task it needs had completed: it's ready.
      if (t.state !== 'failed') return false
      t.state = 'ready'
      t.reason = null
      return t
    default:
      return false
  }
}
