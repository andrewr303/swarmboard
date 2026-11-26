// The owner verbs (M2_DESIGN 2.7.8, 2.7.9): block, unblock, cancel, reopen, assign and set needs,
// ported from the original's server/tasks.ts:727-820. Each runs owns() (403 task_not_owned) before any
// 409; a hold with a claim's proof is the claim's, whoever owns the task.
import type { CallerContext } from '../board-service.ts'
import type { MessageView } from '../schemas.ts'
import { AssignTaskBody, BlockTaskBody, CancelTaskBody, TaskNeedsBody, taskLimits } from './bodies.ts'
import { about, commitVerb, fenced, isoUntil, onTask, ownActor, owns, parseBody, shown, taskConflict } from './common.ts'
import type { PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf } from './hooks.ts'
import { acyclic, needsAt, satisfied } from './needs.ts'
import { isFinished, isLapsed, isTerminal, stateNow } from './row.ts'

type Answer = { task: MessageView }

/**
 * POST /tasks/:id/block: holds a task for a person. A claimed task's hold is its claim's (with
 * `epoch` and `token`), which it ends; otherwise its owner's, or manage's. A lapsed claim is no one's,
 * so its owner holds it, and task.blocked ends it.
 */
export function blockTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): Answer {
  const body = parseBody(BlockTaskBody, raw)
  taskLimits.note('reason', body.reason)
  taskLimits.kind(body.kind)
  hooksOf(host).checkKind(body.kind)
  const proof = body.epoch !== undefined && body.token !== undefined ? { epoch: body.epoch, token: body.token } : null
  return onTask(host, caller, ref, (scope) => {
    const { row, now } = scope
    if (proof) fenced(row, proof, now)
    else {
      owns(scope.access, scope.identity, row)
      const state = stateNow(row, now)
      if (state === 'claimed') throw taskConflict('task_claimed', `#${row.task_id} is claimed until ${isoUntil(row)}: only its claim holds it`)
      if (state === 'blocked') throw taskConflict('task_blocked', `#${row.task_id} is held already: ${row.blocked_reason ?? ''}`)
      if (isFinished(state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    }
    commitVerb(scope, 'block', [
      {
        type: 'task.blocked',
        taskId: row.task_id,
        payload: { ...about(row), kind: body.kind ?? null, reason: body.reason, by: scope.identity.author },
      },
    ])
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/unblock: back to ready, or to waiting while a need hasn't completed. One that isn't held is left as it is. */
export function unblockTask(host: TaskHost, caller: CallerContext, ref: string | number): Answer {
  return onTask(host, caller, ref, (scope) => {
    const { row } = scope
    owns(scope.access, scope.identity, row)
    if (isFinished(row.state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    if (row.state !== 'blocked') return { task: shown(scope) }
    // The fold puts a task that needs any back to waiting: what it needs may have completed while it was held.
    const ready = row.needs.length > 0 && satisfied(host.store.db, row.needs)
    const events: PlannedTaskEvent[] = [
      { type: 'task.unblocked', taskId: row.task_id, payload: { ...about(row), by: scope.identity.author } },
    ]
    if (ready) events.push({ type: 'task.ready', taskId: row.task_id, payload: about(row) })
    commitVerb(scope, 'unblock', events)
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/cancel: cancels a task that hasn't completed, ending any claim. What waits for it keeps waiting. */
export function cancelTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): Answer {
  const body = parseBody(CancelTaskBody, raw)
  taskLimits.note('reason', body.reason)
  return onTask(host, caller, ref, (scope) => {
    const { row } = scope
    owns(scope.access, scope.identity, row)
    if (isTerminal(row.state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    commitVerb(scope, 'cancel', [
      { type: 'task.canceled', taskId: row.task_id, payload: { ...about(row), reason: body.reason, by: scope.identity.author } },
    ])
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/reopen: a failed task ready again, in place, so what waits for it still does. One that's open is left as it is. */
export function reopenTask(host: TaskHost, caller: CallerContext, ref: string | number): Answer {
  return onTask(host, caller, ref, (scope) => {
    const { row } = scope
    owns(scope.access, scope.identity, row)
    if (isTerminal(row.state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    if (row.state === 'failed') {
      commitVerb(scope, 'reopen', [{ type: 'task.reopened', taskId: row.task_id, payload: { ...about(row), by: scope.identity.author } }])
    }
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/assign: one of its owner's profiles, or null for anyone who may claim it. A claim it has stays. */
export function assignTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): Answer {
  const body = parseBody(AssignTaskBody, raw)
  return onTask(host, caller, ref, (scope) => {
    const { row } = scope
    owns(scope.access, scope.identity, row)
    const assigned = ownActor(row.owner, body.for)
    if (isFinished(row.state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    if (row.for_actor !== assigned) {
      commitVerb(scope, 'assign', [
        { type: 'task.assigned', taskId: row.task_id, payload: { ...about(row), for: assigned, by: scope.identity.author } },
      ])
    }
    return { task: shown(scope) }
  })
}

/**
 * POST /tasks/:id/needs: replaces what a task waits for, while no one holds it and it isn't finished.
 * The refs are checked as a new task's are, and must leave it waiting for no task that waits for it.
 * A lapsed claim expires first, in the same write; a held task stays held; the same set changes nothing.
 */
export function setTaskNeeds(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): Answer {
  const body = parseBody(TaskNeedsBody, raw)
  taskLimits.needs(body.needs)
  return onTask(host, caller, ref, (scope) => {
    const { row, now, access } = scope
    const db = host.store.db
    owns(access, scope.identity, row)
    if (isFinished(row.state)) throw taskConflict('task_finished', `#${row.task_id} is ${row.state}`)
    const over = isLapsed(row, now)
    if (row.state === 'claimed' && !over) {
      throw taskConflict('task_claimed', `#${row.task_id} is claimed until ${isoUntil(row)}: what it needs changes once no one holds it`)
    }
    const next = needsAt(db, access, body.needs, row.task_id)
    if (next.ids.length === row.needs.length && next.ids.every((need) => row.needs.includes(need))) return { task: shown(scope) }
    acyclic(
      db,
      access,
      row.task_id,
      next.ids.filter((need) => !row.needs.includes(need)),
    )
    const at = about(row)
    const events: PlannedTaskEvent[] = []
    if (over) events.push({ type: 'task.expired', taskId: row.task_id, payload: { ...at, epoch: row.epoch } })
    events.push({ type: 'task.needs_changed', taskId: row.task_id, payload: { ...at, needs: next.ids, by: scope.identity.author } })
    if (next.ids.length > 0 && next.completed && row.state !== 'blocked') {
      events.push({ type: 'task.ready', taskId: row.task_id, payload: at })
    }
    commitVerb(scope, 'needs', events)
    return { task: shown(scope) }
  })
}
