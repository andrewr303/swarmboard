// Create and adopt (M2_DESIGN 2.7.3): a new thread posted as a task through postMessageAs's taskRoot
// option, or a thread that's there made one. Ported from the original's a2.ts:634-653 createTask and
// server/tasks.ts:500-603 starting/adopt, with every check inside the write's one transaction.
import type { CallerContext, Mentioned } from '../board-service.ts'
import { badRequest, BoardError, duplicateId, textTooLong } from '../errors.ts'
import { ATTACHMENTS_PER_MESSAGE_MAX, MESSAGE_TEXT_MAX, type MessageView, type TaskClaim } from '../schemas.ts'
import { resolveMessageId } from '../social.ts'
import { CreateTaskBody, taskLimits, type CreateTaskInput } from './bodies.ts'
import {
  about,
  alongOf,
  authorize,
  eqHash,
  hashOf,
  isoUntil,
  leaseMs,
  messageNotFound,
  newToken,
  ownActor,
  parseBody,
  refList,
  taskConflict,
} from './common.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf } from './hooks.ts'
import { needsAt } from './needs.ts'
import { isoOf, loadRow } from './row.ts'
import { commitTaskEventsInTx } from './tx.ts'

export type CreatedTask = { task: MessageView; claim?: TaskClaim; mentions?: Mentioned[] }

/** The events that make root `root` a task (original tasks.ts:517-523): created, ready?, claimed?. */
function startingEvents(
  root: { id: number; thread: string },
  identity: Identity,
  plan: { needs: number[]; ready: boolean; assigned: string | null; claim: { secret: string; until: string } | null },
): PlannedTaskEvent[] {
  const at = about({ task_id: root.id, thread: root.thread })
  const events: PlannedTaskEvent[] = [
    { type: 'task.created', taskId: root.id, payload: { ...at, needs: plan.needs, for: plan.assigned, by: identity.author } },
  ]
  if (plan.ready) events.push({ type: 'task.ready', taskId: root.id, payload: at })
  if (plan.claim) {
    events.push({
      type: 'task.claimed',
      taskId: root.id,
      payload: { ...at, epoch: 1, until: plan.claim.until, token: hashOf(plan.claim.secret), by: identity.author },
    })
  }
  return events
}

