// Claim the next ready task (M2_DESIGN 2.7.10), ported from the original's server/tasks.ts:441-486
// claimNext: the caller's own assigned tasks first, then the oldest unassigned one of an owner it takes
// tasks from, in the channels where it has `label`, with every label asked for on the root. Split
// LIMIT-1 probes on the partial indexes replace the original's walk in ID order (same pick while every
// priority is 0); a read-only probe runs before the write lock is taken, and again under it.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Access, CallerContext } from '../board-service.ts'
import { BoardError, badRequest, forbidden } from '../errors.ts'
import type { MessageView, TaskClaim } from '../schemas.ts'
import { ClaimReadyTaskBody, taskLimits } from './bodies.ts'
import { claimable, claiming } from './claim.ts'
import { authorize, commitVerb, newToken, parseBody, shown, type TaskScope } from './common.ts'
import type { Identity, TaskHost } from './host.ts'
import { hooksOf, type CandidateQuery } from './hooks.ts'
import { channelTerm } from './list.ts'
import { loadRow } from './row.ts'
import type { Waiter, WaiterHub } from './waiters.ts'

export type ClaimedNext = { task: null } | { task: MessageView; claim: TaskClaim }

export type ClaimReadyInput = ReturnType<typeof ClaimReadyTaskBody.parse>

/**
 * Whether `value` is shaped like an ID, `<where it's from>:<who>`, as every principal's is. What it
 * names is a credential's to say, never a client's (original tasks.ts:89).
 */
const isId = (value: string): boolean => /^[^\s:]+:\S+$/.test(value)

/** A claim-next request, parsed and held to this board's limits: 400s before anything is read. */
export function parseClaimReady(raw: unknown): ClaimReadyInput {
  const body = parseBody(ClaimReadyTaskBody, raw)
  taskLimits.lease(body.lease)
  taskLimits.from(body.from)
  return body
}

/**
 * What the probes look for, for `identity` (original tasks.ts:458-469): 403 without `label` in the
 * channel (or anywhere, for a subtree), null when `label` reaches nothing there, then 400
 * `invalid_from` for an owner named by a handle (decision 18).
 */
export function candidateQuery(host: TaskHost, identity: Identity, access: Access, body: ClaimReadyInput): CandidateQuery | null {
  const subtree = body.channel.endsWith('/')
  const path = subtree ? body.channel.slice(0, -1) : body.channel
  // A claim changes a task's state, which is what `label` gives: where the caller has none, there's nothing it claims.
  if (!subtree) authorize(access, 'label', path)
  else if (!access.anywhere('label')) throw forbidden("this token can't label anywhere, so it can't claim a task")
  let scope: CandidateQuery['scope']
  if (access.everywhere('label')) scope = { path, subtree }
  else {
    const channels = host.channelsWhere(access, 'label', { path, subtree })
    if (channels !== 'all' && channels.length === 0) return null
    scope = channels === 'all' ? { path, subtree } : { channels }
  }
  // Whose tasks it takes: its own, and those of the owners it names, by ID only.
  const owners = new Set([identity.principal.id])
  for (const value of body.from ?? []) {
    if (!isId(value)) throw badRequest(`from: ${value} is a handle, which several can share: name the owner by ID`, 'invalid_from')
    owners.add(value)
  }
  const q: CandidateQuery = {
    actor: identity.actor.id,
    principal: identity.principal.id,
    scope,
    labels: Object.entries(body.label ?? {}),
    owners: [...owners],
    where: [],
  }
  return hooksOf(host).candidates(q)
}

/** What makes two waits interchangeable: the same probe. */
export const scopeKey = (q: CandidateQuery): string =>
  JSON.stringify([q.actor, q.principal, q.scope, q.labels, q.owners, q.where.map((w) => [w.sql, w.params])])

