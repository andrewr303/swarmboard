// What every task verb shares (M2_DESIGN 2.7.2): parsing a body into the board's 400, the claim
// secret and its hash, the original's ACL predicates (owns, ownedBy, assignedTo, ownActor), the fence,
// and the transaction a verb on one task runs in.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ZodError, type z } from 'zod'
import type { Access, StoredMessage } from '../board-service.ts'
import { badRequest, BoardError, conflict, forbidden, normalizeError, notFound } from '../errors.ts'
import { LEASE_CAP_S, LEASE_DEFAULT_S, type MessageView, type Permission } from '../schemas.ts'
import { resolveMessageId } from '../social.ts'
import type { StoredEvent } from '../storage.ts'
import type { Identity, PlannedTaskEvent, TaskHost } from './host.ts'
import { hooksOf, type TaskOp } from './hooks.ts'
import { cloneRow, isoOf, loadRow, type TaskRow } from './row.ts'
import { commitTaskEventsInTx } from './tx.ts'

/** Parses a request body with a ported zod schema: a misshapen one is the board's 400, first issue only. */
export function parseBody<S extends z.ZodType>(schema: S, raw: unknown): z.infer<S> {
  try {
    return schema.parse(raw) as z.infer<S>
  } catch (error) {
    if (error instanceof ZodError) throw normalizeError(error)
    throw error
  }
}

/** 128 random bits, base64url: a claim's secret, which the board answers once and keeps only the hash of (original tasks.ts:70). */
export const newToken = (): string => randomBytes(16).toString('base64url')

/** sha256 hex of a claim's secret: what board_tasks and the task.claimed payload keep. */
export const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * Whether `token` is the secret `hash` was made from, compared without saying how much of it matched
 * (original tasks.ts:73). A missing or misshapen hash matches nothing.
 */
export function eqHash(token: string, hash: string | null): boolean {
  if (hash === null || !/^[0-9a-f]{64}$/.test(hash)) return false
  return timingSafeEqual(Buffer.from(hashOf(token), 'hex'), Buffer.from(hash, 'hex'))
}

/** A lease asked for in seconds, as this board gives it, in milliseconds (original tasks.ts:76). */
export const leaseMs = (seconds: number | undefined): number => Math.min(seconds ?? LEASE_DEFAULT_S, LEASE_CAP_S) * 1000

export const taskConflict = (code: string, message: string): BoardError => conflict(message, code)

export const messageNotFound = (ref: string | number): BoardError => notFound(`message not found: #${ref}`, 'message_not_found')

export const notATask = (id: number): BoardError => notFound(`#${id} isn't a task`, 'not_a_task')

/** `#a, #b`: how the original names a list of tasks. */
export const refList = (ids: readonly number[]): string => ids.map((id) => `#${id}`).join(', ')

/**
 * The log index a message ref names, or 0 (which names no message): only `0|[1-9]\d{0,15}` in
 * decimal (original feed.ts:115 indexOf, a2.ts:90-94 messageAt). A number is taken as it is.
 */
export function messageIndex(ref: string | number): number {
  if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : 0
  return /^(0|[1-9]\d{0,15})$/.test(ref) ? Number(ref) : 0
}

const PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => `read ${channel}`,
  post: (channel) => `post in ${channel}`,
  react: (channel) => `react in ${channel}`,
  label: (channel) => `label in ${channel}`,
  sync: (channel) => `sync in ${channel}`,
  manage: (channel) => `manage ${channel}`,
}

/** 403 unless `access` gives `permission` in `channel`, worded as the original's authorize (server/access.ts:438-446). */
export function authorize(access: Access, permission: Permission, channel: string): void {
  if (!access.can(permission, channel)) throw forbidden(`this token can't ${PHRASE[permission](channel)}`)
}

/** The profile part of an actor ID, as the board writes one (original tasks.ts:105). */
const PROFILE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * The actor a task is assigned to: one of its owner's (`<owner>+<profile>`), or null for anyone who
 * may claim it (original tasks.ts:112-117).
 */
export function ownActor(owner: string, actor: string | null | undefined): string | null {
  if (actor === undefined || actor === null) return null
  if (!actor.startsWith(`${owner}+`) || !PROFILE.test(actor.slice(owner.length + 1))) {
    throw badRequest(`for: a task is assigned to one of its owner's profiles, ${owner}+<profile>, got ${actor}`)
  }
  return actor
}

/**
 * Whether `identity` is a task's owner: the principal that made it a task, as itself, or as the
 * profile it made it as (original writes.ts:95 ownedBy, auth.ts:62 wroteAs).
 */
export const ownedBy = (row: Pick<TaskRow, 'owner' | 'by_actor'>, identity: Identity): boolean =>
  row.owner === identity.principal.id && (identity.actor.id === identity.principal.id || row.by_actor === identity.actor.id)

/**
 * Whether `identity` is who a task is assigned to: its owner's principal, writing as that actor. The
 * actor ID alone doesn't say whose it is (original tasks.ts:272).
 */