/** POST /tasks: a new thread that is a task, or (with `re`) a thread that's there made one. */
export function createTask(host: TaskHost, caller: CallerContext, raw: unknown): CreatedTask {
  const body = parseBody(CreateTaskBody, raw)
  // A new thread's root is a message, within what this board holds of one, and a task within what it holds of those.
  if (body.re === undefined) {
    if ((body.text ?? '').length > MESSAGE_TEXT_MAX) throw textTooLong()
    if ((body.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) {
      throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
    }
  }
  taskLimits.needs(body.needs)
  taskLimits.lease(body.lease)
  const hooks = hooksOf(host)
  if (body.re !== undefined) {
    const ref = body.re
    return hooks.around(host, () => adopt(host, caller, ref, body))
  }
  try {
    return hooks.around(host, () => createRoot(host, caller, body))
  } catch (error) {
    // Two first creates with one id: under BEGIN IMMEDIATE the second sees the first's post and
    // replays it, so this is only a backstop for a loser at the UNIQUE event_id (2.7.3).
    if (body.id !== undefined && error instanceof BoardError && error.code === 'duplicate_id' && error.message.startsWith('duplicate event id:')) {
      return hooks.around(host, () => createRoot(host, caller, body))
    }
    throw error
  }
}

function createRoot(host: TaskHost, caller: CallerContext, body: CreateTaskInput): CreatedTask {
  const channel = body.channel!
  const { identity, access } = host.admit(caller)
  // A new thread, posted as any is: `post` where it lands, and `label` for the labels it carries.
  authorize(access, 'post', channel)
  if (Object.keys(body.labels ?? {}).length > 0) authorize(access, 'label', channel)
  if (body.id !== undefined) host.checkOwnId(identity.principal.id, body.id)
  const assigned = ownActor(identity.principal.id, body.for)
  // Claiming is what `label` gives, on a task made in the same write as on any other.
  if (body.claim) authorize(access, 'label', channel)
  const secret = body.token ?? newToken()
  const db = host.store.db
  const made: { plan?: { needs: number[]; ready: boolean; until: string }; replayed?: TaskClaim; shown?: MessageView } = {}
  const posted = host.postRoot(
    caller,
    {
      channel,
      text: body.text ?? '',
      ...(body.labels !== undefined ? { labels: body.labels } : {}),
      ...(body.noSync !== undefined ? { noSync: body.noSync } : {}),
      ...(body.attachments !== undefined ? { attachments: body.attachments } : {}),
      ...(body.id !== undefined ? { id: body.id } : {}),
    },
    {
      prepare: ({ now }) => {
        const needs = needsAt(db, access, body.needs, null)
        const waits = needs.ids.length > 0 && !needs.completed
        if (body.claim && waits) {
          throw taskConflict('task_waiting', `the task would wait for ${refList(needs.ids)}: nothing was made`)
        }
        if (body.claim && assigned !== null && assigned !== identity.actor.id) {
          throw taskConflict('task_assigned', `the task would be assigned to ${assigned}: nothing was made`)
        }
        const ready = needs.ids.length > 0 && !waits
        made.plan = { needs: needs.ids, ready, until: isoOf(now + leaseMs(body.lease)) }
        return { along: (1 + (ready ? 1 : 0) + (body.claim ? 1 : 0)) as 1 | 2 | 3 }
      },
      emit: (root) => {
        const p = made.plan!
        const events = startingEvents(root, identity, {
          needs: p.needs,
          ready: p.ready,
          assigned,
          claim: body.claim ? { secret, until: p.until } : null,
        })
        // The plan hooks see the root's events; the post counted them in `along`, so a hook keeps their number.
        const hooks = hooksOf(host)
        const planned = hooks.plan(host, { op: 'create', caller: identity, taskId: root.id, before: null, events })
        hooks.rootContext = { op: 'create', caller: identity }
        return planned
      },
      replay: (landed) => {
        // The root as the writer may have it back (original writes.ts:297-314 landedFor): a blind writer's
        // is what its own append made of it, the post and the task events that came with it, never what
        // others did since (another may have made its plain post a task, where it can't read). One that
        // reads gets the root as it is now.
        const shown = host.landedFor(caller, access, landed, landed.id + alongOf(host, landed.id))
        // A retry gets back the post that landed with its ID: one that was no task's is another write's (a2.ts:648-650).
        if (!shown?.task) throw duplicateId()
        made.shown = shown
        // The claim the root wears is this request's only if it was made with this request's secret (original tasks.ts:526-533).
        const row = loadRow(db, landed.id)
        if (body.claim && row && row.state === 'claimed' && eqHash(secret, row.claim_token_hash)) {
          made.replayed = { epoch: row.epoch, token: secret, until: isoUntil(row) }
        }
      },
    },
  )
  const claim = posted.replayed
    ? made.replayed
    : body.claim && made.plan
      ? { epoch: 1, token: secret, until: made.plan.until }
      : undefined
  // A retry answers the root as replay() judged it: as its own append left it for a blind writer.
  const task = posted.replayed ? made.shown! : posted.message
  return {
    task,
    ...(claim ? { claim } : {}),
    ...(posted.mentions !== undefined ? { mentions: posted.mentions } : {}),
  }
}

/**
 * Makes the thread rooted at `ref` a task, as it is: `label` in its channel, and the caller's
 * principal owns it. A reply names no task, and neither does a root that's gone (original tasks.ts:575-603).
 */
function adopt(host: TaskHost, caller: CallerContext, ref: string, body: CreateTaskInput): CreatedTask {
  const id = resolveMessageId(host.store.db, ref)
  if (id === 0) throw messageNotFound(ref)
  const { identity, access } = host.admit(caller)
  return host.tx(() => {
    const now = host.now()
    const msg = host.loadMessage(id)
    if (!msg || !access.readable(msg.channel)) throw messageNotFound(ref)
    authorize(access, 'label', msg.channel)
    const assigned = ownActor(identity.principal.id, body.for)
    if (msg.re !== null) throw badRequest(`#${id} is a reply: a task is a thread, so name its root, #${msg.re}`)
    if (msg.deleted) throw badRequest('message was deleted', 'message_deleted')
    if (msg.task) throw taskConflict('already_a_task', `#${id} is a task already`)
    const needs = needsAt(host.store.db, access, body.needs, id)
    const waits = needs.ids.length > 0 && !needs.completed
    if (body.claim && waits) {
      throw taskConflict('task_waiting', `#${id} would wait for ${refList(needs.ids)}: it wasn't made a task`)
    }
    if (body.claim && assigned !== null && assigned !== identity.actor.id) {
      throw taskConflict('task_assigned', `#${id} would be assigned to ${assigned}: it wasn't made a task`)
    }
    const secret = body.token ?? newToken()
    const until = isoOf(now + leaseMs(body.lease))
    const events = startingEvents(msg, identity, {
      needs: needs.ids,
      ready: needs.ids.length > 0 && !waits,
      assigned,
      claim: body.claim ? { secret, until } : null,
    })
    const hooks = hooksOf(host)
    const planned = hooks.plan(host, { op: 'adopt', caller: identity, taskId: id, before: null, events })
    if (planned.length > 0) {
      host.actorSeenInTx(identity)
      hooks.applied(host, 'adopt', identity, commitTaskEventsInTx(host, msg, null, planned))
    }
    return {
      task: host.view(msg, identity, access),
      ...(body.claim ? { claim: { epoch: 1, token: secret, until } } : {}),
    }
  })
}