/** The WHERE terms every probe of `q` shares: scope, root labels, the hooks' terms. */
function shared(q: CandidateQuery): { sql: string; params: SQLInputValue[] } {
  const terms: string[] = ['root_deleted = 0']
  const params: SQLInputValue[] = []
  if ('channels' in q.scope) {
    terms.push('channel IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(q.scope.channels))
  } else terms.push(channelTerm('channel', q.scope.path, q.scope.subtree, params))
  for (const [key, value] of q.labels) {
    terms.push('EXISTS (SELECT 1 FROM board_terms l WHERE l.message_id = board_tasks.task_id AND l.term = ? AND l.value = ?)')
    params.push(key, value)
  }
  for (const term of q.where) {
    terms.push(`(${term.sql})`)
    params.push(...term.params)
  }
  return { sql: terms.join(' AND '), params }
}

type Hit = { task_id: number; priority: number }

/** Smallest (-priority, task_id) of the hits. */
const best = (hits: readonly (Hit | undefined)[]): Hit | null => {
  let out: Hit | null = null
  for (const h of hits) {
    if (!h) continue
    if (!out || h.priority > out.priority || (h.priority === out.priority && h.task_id < out.task_id)) out = h
  }
  return out
}

/**
 * The task a claim next would take now, or null (2.7.10 probe). Mine first, absolutely: a task assigned
 * to the caller, ready or with a lapsed claim; then the pool, one LIMIT-1 probe per owner on the
 * partial index, and one for lapsed claims of those owners.
 */
export function probe(db: DatabaseSync, q: CandidateQuery, now: number): number | null {
  const { sql, params } = shared(q)
  const one = (text: string, ...args: SQLInputValue[]): Hit | undefined => {
    const row = db.prepare(text).get(...args) as { task_id: number; priority: number } | undefined
    return row ? { task_id: Number(row.task_id), priority: Number(row.priority) } : undefined
  }
  const mine = best([
    one(
      `SELECT task_id, priority FROM board_tasks INDEXED BY board_tasks_mine
       WHERE state = 'ready' AND for_actor = ? AND owner = ? AND ${sql} ORDER BY priority DESC, task_id LIMIT 1`,
      q.actor,
      q.principal,
      ...params,
    ),
    one(
      `SELECT task_id, priority FROM board_tasks
       WHERE state = 'claimed' AND claim_until_ms <= ? AND for_actor = ? AND owner = ? AND ${sql} ORDER BY priority DESC, task_id LIMIT 1`,
      now,
      q.actor,
      q.principal,
      ...params,
    ),
  ])
  if (mine) return mine.task_id
  const pool = q.owners.map((owner) =>
    one(
      `SELECT task_id, priority FROM board_tasks INDEXED BY board_tasks_pool
       WHERE state = 'ready' AND for_actor IS NULL AND owner = ? AND ${sql} ORDER BY priority DESC, task_id LIMIT 1`,
      owner,
      ...params,
    ),
  )
  pool.push(
    one(
      `SELECT task_id, priority FROM board_tasks
       WHERE state = 'claimed' AND claim_until_ms <= ? AND for_actor IS NULL AND owner IN (SELECT value FROM json_each(?)) AND ${sql}
       ORDER BY priority DESC, task_id LIMIT 1`,
      now,
      JSON.stringify(q.owners),
      ...params,
    ),
  )
  return best(pool)?.task_id ?? null
}

/** When the next live claim in `q`'s scope runs out, in the host's clock: a lapse writes no event to wake on. */
export function nextLapseMs(db: DatabaseSync, q: CandidateQuery, now: number): number | null {
  const { sql, params } = shared(q)
  const row = db
    .prepare(`SELECT MIN(claim_until_ms) AS due FROM board_tasks WHERE state = 'claimed' AND claim_until_ms > ? AND ${sql}`)
    .get(now, ...params) as { due: number | null } | undefined
  return row?.due === null || row?.due === undefined ? null : Number(row.due)
}

/**
 * One claim-next attempt for an admitted caller, with `q` built from that same admission (2.7.10): a
 * read-only probe outside the write lock, and only when it finds a candidate, the write: the probe
 * again under the lock, and the claim of 2.7.5 from `claimable` on. The transaction re-checks the
 * grants `access` was judged by, so a revoke that lands between the admission and the lock is a 503.
 * An aborted caller takes nothing (original tasks.ts:476).
 */
export function attemptClaim(
  host: TaskHost,
  identity: Identity,
  access: Access,
  body: ClaimReadyInput,
  q: CandidateQuery,
  signal?: AbortSignal,
): ClaimedNext {
  const db = host.store.db
  if (signal?.aborted) return { task: null }
  if (probe(db, q, host.now()) === null) return { task: null }
  return hooksOf(host).around(host, () =>
    host.tx((): ClaimedNext => {
      const now = host.now()
      const id = probe(db, q, now)
      if (id === null || signal?.aborted) return { task: null }
      const msg = host.loadMessage(id)
      const row = loadRow(db, id)
      if (!msg || !row) return { task: null }
      // The probe's scope came from this admission; the pick is held to `label` there once more.
      if (!access.can('label', msg.channel)) return { task: null }
      const scope: TaskScope = { host, identity, access, now, msg, row }
      claimable(row, identity, now)
      const { events, claim } = claiming(row, identity, body.lease, body.token ?? newToken(), now)
      commitVerb(scope, 'claimReady', events)
      return { task: shown(scope), claim }
    }),
  )
}

/**
 * One whole claim-next try, gates included (2.7.10 claimReadyOnce after parsing): the caller is
 * admitted afresh, its `label` judged and its scope worked out from the grants it holds now, so a
 * waiter that lost a grant while it waited is refused (403) or looks only where it may still label,
 * and one that gained a channel looks there too. Answers the query it used, or null for an empty scope.
 */
function tryOnce(host: TaskHost, caller: CallerContext, body: ClaimReadyInput, signal?: AbortSignal): { q: CandidateQuery | null; got: ClaimedNext } {
  const { identity, access } = host.admit(caller)
  const q = candidateQuery(host, identity, access, body)
  if (!q) return { q, got: { task: null } }
  return { q, got: attemptClaim(host, identity, access, body, q, signal) }
}

/** POST /tasks/claim, one attempt, no wait. */
export function claimReadyOnce(host: TaskHost, caller: CallerContext, raw: unknown, signal?: AbortSignal): ClaimedNext {
  return tryOnce(host, caller, parseClaimReady(raw), signal).got
}

/** The longest one claim next waits, in seconds (original api/routes.ts ClaimReadyTaskBody `wait`). */
const WAIT_MAX_S = 300
/** The original's poll backoff: 100 ms, doubling to 1 s (server/tasks.ts:684-695). */
const POLL_FIRST_MS = 100
const POLL_MAX_MS = 1000
/** Transient SQLITE_BUSY / SQLITE_LOCKED retry backoff during a wait (full jitter, 5..100 ms). */
const BUSY_BASE_MS = 5
const BUSY_CAP_MS = 100

/** Whether `error` is a transient SQLite lock refusal (SQLITE_BUSY / SQLITE_LOCKED, raw or retryable 503). */
function isTransientBusy(error: unknown): boolean {
  if (error instanceof BoardError) {
    return error.status === 503 && error.code === 'unavailable' && error.retryAfter !== undefined
  }
  const e = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown } | null
  if (e?.code !== 'ERR_SQLITE_ERROR') return false
  if (typeof e.errcode === 'number') {
    const primary = e.errcode & 0xff
    return primary === 5 || primary === 6
  }
  const text = typeof e.errstr === 'string' ? e.errstr : typeof e.message === 'string' ? e.message : ''
  return /database (?:table )?is locked/i.test(text)
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits `ms`, or until `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<'timer' | 'abort'> {
  if (signal?.aborted) return Promise.resolve('abort')
  return new Promise((resolve) => {
    const finish = (why: 'timer' | 'abort'): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(why)
    }
    const onAbort = (): void => finish('abort')
    const timer = setTimeout(() => finish('timer'), Math.max(0, ms))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * POST /tasks/claim with `wait` (2.7.10): one attempt; then, until the wait is over, an attempt each
 * time the hub gives this waiter its scope's turn, a claim in scope lapses, or its safety poll comes
 * round (the original's 100 ms to 1 s backoff, or `armedPollMs` once a cross-process wake source is
 * armed). Only the oldest waiter of a scope attempts; the write lock is never held while it waits.
 * Transient SQLITE_BUSY / SQLITE_LOCKED during a wait retries with bounded jittered backoff within
 * the remaining deadline (honoring `signal` abort); non-busy and closed-store errors propagate immediately.
 */
export async function claimReady(
  host: TaskHost,
  hub: WaiterHub,
  poll: { armed: boolean; armedPollMs: number },
  caller: CallerContext,
  raw: unknown,
  signal?: AbortSignal,
): Promise<ClaimedNext> {
  const body = parseClaimReady(raw)
  const wait = Math.min(body.wait ?? 0, WAIT_MAX_S) * 1000
  let q: CandidateQuery | null = null
  let got: ClaimedNext = { task: null }
  let busyBackoff = 0
  try {
    ;({ q, got } = tryOnce(host, caller, body, signal))
    if (got.task || wait === 0) return got
  } catch (error) {
    if (wait === 0 || !isTransientBusy(error)) throw error
    busyBackoff = BUSY_BASE_MS
  }
  const deadline = Date.now() + wait
  const db = host.store.db
  // The hub queue this waiter stands in: its scope's, which follows the caller's grants from try to
  // try. With no scope at all (no channel it may label there yet), it stands in none and just polls.
  let waiter: Waiter | null = null
  const follow = (now: CandidateQuery | null): void => {
    const key = now ? scopeKey(now) : null
    if (waiter && waiter.key === key) return
    if (waiter) hub.done(waiter)
    waiter = now ? hub.register(key!, () => probe(db, now, host.now()) !== null) : null
  }
  const nextBusyBackoff = (cur: number): number => (cur === 0 ? BUSY_BASE_MS : Math.min(cur * 2, BUSY_CAP_MS))
  try {
    let step = POLL_FIRST_MS
    for (;;) {
      if (signal?.aborted) return { task: null }
      const left = deadline - Date.now()
      if (left <= 0) return { task: null }
      follow(q)
      const current: Waiter | null = waiter
      let why: 'turn' | 'timer' | 'abort'
      if (busyBackoff > 0) {
        const delay = Math.min(left, Math.max(1, Math.floor(Math.random() * busyBackoff)))
        why = await sleep(delay, signal)
      } else if (current && q) {
        let lapse: number | null
        const now = host.now()
        try {
          lapse = nextLapseMs(db, q, now)
        } catch (error) {
          if (!isTransientBusy(error)) throw error
          busyBackoff = nextBusyBackoff(busyBackoff)
          continue
        }
        why = await hub.wait(current, Math.min(left, step, lapse === null ? Number.POSITIVE_INFINITY : lapse - now), signal)
        step = poll.armed ? poll.armedPollMs : Math.min(step * 2, POLL_MAX_MS)
      } else {
        why = await sleep(Math.min(left, step), signal)
        step = poll.armed ? poll.armedPollMs : Math.min(step * 2, POLL_MAX_MS)
      }
      if (why === 'abort' || signal?.aborted) return { task: null }
      // Herd control: of the waiters on one scope, only the oldest looks. The others still have
      // their gates judged again, so a revoke refuses them too and their queue follows their scope.
      if (current && !hub.isHead(current)) {
        try {
          const { identity, access } = host.admit(caller)
          q = candidateQuery(host, identity, access, body)
          busyBackoff = 0
        } catch (error) {
          if (!isTransientBusy(error)) throw error
          busyBackoff = nextBusyBackoff(busyBackoff)
        }
        continue
      }
      if (busyBackoff === 0) await pause(Math.random() * 5)
      if (signal?.aborted) return { task: null }
      try {
        ;({ q, got } = tryOnce(host, caller, body, signal))
        busyBackoff = 0
      } catch (error) {
        if (!isTransientBusy(error)) throw error
        busyBackoff = nextBusyBackoff(busyBackoff)
        continue
      }
      if (got.task) return got
    }
  } finally {
    const last: Waiter | null = waiter
    if (last) hub.done(last)
  }
}
