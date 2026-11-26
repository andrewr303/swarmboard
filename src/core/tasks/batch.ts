// Batch create and lookup (M2_DESIGN 2.7.4): several new threads in one channel, each a task, all of
// them or none, in one transaction. Ported from the original's a2.ts:654-686 createTasks and
// createdTasks, server/tasks.ts:532-571 startingMany and server/writes.ts:441-534 writeRoots and
// landedBatch; the retry lookup runs inside the write (decision 14).
import type { CallerContext, Mentioned, StoredMessage, Access } from '../board-service.ts'
import { badRequest, batchTooLarge, BoardError, duplicateId, notFound, textTooLong } from '../errors.ts'
import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  MESSAGE_TEXT_MAX,
  RESERVED_LABEL_PREFIX,
  TASK_BATCH_MAX,
  type MessageView,
} from '../schemas.ts'
import { CreatedTasksQuery, CreateTasksBody, taskLimits, type CreateTasksInput } from './bodies.ts'
import { alongOf, authorize, ownActor, parseBody } from './common.ts'
import type { PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf } from './hooks.ts'
import { batchAskedId, batchDigest, batchPlan, batchRootId } from './ids.ts'
import { namedNeeds, needsAmong } from './needs.ts'

export type CreatedTasks = { tasks: MessageView[]; mentions?: Mentioned[] }

/** Worded as M1's post refusal of a `board.*` label (original serve.ts:86-91 ownLabels). */
const reservedLabel = (key: string): BoardError =>
  badRequest(`${key} is the board's own label: only its task writes set labels under ${RESERVED_LABEL_PREFIX}`, 'reserved_label')

/** A batch made under an `id`, found again: its roots as the caller may have them, or why there are none. */
type Landed = { tasks: MessageView[] } | { not: 'made' | 'yours' | 'asked' }

const postedBy = (host: TaskHost, eventId: string): StoredMessage | null => {
  const row = host.store.db.prepare('SELECT id FROM board_messages WHERE event_id = ?').get(eventId) as { id: number } | undefined
  return row ? host.loadMessage(Number(row.id)) : null
}

const eventIdAt = (host: TaskHost, index: number): string | null =>
  (host.store.db.prepare('SELECT event_id FROM board_events WHERE log_index = ?').get(index) as { event_id: string } | undefined)?.event_id ??
  null

/**
 * The batch `identity` made under `id` (original writes.ts:520-534 landedBatch): each root posted with
 * derivedId('board-batch', id, i), in turn, as the caller may have it back, and, when `asked` is
 * given, the event right after the first root must carry it.
 */
function landedBatch(host: TaskHost, caller: CallerContext, access: Access, id: string, asked: string | undefined): Landed {
  const first = postedBy(host, batchRootId(id, 0))
  if (!first) return { not: 'made' }
  const tasks: MessageView[] = []
  for (let at = 0, landed: StoredMessage | null = first; landed; landed = postedBy(host, batchRootId(id, ++at))) {
    // A blind writer gets its root back as its own append left it: the post and what came with it.
    const mine = host.landedFor(caller, access, landed, landed.id + alongOf(host, landed.id))
    if (!mine) return { not: 'yours' }
    tasks.push(mine)
  }
  if (asked !== undefined && eventIdAt(host, first.id + 1) !== asked) return { not: 'asked' }
  return { tasks }
}

/** POST /tasks/batch: 201. 1..100 tasks, all or none. */
export function createTasks(host: TaskHost, caller: CallerContext, raw: unknown): CreatedTasks {
  // More than any board makes is said so before anything else, whatever else is wrong with it (original serve.ts:174-180).
  const sent = (raw as { tasks?: unknown } | null | undefined)?.tasks
  if (Array.isArray(sent) && sent.length > TASK_BATCH_MAX) throw batchTooLarge(sent.length, TASK_BATCH_MAX)
  const body = parseBody(CreateTasksBody, raw)
  for (const task of body.tasks) {
    for (const key of Object.keys(task.labels ?? {})) if (key.startsWith(RESERVED_LABEL_PREFIX)) throw reservedLabel(key)
  }
  const hooks = hooksOf(host)
  try {
    return hooks.around(host, () => writeBatch(host, caller, body))
  } catch (error) {
    // Two first batches with one id: under BEGIN IMMEDIATE the second finds the first's roots, so this
    // is only a backstop for a loser at the UNIQUE event_id (original writes.ts:398-402).
    if (body.id !== undefined && error instanceof BoardError && error.code === 'duplicate_id' && error.message.startsWith('duplicate event id:')) {
      return hooks.around(host, () => writeBatch(host, caller, body))
    }
    throw error
  }
}

