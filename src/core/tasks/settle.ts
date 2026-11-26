// The fenced writes (M2_DESIGN 2.7.6): renew, release, complete and fail, by the claim's own proof and
// no label (original server/tasks.ts:697-725). A completion readies the tasks that waited only for it,
// in the same transaction (2.7.7).
import type { CallerContext } from '../board-service.ts'
import type { MessageView } from '../schemas.ts'
import { CompleteTaskBody, FailTaskBody, ReleaseTaskBody, RenewTaskBody, taskLimits } from './bodies.ts'
import { about, commitVerb, fenced, leaseMs, onTask, parseBody, shown } from './common.ts'
import type { PlannedTaskEvent, TaskHost } from './host.ts'
import { promote } from './promote.ts'
import { isoOf } from './row.ts'

/** POST /tasks/:id/renew: extends the claim's lease from now; it may shorten it. */
export function renewTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): { task: MessageView; until: string } {
  const body = parseBody(RenewTaskBody, raw)
  taskLimits.lease(body.lease)
  return onTask(host, caller, ref, (scope) => {
    fenced(scope.row, body, scope.now)
    const until = isoOf(scope.now + leaseMs(body.lease))
    commitVerb(scope, 'renew', [
      {
        type: 'task.renewed',
        taskId: scope.row.task_id,
        payload: { ...about(scope.row), epoch: body.epoch, until, by: scope.identity.author },
      },
    ])
    return { task: shown(scope), until }
  })
}

/** POST /tasks/:id/release: back to ready, for anyone who may claim it. */
export function releaseTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): { task: MessageView } {
  const body = parseBody(ReleaseTaskBody, raw)
  return onTask(host, caller, ref, (scope) => {
    fenced(scope.row, body, scope.now)
    commitVerb(scope, 'release', [
      { type: 'task.released', taskId: scope.row.task_id, payload: { ...about(scope.row), epoch: body.epoch, by: scope.identity.author } },
    ])
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/complete: completed, and `task.ready` for each dependent it was the last need of, oldest first. */
export function completeTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): { task: MessageView } {
  const body = parseBody(CompleteTaskBody, raw)
  taskLimits.note('result', body.result)
  return onTask(host, caller, ref, (scope) => {
    fenced(scope.row, body, scope.now)
    const id = scope.row.task_id
    const events: PlannedTaskEvent[] = [
      {
        type: 'task.completed',
        taskId: id,
        payload: { ...about(scope.row), epoch: body.epoch, by: scope.identity.author, result: body.result ?? null },
      },
    ]
    // Step 8a: after the plan hooks, promotion follows only a completion that remains.
    commitVerb(scope, 'complete', events, (planned) =>
      planned.some((e) => e.type === 'task.completed' && e.taskId === id) ? promote(host.store.db, id) : [],
    )
    return { task: shown(scope) }
  })
}

/** POST /tasks/:id/fail: failed, with its reason. What waits for it keeps waiting. */
export function failTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): { task: MessageView } {
  const body = parseBody(FailTaskBody, raw)
  taskLimits.note('reason', body.reason)
  return onTask(host, caller, ref, (scope) => {
    fenced(scope.row, body, scope.now)
    commitVerb(scope, 'fail', [
      {
        type: 'task.failed',
        taskId: scope.row.task_id,
        payload: { ...about(scope.row), epoch: body.epoch, by: scope.identity.author, reason: body.reason },
      },
    ])
    return { task: shown(scope) }
  })
}
