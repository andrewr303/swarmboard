// Claim by ID (M2_DESIGN 2.7.5), ported from the original's server/tasks.ts:274-299 and :661-681:
// `label` in the task's channel, whoever owns it; with the live claim's own token it answers that claim
// and writes nothing; a lapsed claim expires in the same write as the new one.
import type { CallerContext } from '../board-service.ts'
import type { MessageView, TaskClaim } from '../schemas.ts'
import { ClaimTaskBody, taskLimits } from './bodies.ts'
import {
  about,
  assignedTo,
  authorize,
  commitVerb,
  eqHash,
  hashOf,
  isoUntil,
  leaseMs,
  newToken,
  onTask,
  parseBody,
  refList,
  shown,
  taskConflict,
} from './common.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { isFinished, isLapsed, isoOf, type TaskRow } from './row.ts'

/** Refuses a claim of a task that can't be claimed now, by `identity` (original tasks.ts:275-282), in this order. */
export function claimable(row: TaskRow, identity: Identity, now: number): void {
  const id = row.task_id
  if (row.state === 'waiting') throw taskConflict('task_waiting', `#${id} waits for ${refList(row.needs)}`)
  if (row.state === 'blocked') throw taskConflict('task_blocked', `#${id} is held for a person: ${row.blocked_reason ?? ''}`)
  if (isFinished(row.state)) throw taskConflict('task_finished', `#${id} is ${row.state}`)
  // Even when the claim it has lapsed: an assigned task is its assignee's.
  if (row.for_actor !== null && !assignedTo(row, identity)) throw taskConflict('task_assigned', `#${id} is assigned to ${row.for_actor}`)
  if (row.state === 'claimed' && !isLapsed(row, now)) throw taskConflict('task_claimed', `#${id} is claimed until ${isoUntil(row)}`)
}

/**
 * A claim of a task as it stands, by `identity`: the events (a lapsed claim's expiry first), and what
 * the claim answers (original tasks.ts:288-299).
 */
export function claiming(
  row: TaskRow,
  identity: Identity,
  lease: number | undefined,
  secret: string,
  now: number,
): { events: PlannedTaskEvent[]; claim: TaskClaim } {
  const at = about(row)
  const epoch = row.epoch + 1
  const until = isoOf(now + leaseMs(lease))
  const events: PlannedTaskEvent[] = []
  if (row.state === 'claimed') events.push({ type: 'task.expired', taskId: row.task_id, payload: { ...at, epoch: row.epoch } })
  events.push({
    type: 'task.claimed',
    taskId: row.task_id,
    payload: { ...at, epoch, until, token: hashOf(secret), by: identity.author },
  })
  return { events, claim: { epoch, token: secret, until } }
}

/** POST /tasks/:id/claim. */
export function claimTask(host: TaskHost, caller: CallerContext, ref: string | number, raw: unknown): { task: MessageView; claim: TaskClaim } {
  const body = parseBody(ClaimTaskBody, raw) ?? {}
  taskLimits.lease(body.lease)
  return onTask(host, caller, ref, (scope) => {
    const { row, now, identity } = scope
    // A claim changes a task's state, which is what `label` gives.
    authorize(scope.access, 'label', row.channel)
    const sent = body.token
    if (sent !== undefined && row.state === 'claimed' && !isLapsed(row, now) && eqHash(sent, row.claim_token_hash)) {
      return { task: shown(scope), claim: { epoch: row.epoch, token: sent, until: isoUntil(row) } }
    }
    claimable(row, identity, now)
    const { events, claim } = claiming(row, identity, body.lease, sent ?? newToken(), now)
    commitVerb(scope, 'claim', events)
    return { task: shown(scope), claim }
  })
}