/** This board's own limits on a batch, and on each task's root as on any message (original a2.ts:656-660). */
function batchLimits(tasks: CreateTasksInput['tasks']): void {
  taskLimits.batch(tasks)
  for (const [at, task] of tasks.entries()) {
    if (task.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    if ((task.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) {
      throw badRequest(`tasks.${at}.attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
    }
  }
}

function writeBatch(host: TaskHost, caller: CallerContext, body: CreateTasksInput): CreatedTasks {
  const { identity, access } = host.admit(caller)
  const { channel, tasks } = body
  // What the request asked for, as it was given: an `id` again is this batch only for the same one.
  const asked = body.id !== undefined ? batchAskedId(body.id, body.request ?? batchDigest(channel, tasks)) : undefined
  return host.tx(() => {
    // A batch under an `id` that landed stands: the same request again gets its tasks, whatever this
    // board's grants, limits and checks would make of it now, and another request under the `id` is
    // refused. Both are answered before anything else is judged (original serve.ts:982-994 createdTasks,
    // a2.ts:679-686), inside the write, so a retry and the same batch sent at once meet here.
    let theirs = false
    if (body.id !== undefined) {
      const found = landedBatch(host, caller, access, body.id, asked)
      if ('tasks' in found) return { tasks: found.tasks }
      if (found.not === 'asked') throw duplicateId()
      // Someone else's batch is none of the caller's: its request goes through every check, then is another write's.
      theirs = found.not === 'yours'
    }
    batchLimits(tasks)
    // New threads, posted as any are: `post` where they land, and `label` when any carries labels.
    authorize(access, 'post', channel)
    if (tasks.some((task) => Object.keys(task.labels ?? {}).length > 0)) authorize(access, 'label', channel)
    if (body.id !== undefined) host.checkOwnId(identity.principal.id, body.id)
    // Refused before anything is read: an assignee that isn't its owner's, and how the tasks wait for each other.
    const assigned = tasks.map((task) => ownActor(identity.principal.id, task.for))
    const plan = batchPlan(tasks)
    if ('problem' in plan) throw badRequest(`needs: ${plan.problem}`, 'invalid_needs')
    const { inside } = plan
    const db = host.store.db
    const named = tasks.map((task) => namedNeeds(db, task.needs?.filter((need): need is string => typeof need === 'string'), null))
    // The roots it would post are another's (original writes.ts:453-455 writeRoots).
    if (theirs) throw duplicateId()
    // What the batch waits for that was there, read in the write, task by task.
    const needs = named.map((refs) => needsAmong(db, access, refs))
    const readied = needs.map(({ ids, completed }, at) => ids.length > 0 && completed && inside[at]!.length === 0)
    const counts = readied.map((ready) => (ready ? 2 : 1))
    const rootIds: number[] = []
    // A task may wait for one of the batch that comes after it: its ID is where that one's post lands,
    // which the counts say, and is checked once it has landed.
    const predicted: { at: number; id: number }[] = []
    const views: MessageView[] = []
    const mentions: Mentioned[] = []
    for (const [at, task] of tasks.entries()) {
      const posted = host.postRoot(
        caller,
        {
          channel,
          text: task.text,
          ...(task.labels !== undefined ? { labels: task.labels } : {}),
          ...(task.noSync !== undefined ? { noSync: task.noSync } : {}),
          ...(task.attachments !== undefined ? { attachments: task.attachments } : {}),
        },
        {
          ...(body.id !== undefined ? { eventId: batchRootId(body.id, at) } : {}),
          prepare: () => ({ along: counts[at] as 1 | 2 }),
          emit: (root) => {
            rootIds[at] = root.id
            const ahead = (other: number): number => {
              let id = root.id
              for (let k = at; k < other; k++) id += 1 + counts[k]!
              predicted.push({ at: other, id })
              return id
            }
            const waitsFor = [...needs[at]!.ids, ...inside[at]!.map((other) => (other < at ? rootIds[other]! : ahead(other)))]
            const about = { id: root.id, thread: root.thread }
            const events: PlannedTaskEvent[] = [
              { type: 'task.created', taskId: root.id, payload: { ...about, needs: waitsFor, for: assigned[at]!, by: identity.author } },
            ]
            if (readied[at]) events.push({ type: 'task.ready', taskId: root.id, payload: about })
            const hooks = hooksOf(host)
            const planned = hooks.plan(host, { op: 'batch', caller: identity, taskId: root.id, before: null, events })
            // The event right after the first root says what the batch was asked for, by its ID.
            if (at === 0 && asked !== undefined && planned[0]) planned[0] = { ...planned[0], eventId: asked }
            hooks.rootContext = { op: 'batch', caller: identity }
            return planned
          },
          replay: () => {
            throw new BoardError(500, 'internal', "a batch's root carries no client id, so it has nothing to replay")
          },
        },
      )
      views.push(posted.message)
      // One handle is said once, however many of the batch's tasks typed it.
      for (const mention of posted.mentions ?? []) if (!mentions.some((said) => said.written === mention.written)) mentions.push(mention)
    }
    for (const { at, id } of predicted) {
      if (rootIds[at] !== id) {
        throw new BoardError(500, 'internal', `a batch's root #${at} landed at #${rootIds[at]}, not #${id} as its tasks were told`)
      }
    }
    return mentions.length > 0 ? { tasks: views, mentions } : { tasks: views }
  })
}

/** GET /tasks/batch/:id?request=: 200 | 404 batch_not_found | 409 duplicate_id. */
export function getBatch(host: TaskHost, caller: CallerContext, id: string, raw: unknown): { tasks: MessageView[] } {
  const query = parseBody(CreatedTasksQuery, raw ?? {})
  const { access } = host.admit(caller)
  const found = landedBatch(host, caller, access, id, query.request !== undefined ? batchAskedId(id, query.request) : undefined)
  if ('tasks' in found) return found
  // Someone else's batch is none of the caller's, as a post is. Its own, made for another request, is another write's.
  if (found.not === 'asked') throw duplicateId()
  throw notFound(`no batch of yours has id ${id}`, 'batch_not_found')
}