export const assignedTo = (row: Pick<TaskRow, 'for_actor' | 'owner'>, identity: Identity): boolean =>
  row.for_actor === identity.actor.id && row.owner === identity.principal.id

/**
 * Refuses an owner verb by anyone but `manage` in the task's channel, or its owner while it may still
 * write there (original tasks.ts:253-258). Always before any 409.
 */
export function owns(access: Access, identity: Identity, row: TaskRow): void {
  if (access.can('manage', row.channel)) return
  if (ownedBy(row, identity) && (access.can('post', row.channel) || access.can('label', row.channel))) return
  throw forbidden(
    `#${row.task_id} is someone else's task: its owner as itself, the profile that made it, or manage in ${row.channel}, changes it`,
    'task_not_owned',
  )
}

/** What a claim's own writes show: the `epoch` and `token` its claim answered. */
export type Proof = { epoch: number; token: string }

/**
 * Refuses a write whose claim is over: released, settled, held, taken over, or past its lease. It
 * never says who holds the task now (original tasks.ts:261-265).
 */
export function fenced(row: TaskRow, proof: Proof, now: number): void {
  const live =
    row.state === 'claimed' &&
    row.epoch === proof.epoch &&
    row.claim_until_ms !== null &&
    row.claim_until_ms > now &&
    eqHash(proof.token, row.claim_token_hash)
  if (!live) throw taskConflict('claim_lost', `this claim on #${row.task_id} is over: claim it again`)
}

/** `{id, thread}`: what every task event's payload starts with. */
export const about = (row: Pick<TaskRow, 'task_id' | 'thread'>): { id: number; thread: string } => ({
  id: row.task_id,
  thread: row.thread,
})

export const isoUntil = (row: TaskRow): string => isoOf(row.claim_until_ms ?? 0)

/** One verb's view of the task it acts on, inside its transaction. */
export type TaskScope = {
  readonly host: TaskHost
  readonly identity: Identity
  readonly access: Access
  /** host.now(), read once the write lock is held. */
  readonly now: number
  readonly msg: StoredMessage
  readonly row: TaskRow
}

/**
 * Runs `body` on task `ref` in one transaction (2.7.2 steps 2-5): the caller is admitted, the clock
 * read after the lock is taken, and a root that is missing or out of the caller's sight is 404
 * `message_not_found`, a readable one that is no task 404 `not_a_task`, before `body` sees it.
 */
export function onTask<R>(host: TaskHost, caller: Identity['caller'], ref: string | number, body: (scope: TaskScope) => R): R {
  const { identity, access } = host.admit(caller)
  return hooksOf(host).around(host, () => host.tx(() => {
    const now = host.now()
    const id = resolveMessageId(host.store.db, ref)
    const msg = id > 0 ? host.loadMessage(id) : null
    if (!msg || !access.readable(msg.channel)) throw messageNotFound(ref)
    if (!msg.task) throw notATask(id)
    const row = loadRow(host.store.db, id)
    if (!row) throw new BoardError(500, 'internal', `#${id} is a task with no index row: rebuild the task index`)
    return body({ host, identity, access, now, msg, row })
  }))
}

/**
 * Appends a verb's planned events (2.7.2 steps 8-10): the plan hooks rewrite or refuse them, `extend`
 * adds what follows from what remains (a completion's promotions, step 8a), then the single writer
 * appends them after the caller's actor record when it changed, and the applied hooks see the result.
 * Nothing at all when there is nothing to append, as the original writes no `actor.seen` for a no-op
 * (server/tasks.ts:225).
 */
export function commitVerb(
  scope: TaskScope,
  op: TaskOp,
  events: readonly PlannedTaskEvent[],
  extend?: (planned: readonly PlannedTaskEvent[]) => PlannedTaskEvent[],
): StoredEvent[] {
  const hooks = hooksOf(scope.host)
  let planned = hooks.plan(scope.host, {
    op,
    caller: scope.identity,
    taskId: scope.row.task_id,
    before: cloneRow(scope.row),
    events: [...events],
  })
  if (extend) planned = [...planned, ...extend(planned)]
  if (planned.length === 0) return []
  scope.host.actorSeenInTx(scope.identity)
  const appended = commitTaskEventsInTx(scope.host, scope.msg, scope.row, planned)
  hooks.applied(scope.host, op, scope.identity, appended)
  return appended
}

/** The task's root as the caller sees it, after the verb's writes. */
export const shown = (scope: TaskScope): MessageView => scope.host.view(scope.msg, scope.identity, scope.access)

/** How many events came with a post, as its `message.posted` at `index` says (0 when it says none). */
export const alongOf = (host: Pick<TaskHost, 'store'>, index: number): number => {
  const row = host.store.db.prepare('SELECT payload_json FROM board_events WHERE log_index = ?').get(index) as
    | { payload_json: string }
    | undefined
  const along = row ? (JSON.parse(row.payload_json) as { along?: unknown }).along : undefined
  return typeof along === 'number' ? along : 0
}
